import { describe, expect, test } from "bun:test";
import {
	getProjectBackup,
	restoreProjectBackup,
	runStorageMigrations,
	type MigrationStore,
	type ProjectBackupRecord,
} from "../runner";
import { StorageMigration } from "../base";
import type { MigrationResult, ProjectRecord } from "../transformers/types";

/**
 * The P0.2 atomicity contract: a project is written ONCE, after its whole
 * chain succeeds; a throwing migration leaves the stored record untouched
 * (with a pre-migration backup) and never boot-blocks other projects.
 */

function memStore<T>(
	initial: Record<string, T> = {},
): MigrationStore<T> & { data: Map<string, T>; writes: number } {
	const data = new Map(Object.entries(initial));
	const store = {
		data,
		writes: 0,
		async getAll() {
			return [...data.values()];
		},
		async get(key: string) {
			return data.get(key) ?? null;
		},
		async set({ key, value }: { key: string; value: T }) {
			store.writes++;
			data.set(key, value);
		},
	};
	return store;
}

class FakeMigration extends StorageMigration {
	constructor(
		public from: number,
		public to: number,
		private transform?: (project: ProjectRecord) => ProjectRecord,
	) {
		super();
	}

	async run({
		project,
	}: {
		projectId: string;
		project: ProjectRecord;
	}): Promise<MigrationResult<ProjectRecord>> {
		const next = this.transform
			? this.transform(project)
			: { ...project, version: this.to };
		return { skipped: false, project: next };
	}
}

class ThrowingMigration extends StorageMigration {
	constructor(
		public from: number,
		public to: number,
	) {
		super();
	}

	async run(): Promise<MigrationResult<ProjectRecord>> {
		throw new Error("simulated migration crash");
	}
}

function project(id: string, version: number): ProjectRecord {
	return {
		id,
		version,
		metadata: { name: `Project ${id}` },
	} as unknown as ProjectRecord;
}

describe("runStorageMigrations (atomic per project)", () => {
	test("runs the whole chain in memory and writes the project ONCE", async () => {
		const projects = memStore<ProjectRecord>({ p1: project("p1", 1) });
		const backups = memStore<ProjectBackupRecord>();

		const result = await runStorageMigrations({
			migrations: [new FakeMigration(1, 2), new FakeMigration(2, 3)],
			projectsStore: projects,
			backupsStore: backups,
		});

		expect(result.migratedCount).toBe(2);
		expect(result.failedProjects).toEqual([]);
		expect(projects.writes).toBe(1);
		expect((projects.data.get("p1") as { version: number }).version).toBe(3);
	});

	test("a throwing step leaves the stored project untouched and reports it", async () => {
		const original = project("p1", 1);
		const projects = memStore<ProjectRecord>({ p1: original });
		const backups = memStore<ProjectBackupRecord>();

		const result = await runStorageMigrations({
			migrations: [new FakeMigration(1, 2), new ThrowingMigration(2, 3)],
			projectsStore: projects,
			backupsStore: backups,
		});

		// Stored record is the pre-migration original — v2 was never persisted.
		expect((projects.data.get("p1") as { version: number }).version).toBe(1);
		expect(projects.writes).toBe(0);
		expect(result.failedProjects).toHaveLength(1);
		expect(result.failedProjects[0]).toMatchObject({
			projectId: "p1",
			error: "simulated migration crash",
		});
		// And a pre-migration backup exists.
		const backup = await getProjectBackup({
			projectId: "p1",
			backupsStore: backups,
		});
		expect(backup?.fromVersion).toBe(1);
	});

	test("one bad project never blocks the others", async () => {
		const projects = memStore<ProjectRecord>({
			bad: project("bad", 2),
			good: project("good", 1),
		});
		const backups = memStore<ProjectBackupRecord>();

		const result = await runStorageMigrations({
			migrations: [new FakeMigration(1, 2), new ThrowingMigration(2, 3)],
			projectsStore: projects,
			backupsStore: backups,
		});

		// "bad" (v2) hits the throwing step and stays at v2; "good" migrates
		// 1->2, then fails 2->3 the same way. Both survive at their last
		// stored-good version and both are reported.
		expect((projects.data.get("bad") as { version: number }).version).toBe(2);
		expect((projects.data.get("good") as { version: number }).version).toBe(1);
		expect(result.failedProjects).toHaveLength(2);
	});

	test("restoreProjectBackup puts the pre-migration snapshot back", async () => {
		const original = project("p1", 1);
		const projects = memStore<ProjectRecord>({ p1: original });
		const backups = memStore<ProjectBackupRecord>();

		await runStorageMigrations({
			migrations: [new FakeMigration(1, 2)],
			projectsStore: projects,
			backupsStore: backups,
		});
		expect((projects.data.get("p1") as { version: number }).version).toBe(2);

		const restored = await restoreProjectBackup({
			projectId: "p1",
			projectsStore: projects,
			backupsStore: backups,
		});
		expect(restored).toBe(true);
		expect((projects.data.get("p1") as { version: number }).version).toBe(1);

		// No backup -> restore refuses rather than clobbering.
		expect(
			await restoreProjectBackup({
				projectId: "nope",
				projectsStore: projects,
				backupsStore: backups,
			}),
		).toBe(false);
	});

	test("a skipped first step writes nothing (parity with the old runner)", async () => {
		class SkippingMigration extends StorageMigration {
			from = 1;
			to = 2;
			async run({
				project,
			}: {
				projectId: string;
				project: ProjectRecord;
			}): Promise<MigrationResult<ProjectRecord>> {
				return { skipped: true, project };
			}
		}
		const projects = memStore<ProjectRecord>({ p1: project("p1", 1) });
		const backups = memStore<ProjectBackupRecord>();

		const result = await runStorageMigrations({
			migrations: [new SkippingMigration(), new FakeMigration(2, 3)],
			projectsStore: projects,
			backupsStore: backups,
		});

		expect(result.migratedCount).toBe(0);
		expect(projects.writes).toBe(0);
		expect((projects.data.get("p1") as { version: number }).version).toBe(1);
	});
});
