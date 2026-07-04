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
	brief,
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
	/** The authoring brief — lets the panel show an editable prompt + regenerate. */
	brief?: string;
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
				brief,
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

export interface ChunkRenderInput {
	/** The rendered transparent WebM for this segment. */
	file: File;
	/** Where it lands on the timeline, in seconds. */
	startSec: number;
	compId?: string;
	templateId?: string;
	name?: string;
	/** The authoring brief for this chunk — drives the panel's editable prompt. */
	brief?: string;
}

/**
 * Place MANY HyperFrames renders (the chunked authored engine: one composition
 * per ~90s segment) on ONE shared new video track, each at its segment offset.
 * Chunks are sequential + non-overlapping, so a single explicit track holds
 * them all with no lane logic. One BatchCommand = one undo step for the whole
 * run. Returns how many actually landed. Authored overlays are transparent
 * (no audio), so no source-audio split here.
 */
export async function placeHyperframesRenders({
	editor,
	renders,
	trackName = "HyperFrames",
}: {
	editor: EditorCore;
	renders: ChunkRenderInput[];
	trackName?: string;
}): Promise<number> {
	if (!renders.length) return 0;
	const project = editor.project.getActive();

	// Import each render to a media asset first (eager, same as the singular fn).
	const assets: {
		assetId: string;
		startSec: number;
		durationSec: number;
		hasAudio: boolean;
		compId?: string;
		templateId?: string;
		name?: string;
		brief?: string;
	}[] = [];
	for (const r of renders) {
		const [processed] = await processMediaAssets({ files: [r.file] });
		if (!processed) continue; // skip a bad render, keep the rest
		const addAsset = new AddMediaAssetCommand({
			projectId: project.metadata.id,
			asset: processed,
		});
		editor.command.execute({ command: addAsset });
		const assetId = addAsset.getAssetId();
		if (!assetId) continue;
		assets.push({
			assetId,
			startSec: Math.max(0, r.startSec),
			durationSec: processed.duration ?? 5,
			hasAudio: processed.hasAudio !== false,
			compId: r.compId,
			templateId: r.templateId,
			name: r.name,
			brief: r.brief,
		});
	}
	if (!assets.length) return 0;

	const addTrack = new AddTrackCommand({ type: "video", index: 0 });
	const trackId = addTrack.getTrackId(); // stable pre-execute
	const inserts = assets.map(
		(a) =>
			new InsertElementCommand({
				element: {
					type: "video",
					mediaId: a.assetId,
					name: a.name ?? `${trackName}: ${a.startSec.toFixed(1)}s`,
					startTime: mediaTimeFromSeconds({ seconds: a.startSec }),
					duration: mediaTimeFromSeconds({ seconds: a.durationSec }),
					trimStart: ZERO_MEDIA_TIME,
					trimEnd: ZERO_MEDIA_TIME,
					sourceDuration: mediaTimeFromSeconds({ seconds: a.durationSec }),
					isSourceAudioEnabled: a.hasAudio,
					params: {},
					framecutAi: {
						compId: a.compId ?? generateUUID(),
						templateId: a.templateId ?? "authored:chunk",
						variables: {},
						groupId: generateUUID(),
						brief: a.brief,
					},
				},
				placement: { mode: "explicit", trackId },
			}),
	);
	// One new track + all clips on it = a single undo step.
	editor.command.execute({ command: new BatchCommand([addTrack, ...inserts]) });

	const after = editor.scenes.getActiveScene().tracks;
	const onTimeline = new Set(
		[after.main, ...after.overlay].flatMap((t) => t.elements.map((e) => e.id)),
	);
	const placedEls: { trackId: string; elementId: string }[] = [];
	for (const ins of inserts) {
		const id = ins.getElementId();
		if (id && onTimeline.has(id)) placedEls.push({ trackId, elementId: id });
	}
	if (placedEls.length) {
		editor.selection.setSelectedElements({ elements: placedEls });
	}
	return placedEls.length;
}
