/**
 * Nested sequences (baked v1): render another scene to an MP4 with the
 * editor's own export pipeline, import it as an asset, and place it as a
 * clip at the playhead in the current scene. Premiere-style nesting, with
 * the caveat that edits to the source scene need a re-nest to propagate.
 */

import { toast } from "sonner";
import type { EditorCore } from "@/core";
import { processMediaAssets } from "@/media/processing";
import { compositeAiOverlays } from "@/features/ai-generate/composite-export";
import { insertMediaAsset } from "./insert-media";

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
