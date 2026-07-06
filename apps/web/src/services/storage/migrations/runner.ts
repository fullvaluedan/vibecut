import {
	IndexedDBAdapter,
	deleteDatabase,
} from "@/services/storage/indexeddb-adapter";
import type { StorageMigration } from "./base";
import type { ProjectRecord } from "./transformers/types";
import { getProjectId, isRecord } from "./transformers/utils";

export interface StorageMigrationResult {
	migratedCount: number;
	/** Projects whose migration chain threw. Their stored data is UNTOUCHED
	 * (the original is only overwritten after the whole chain succeeds) and a
	 * pre-migration backup exists. */
	failedProjects: {
		projectId: string;
		projectName: string | null;
		error: string;
	}[];
}

export interface MigrationProgress {
	isMigrating: boolean;
	fromVersion: number | null;
	toVersion: number | null;
	projectName: string | null;
}

/** The last pre-migration snapshot of a project, kept so a buggy migration
 * (one that succeeds but writes broken data) is recoverable. One per project,
 * refreshed each time a migration chain starts for it. */
export interface ProjectBackupRecord {
	id: string;
	backedUpAt: number;
	fromVersion: number;
	project: ProjectRecord;
}

/** Minimal adapter surface the runner needs — lets tests inject in-memory
 * fakes (bun has no IndexedDB). */
export interface MigrationStore<T> {
	getAll(): Promise<T[]>;
	get(key: string): Promise<T | null>;
	set(args: { key: string; value: T }): Promise<void>;
}

let hasCleanedUpMetaDb = false;

const MIN_MIGRATION_DISPLAY_MS = 1000;

const PROJECTS_DB = {
	dbName: "video-editor-projects",
	storeName: "projects",
	version: 1,
} as const;

const BACKUPS_DB = {
	dbName: "video-editor-project-backups",
	storeName: "backups",
	version: 1,
} as const;

function defaultProjectsAdapter(): MigrationStore<ProjectRecord> {
	return new IndexedDBAdapter<ProjectRecord>(PROJECTS_DB);
}

function defaultBackupsAdapter(): MigrationStore<ProjectBackupRecord> {
	return new IndexedDBAdapter<ProjectBackupRecord>(BACKUPS_DB);
}

export async function runStorageMigrations({
	migrations,
	onProgress,
	projectsStore,
	backupsStore,
}: {
	migrations: StorageMigration[];
	onProgress?: (progress: MigrationProgress) => void;
	/** Test seams; production uses the real IndexedDB stores. */
	projectsStore?: MigrationStore<ProjectRecord>;
	backupsStore?: MigrationStore<ProjectBackupRecord>;
}): Promise<StorageMigrationResult> {
	// One-time cleanup: delete the old global version database
	if (!hasCleanedUpMetaDb) {
		try {
			await deleteDatabase({ dbName: "video-editor-meta" });
		} catch {
			// Ignore errors - DB might not exist
		}
		hasCleanedUpMetaDb = true;
	}

	const projectsAdapter = projectsStore ?? defaultProjectsAdapter();
	const backupsAdapter = backupsStore ?? defaultBackupsAdapter();

	const projects = await projectsAdapter.getAll();

	const orderedMigrations = [...migrations].sort((a, b) => a.from - b.from);
	let migratedCount = 0;
	let migrationStartTime: number | null = null;
	const failedProjects: StorageMigrationResult["failedProjects"] = [];

	for (const project of projects) {
		if (typeof project !== "object" || project === null) {
			continue;
		}

		let projectRecord = project as ProjectRecord;
		const projectId = getProjectId({ project: projectRecord });
		if (!projectId) {
			continue;
		}

		let currentVersion = getProjectVersion({ project: projectRecord });
		const targetVersion = orderedMigrations.at(-1)?.to ?? currentVersion;

		if (currentVersion >= targetVersion) {
			continue;
		}

		// Track when we first showed the migration dialog
		if (migrationStartTime === null) {
			migrationStartTime = Date.now();
		}

		const projectName = getProjectName({ project: projectRecord });
		onProgress?.({
			isMigrating: true,
			fromVersion: currentVersion,
			toVersion: targetVersion,
			projectName,
		});

		try {
			// Snapshot the ORIGINAL before any transformation touches it, so a
			// migration that succeeds-but-corrupts is still recoverable.
			await backupsAdapter.set({
				key: projectId,
				value: {
					id: projectId,
					backedUpAt: Date.now(),
					fromVersion: currentVersion,
					project: structuredClone(projectRecord),
				},
			});

			// Run the WHOLE chain in memory and write once at the end. A crash
			// mid-chain (or a throwing migration) leaves the stored project
			// exactly as it was — never a half-migrated intermediate.
			let working = projectRecord;
			let workingVersion = currentVersion;
			let stepsApplied = 0;
			for (const migration of orderedMigrations) {
				if (migration.from !== workingVersion) {
					continue;
				}

				const result = await migration.run({
					projectId,
					project: working,
				});

				if (result.skipped) {
					break;
				}

				working = result.project;
				workingVersion = migration.to;
				stepsApplied++;
			}

			if (stepsApplied > 0) {
				await projectsAdapter.set({ key: projectId, value: working });
				migratedCount += stepsApplied;
				projectRecord = working;
				currentVersion = workingVersion;
			}
		} catch (e) {
			// This project stays on its pre-migration data; keep going so one
			// bad project can't boot-block every other project.
			failedProjects.push({
				projectId,
				projectName,
				error: e instanceof Error ? e.message : String(e),
			});
			console.error(
				`[migrations] project "${projectName ?? projectId}" failed to migrate; its data is untouched`,
				e,
			);
		}
	}

	// Ensure dialog is visible for minimum time so users can see it
	if (migrationStartTime !== null) {
		const elapsed = Date.now() - migrationStartTime;
		if (elapsed < MIN_MIGRATION_DISPLAY_MS) {
			await new Promise((resolve) =>
				setTimeout(resolve, MIN_MIGRATION_DISPLAY_MS - elapsed),
			);
		}
	}

	onProgress?.({
		isMigrating: false,
		fromVersion: null,
		toVersion: null,
		projectName: null,
	});

	return { migratedCount, failedProjects };
}

/** The stored pre-migration snapshot for a project, if any. */
export async function getProjectBackup({
	projectId,
	backupsStore,
}: {
	projectId: string;
	backupsStore?: MigrationStore<ProjectBackupRecord>;
}): Promise<ProjectBackupRecord | null> {
	const backupsAdapter = backupsStore ?? defaultBackupsAdapter();
	return backupsAdapter.get(projectId);
}

/** Overwrite a project with its pre-migration snapshot. Returns false when no
 * backup exists. The "restore last known-good" escape hatch for a migration
 * that succeeded but produced broken data. */
export async function restoreProjectBackup({
	projectId,
	projectsStore,
	backupsStore,
}: {
	projectId: string;
	projectsStore?: MigrationStore<ProjectRecord>;
	backupsStore?: MigrationStore<ProjectBackupRecord>;
}): Promise<boolean> {
	const backupsAdapter = backupsStore ?? defaultBackupsAdapter();
	const projectsAdapter = projectsStore ?? defaultProjectsAdapter();
	const backup = await backupsAdapter.get(projectId);
	if (!backup) {
		return false;
	}
	await projectsAdapter.set({ key: projectId, value: backup.project });
	return true;
}

function getProjectVersion({ project }: { project: ProjectRecord }): number {
	const versionValue = project.version;

	// v2 and up - has explicit version field
	if (typeof versionValue === "number") {
		return versionValue;
	}

	// v1 - has scenes array
	const scenesValue = project.scenes;
	if (Array.isArray(scenesValue) && scenesValue.length > 0) {
		return 1;
	}

	// v0 - no scenes
	return 0;
}

function getProjectName({
	project,
}: {
	project: ProjectRecord;
}): string | null {
	const metadata = project.metadata;
	if (isRecord(metadata) && typeof metadata.name === "string") {
		return metadata.name;
	}

	// v0 had name directly on project
	if (typeof project.name === "string") {
		return project.name;
	}

	return null;
}
