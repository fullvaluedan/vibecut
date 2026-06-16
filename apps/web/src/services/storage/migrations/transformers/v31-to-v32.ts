import type { MigrationResult, ProjectRecord } from "./types";
import { getProjectId, isRecord } from "./utils";

// v32 adds the `expand` mask param (U8) to BaseMaskParams. Backfill it to 0 on
// every persisted mask so old projects keep their exact appearance; the renderer
// and the masks-tab treat a missing `expand` as a hard error otherwise.
export function transformProjectV31ToV32({
	project,
}: {
	project: ProjectRecord;
}): MigrationResult<ProjectRecord> {
	if (!getProjectId({ project })) {
		return { project, skipped: true, reason: "no project id" };
	}

	const version = project.version;
	if (typeof version !== "number") {
		return { project, skipped: true, reason: "invalid version" };
	}
	if (version >= 32) {
		return { project, skipped: true, reason: "already v32" };
	}
	if (version !== 31) {
		return { project, skipped: true, reason: "not v31" };
	}

	return {
		project: {
			...backfillMaskExpand({ project }),
			version: 32,
		},
		skipped: false,
	};
}

function backfillMaskExpand({
	project,
}: {
	project: ProjectRecord;
}): ProjectRecord {
	const nextProject = { ...project };
	if (Array.isArray(project.scenes)) {
		nextProject.scenes = project.scenes.map((scene) => migrateScene({ scene }));
	}
	return nextProject;
}

function migrateScene({ scene }: { scene: unknown }): unknown {
	if (!isRecord(scene)) {
		return scene;
	}

	const nextScene = { ...scene };
	if (isRecord(scene.tracks)) {
		nextScene.tracks = migrateTracks({ tracks: scene.tracks });
	}
	return nextScene;
}

function migrateTracks({ tracks }: { tracks: ProjectRecord }): ProjectRecord {
	const nextTracks = { ...tracks };
	if (isRecord(tracks.main)) {
		nextTracks.main = migrateTrack({ track: tracks.main });
	}
	if (Array.isArray(tracks.overlay)) {
		nextTracks.overlay = tracks.overlay.map((track) => migrateTrack({ track }));
	}
	if (Array.isArray(tracks.audio)) {
		nextTracks.audio = tracks.audio.map((track) => migrateTrack({ track }));
	}
	return nextTracks;
}

function migrateTrack({ track }: { track: unknown }): unknown {
	if (!isRecord(track)) {
		return track;
	}

	const elementsValue = track.elements;
	if (!Array.isArray(elementsValue)) {
		return track;
	}

	return {
		...track,
		elements: elementsValue.map((element) => migrateElement({ element })),
	};
}

function migrateElement({ element }: { element: unknown }): unknown {
	if (!isRecord(element)) {
		return element;
	}

	const masksValue = element.masks;
	if (!Array.isArray(masksValue)) {
		return element;
	}

	return {
		...element,
		masks: masksValue.map((mask) => migrateMask({ mask })),
	};
}

function migrateMask({ mask }: { mask: unknown }): unknown {
	if (!isRecord(mask)) {
		return mask;
	}

	const paramsValue = mask.params;
	if (!isRecord(paramsValue) || typeof paramsValue.expand === "number") {
		return mask;
	}

	return {
		...mask,
		params: {
			...paramsValue,
			expand: 0,
		},
	};
}
