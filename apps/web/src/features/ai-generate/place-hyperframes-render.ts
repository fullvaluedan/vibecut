/**
 * Bring a HyperFrames render back onto the timeline.
 *
 * When a render comes back from the HyperFrames skill / Studio, it lands on a
 * BRAND-NEW track — it never overwrites existing footage (Dan's rule):
 *   - whole-timeline render  → a new video track, clip at t=0 (the start)
 *   - a scoped segment/clip   → a new video track, clip OVER that segment
 *     (at the segment's start time)
 * If the render carries audio (e.g. SFX), that audio is split onto its own
 * audio track below — again, a fresh track, nothing overwritten.
 *
 * The placed clip is selected and returned so the caller can reveal it — the
 * user can see exactly where it landed.
 */

import { AddMediaAssetCommand } from "@/commands/media/add-media-asset";
import {
	AddTrackCommand,
	BatchCommand,
	InsertElementCommand,
} from "@/commands";
import { processMediaAssets } from "@/media/processing";
import { ZERO_MEDIA_TIME, mediaTimeFromSeconds } from "@/wasm";
import { generateUUID } from "@/utils/id";
import type { EditorCore } from "@/core";

export interface HyperframesRenderScope {
	/** Whole timeline, a single clip, or a nested sequence. */
	kind: "timeline" | "clip" | "nested";
	/** Human label for the toast ("the whole video", a clip name, …). */
	label: string;
	/** Where the render lands on the timeline, in seconds. 0 for whole-timeline. */
	startSec: number;
}

export interface PlacedRender {
	trackId: string;
	elementId: string;
	startSec: number;
	durationSec: number;
	splitAudio: boolean;
}

/**
 * Imports a rendered HyperFrames file and places it on a new track per the
 * scope rule. Returns where it landed (or throws on failure).
 */
export async function placeHyperframesRender({
	editor,
	file,
	scope,
	templateId,
	compId,
	name,
}: {
	editor: EditorCore;
	/** The rendered video file (transparent WebM for overlays, etc.). */
	file: File;
	scope: HyperframesRenderScope;
	/** Optional provenance so the clip rides the AI overlay/export path. */
	templateId?: string;
	compId?: string;
	/** Clip label on the timeline. */
	name?: string;
}): Promise<PlacedRender> {
	const project = editor.project.getActive();

	// 1. Import the rendered file the same way every media import does
	//    (derives duration + thumbnail + hasAudio).
	const [processed] = await processMediaAssets({ files: [file] });
	if (!processed) throw new Error("Could not process the HyperFrames render");

	const addAsset = new AddMediaAssetCommand({
		projectId: project.metadata.id,
		asset: processed,
	});
	editor.command.execute({ command: addAsset });
	const assetId = addAsset.getAssetId();
	if (!assetId) throw new Error("Could not store the HyperFrames render");

	// 2. Always a NEW video track on top (index 0) — never reuse, never
	//    overwrite. Whole-timeline and segment differ only in start time.
	const startTime = mediaTimeFromSeconds({ seconds: Math.max(0, scope.startSec) });
	const durationTime =
		processed.duration != null
			? mediaTimeFromSeconds({ seconds: processed.duration })
			: mediaTimeFromSeconds({ seconds: 5 });

	const addTrack = new AddTrackCommand({ type: "video", index: 0 });
	const trackId = addTrack.getTrackId();
	const insert = new InsertElementCommand({
		element: {
			type: "video",
			mediaId: assetId,
			name: name ?? `HyperFrames: ${scope.label}`,
			startTime,
			duration: durationTime,
			trimStart: ZERO_MEDIA_TIME,
			trimEnd: ZERO_MEDIA_TIME,
			sourceDuration: durationTime,
			// Keep the render's own audio on the video clip for now; it is split
			// out below if present. (A pure overlay has no audio to split.)
			isSourceAudioEnabled: processed.hasAudio !== false,
			params: {},
			framecutAi: {
				compId: compId ?? generateUUID(),
				templateId: templateId ?? `hyperframes:${scope.kind}`,
				variables: {},
				groupId: generateUUID(),
			},
		},
		placement: { mode: "explicit", trackId },
	});
	// One undo step for "new track + clip on it".
	editor.command.execute({ command: new BatchCommand([addTrack, insert]) });
	const elementId = insert.getElementId();
	if (!elementId) throw new Error("Could not place the HyperFrames render");

	// 3. If the render carries audio (SFX / a full-video example with sound),
	//    split it onto its own audio track below — a fresh track, nothing
	//    overwritten. Pure overlays have no audio, so this is skipped.
	let splitAudio = false;
	if (processed.type === "video" && processed.hasAudio !== false) {
		editor.timeline.toggleSourceAudioSeparation({ trackId, elementId });
		splitAudio = true;
	}

	// 4. Select the placed clip so the user sees where it landed.
	editor.selection.setSelectedElements({
		elements: [{ trackId, elementId }],
	});

	return {
		trackId,
		elementId,
		startSec: Math.max(0, scope.startSec),
		durationSec: processed.duration ?? 5,
		splitAudio,
	};
}
