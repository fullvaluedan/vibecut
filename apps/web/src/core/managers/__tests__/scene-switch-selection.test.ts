import { describe, expect, test } from "bun:test";
import type { EditorCore } from "@/core";
import { ScenesManager } from "@/core/managers/scenes-manager";
import { SelectionManager } from "@/core/managers/selection-manager";
import type { SceneTracks, TScene, VideoElement } from "@/timeline";
import { mediaTime, ZERO_MEDIA_TIME } from "@/wasm";

function videoClip(id: string): VideoElement {
	return {
		id,
		type: "video",
		name: id,
		startTime: ZERO_MEDIA_TIME,
		duration: mediaTime({ ticks: 120_000 }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		mediaId: `media-${id}`,
		params: {
			"transform.positionX": 0,
			"transform.positionY": 0,
			"transform.scaleX": 1,
			"transform.scaleY": 1,
			"transform.rotate": 0,
			opacity: 1,
		},
	};
}

// Two scenes that REUSE the same main-track id ("video-main"). Scene A's main
// track holds clip "a"; scene B's reuses the id but holds a different clip "b".
function sceneWithMainClip({
	id,
	clipId,
}: {
	id: string;
	clipId: string;
}): TScene {
	const tracks: SceneTracks = {
		overlay: [],
		main: {
			id: "video-main",
			type: "video",
			name: "video-main",
			muted: false,
			hidden: false,
			elements: [videoClip(clipId)],
		},
		audio: [],
	};
	return {
		id,
		name: id,
		isMain: id === "scene-a",
		tracks,
		bookmarks: [],
		createdAt: new Date(),
		updatedAt: new Date(),
	};
}

function makeManager(): { manager: ScenesManager; selection: SelectionManager } {
	const selection = new SelectionManager({} as EditorCore);
	let activeProject: unknown = {
		id: "p",
		currentSceneId: "scene-a",
		metadata: { updatedAt: new Date() },
		scenes: [],
	};
	const editor = {
		selection,
		project: {
			getActive: () => activeProject,
			setActiveProject: ({ project }: { project: unknown }) => {
				activeProject = project;
			},
		},
	} as unknown as EditorCore;
	const manager = new ScenesManager(editor);
	manager.setScenes({
		scenes: [
			sceneWithMainClip({ id: "scene-a", clipId: "a" }),
			sceneWithMainClip({ id: "scene-b", clipId: "b" }),
		],
		activeSceneId: "scene-a",
	});
	return { manager, selection };
}

describe("ScenesManager.switchToScene selection reconcile", () => {
	test("prunes a stale cross-scene selection ref on a reused track id", async () => {
		const { manager, selection } = makeManager();

		// Select clip "a" in scene A (track id reused by scene B).
		selection.setSelectedElements({
			elements: [{ trackId: "video-main", elementId: "a" }],
		});

		await manager.switchToScene({ sceneId: "scene-b" });

		// Scene B's "video-main" holds "b", not "a", so the stale ref to "a" must be
		// pruned -- otherwise it would tint the reused row with nothing selected.
		expect(selection.getSelectedElements()).toEqual([]);
	});

	test("keeps a selection ref that is still live in the target scene", async () => {
		const { manager, selection } = makeManager();

		// Select the clip id that IS present on the reused track in scene B.
		selection.setSelectedElements({
			elements: [{ trackId: "video-main", elementId: "b" }],
		});

		await manager.switchToScene({ sceneId: "scene-b" });

		expect(selection.getSelectedElements()).toEqual([
			{ trackId: "video-main", elementId: "b" },
		]);
	});
});
