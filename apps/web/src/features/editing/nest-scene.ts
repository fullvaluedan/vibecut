/**
 * Nested sequences (baked v1): render another scene to an MP4 with the
 * editor's own export pipeline, import it as an asset, and place it as a
 * clip at the playhead in the current scene. Premiere-style nesting, with
 * the caveat that edits to the source scene need a re-nest to propagate.
 */

import { toast } from "sonner";
import type { EditorCore } from "@/core";
import type { SceneTracks, TimelineElement } from "@/timeline";
import { processMediaAssets } from "@/media/processing";
import { compositeAiOverlays } from "@/features/ai-generate/composite-export";
import { mediaTimeFromSeconds, TICKS_PER_SECOND } from "@/wasm";
import { insertMediaAsset } from "./insert-media";

/**
 * Premiere-style "Nest": moves the selected timeline clips into a brand-new
 * scene, renders that scene, and replaces the selection with a single
 * nested clip at the same spot. The new scene stays editable — re-nest
 * after editing to refresh the baked clip.
 */
export async function nestSelectionIntoNewScene({
	editor,
}: {
	editor: EditorCore;
}): Promise<void> {
	const selected = editor.selection.getSelectedElements();
	if (!selected.length) {
		throw new Error("Select one or more clips on the timeline first.");
	}
	const selectedIds = new Set(selected.map((s) => s.elementId));
	const activeScene = editor.scenes.getActiveScene();
	const tracks = activeScene.tracks;

	const isSelected = (el: { id: string }) => selectedIds.has(el.id);
	const pickedAll: TimelineElement[] = [
		...(tracks.main.elements as TimelineElement[]).filter(isSelected),
		...tracks.overlay.flatMap((t) =>
			(t.elements as TimelineElement[]).filter(isSelected),
		),
		...tracks.audio.flatMap((t) =>
			(t.elements as TimelineElement[]).filter(isSelected),
		),
	];
	if (!pickedAll.length) {
		throw new Error("Selection not found on the timeline.");
	}
	const minStart = Math.min(...pickedAll.map((el) => el.startTime));
	// Track-level helper: element arrays are per-track-type unions, so the
	// filter/shift has to go through TimelineElement[] and back via the generic.
	const pickShiftTrack = <T extends { elements: readonly TimelineElement[] }>(
		t: T,
	): T =>
		({
			...t,
			elements: (t.elements as TimelineElement[])
				.filter(isSelected)
				.map((el) => ({ ...el, startTime: el.startTime - minStart })),
		}) as unknown as T;

	const synthetic: SceneTracks = {
		main: pickShiftTrack(tracks.main),
		overlay: tracks.overlay
			.map(pickShiftTrack)
			.filter((t) => t.elements.length > 0),
		audio: tracks.audio
			.map(pickShiftTrack)
			.filter((t) => t.elements.length > 0),
	};

	const sceneCount = editor.scenes.getScenes().length;
	const sceneName = `Nested sequence ${sceneCount}`;
	const toastId = toast.loading(`Nesting ${pickedAll.length} clip(s) into "${sceneName}"...`);
	try {
		// 1. Create the editable source scene and move the clips into it.
		const sceneId = await editor.scenes.createScene({
			name: sceneName,
			isMain: false,
		});
		await editor.scenes.switchToScene({ sceneId });
		const newSceneTracks = editor.scenes.getActiveScene().tracks;
		editor.timeline.updateTracks({
			main: { ...newSceneTracks.main, elements: synthetic.main.elements },
			overlay: [...newSceneTracks.overlay, ...synthetic.overlay],
			audio: [...newSceneTracks.audio, ...synthetic.audio],
		});
		await editor.scenes.switchToScene({ sceneId: activeScene.id });

		// 2. Bake the scene to video (AI overlays burned in).
		const result = await editor.renderer.exportProject({
			options: { format: "mp4", quality: "high", includeAudio: true },
			sceneTracks: synthetic,
			onProgress: ({ progress }) => {
				toast.loading(`Rendering "${sceneName}"... ${Math.round(progress * 100)}%`, {
					id: toastId,
				});
			},
		});
		if (!result.success || !result.buffer) {
			throw new Error(result.error ?? "Scene render failed");
		}
		const { buffer } = await compositeAiOverlays({
			baseBuffer: result.buffer,
			baseName: "base.mp4",
			tracks: synthetic,
			mediaAssets: editor.media.getAssets(),
			canvasSize: editor.project.getActive().settings.canvasSize,
		});

		// 3. Replace the selection with the nested clip.
		const file = new File([buffer], `${sceneName}.mp4`, { type: "video/mp4" });
		const [processed] = await processMediaAssets({ files: [file] });
		if (!processed) throw new Error("Could not process the rendered scene");
		const added = await editor.media.addMediaAsset({
			projectId: editor.project.getActive().metadata.id,
			asset: processed,
		});
		if (!added) throw new Error("Could not store the rendered scene");

		editor.timeline.deleteElements({ elements: selected });
		insertMediaAsset({
			editor,
			asset: added,
			startTime: mediaTimeFromSeconds({ seconds: minStart / TICKS_PER_SECOND }),
			separateAudio: false,
		});
		toast.success(`Nested into "${sceneName}"`, {
			id: toastId,
			description: "Edit the scene from the Scenes panel, then Nest it again to refresh.",
		});
	} catch (e) {
		toast.error("Nest failed", {
			id: toastId,
			description: e instanceof Error ? e.message : String(e),
		});
		throw e;
	}
}

export async function nestSceneIntoActive({
	editor,
	sceneId,
}: {
	editor: EditorCore;
	sceneId: string;
}): Promise<void> {
	const scene = editor.scenes.getScenes().find((s) => s.id === sceneId);
	if (!scene) {
		throw new Error("Scene not found");
	}
	const activeScene = editor.scenes.getActiveScene();
	if (activeScene.id === sceneId) {
		throw new Error("Switch to a different scene first — a scene can't nest into itself.");
	}

	const toastId = toast.loading(`Nesting "${scene.name}"...`, {
		description: "Rendering the scene in the background.",
	});
	try {
		const result = await editor.renderer.exportProject({
			options: { format: "mp4", quality: "high", includeAudio: true },
			sceneTracks: scene.tracks,
			onProgress: ({ progress }) => {
				toast.loading(`Nesting "${scene.name}"... ${Math.round(progress * 100)}%`, {
					id: toastId,
					description: "Rendering the scene in the background.",
				});
			},
		});
		if (!result.success || !result.buffer) {
			throw new Error(result.error ?? "Scene render failed");
		}

		// Burn in any AI overlay clips the canvas pipeline skipped.
		const { buffer } = await compositeAiOverlays({
			baseBuffer: result.buffer,
			baseName: "base.mp4",
			tracks: scene.tracks,
			mediaAssets: editor.media.getAssets(),
			canvasSize: editor.project.getActive().settings.canvasSize,
		});

		const file = new File([buffer], `${scene.name} (nested).mp4`, {
			type: "video/mp4",
		});
		const [processed] = await processMediaAssets({ files: [file] });
		if (!processed) throw new Error("Could not process the rendered scene");

		const added = await editor.media.addMediaAsset({
			projectId: editor.project.getActive().metadata.id,
			asset: processed,
		});
		if (!added) throw new Error("Could not store the rendered scene");

		insertMediaAsset({
			editor,
			asset: added,
			startTime: editor.playback.getCurrentTime(),
			separateAudio: false,
		});

		toast.success(`Nested "${scene.name}" at the playhead`, { id: toastId });
	} catch (e) {
		toast.error(`Couldn't nest "${scene.name}"`, {
			id: toastId,
			description: e instanceof Error ? e.message : String(e),
		});
		throw e;
	}
}
