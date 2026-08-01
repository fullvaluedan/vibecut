/**
 * T18.1 freeze frame: split a video clip at the playhead and insert a still
 * of that exact frame between the halves (CapCut parity).
 *
 * IMPLEMENTATION CHOICE: a captured-frame IMAGE ASSET, not a rate-0/hold
 * retime segment. Why: this repo's renderer has no concept of a "held"
 * video frame anywhere in its sampling path (retime/resolve.ts always maps
 * clip time to a moving source time; a rate of 0 divides the timeline
 * duration formula by zero - see retime/rate.ts's MIN_RETIME_RATE floor,
 * which exists precisely to keep rate above 0). Modeling freeze frame as a
 * hold would mean adding a whole new "frozen" mode to VideoNode, resolve.ts,
 * AND scene-builder.ts, on top of interacting with reverse (T18.1's other
 * new retime flag) and speed curves (T18.2, already on the roadmap) - real
 * renderer risk for a feature that doesn't need moving-video semantics at
 * all once it's frozen. An image element, by contrast, is a FIRST-CLASS
 * timeline citizen already: ImageNode/resolve.ts/scene-builder.ts handle it
 * with zero new code, it trims and drags like any other clip, and export
 * parity is automatic (same buildScene() pipeline renders preview AND
 * export - see scene-builder.ts). The only new code this needs is capturing
 * the pixels once (services/renderer/capture-frame.ts) via the SAME
 * `videoCache.getFrameAt` the renderer already calls for that mediaId, so
 * the captured frame is guaranteed to match what's on screen.
 *
 * ONE UNDO: the whole thing (new asset + split + ripple + insert) runs as a
 * single BatchCommand via `editor.command.execute`, so one Ctrl+Z reverts
 * everything. `AddMediaAssetCommand` is itself undoable - see
 * commands/media/add-media-asset.ts.
 */

import {
	AddMediaAssetCommand,
	BatchCommand,
	InsertElementCommand,
	SplitElementsCommand,
} from "@/commands";
import type { Command } from "@/commands/base-command";
import { RippleShiftAtCommand } from "@/commands/timeline/element/ripple-shift-at";
import type { EditorCore } from "@/core";
import type { MediaAsset } from "@/media/types";
import { captureVideoFrameAsFile } from "@/services/renderer/capture-frame";
import { getSourceTimeAtClipTime } from "@/retime";
import { getElementsAtTime, isRetimableElement } from "@/timeline";
import type { SceneTracks, VideoElement } from "@/timeline";
import { buildElementFromMedia } from "@/timeline/element-utils";
import { findLinkedPartners } from "@/timeline/link-elements";
import {
	addMediaTime,
	mediaTimeFromSeconds,
	mediaTimeToSeconds,
	roundMediaTime,
	subMediaTime,
	type MediaTime,
} from "@/wasm";

export const FREEZE_FRAME_DURATION_SECONDS = 3;

export type FreezeFrameStatus =
	| "inserted"
	| "no-target"
	| "capture-failed";

export interface FreezeFrameResult {
	status: FreezeFrameStatus;
	trackId?: string;
	elementId?: string;
}

interface FreezeFrameTarget {
	trackId: string;
	elementId: string;
	element: VideoElement;
}

/**
 * The video clip to freeze: an explicit ref (context-menu "Freeze frame" on
 * a specific clip) if given, else whichever video clip the playhead is
 * currently over (toolbar button, mirrors the "split" action's targeting in
 * use-editor-actions.ts). Either way, the playhead must be STRICTLY inside
 * the clip's span - `getElementsAtTime` already excludes the boundary
 * (start/end) so a playhead sitting exactly on a cut never picks a target.
 */
function findFreezeFrameTarget({
	tracks,
	currentTime,
	elementRef,
}: {
	tracks: SceneTracks;
	currentTime: MediaTime;
	elementRef?: { trackId: string; elementId: string };
}): FreezeFrameTarget | null {
	const candidates = elementRef
		? [elementRef]
		: getElementsAtTime({ tracks, time: currentTime });
	const orderedTracks = [tracks.main, ...tracks.overlay, ...tracks.audio];

	for (const ref of candidates) {
		const track = orderedTracks.find((candidate) => candidate.id === ref.trackId);
		const element = track?.elements.find((candidate) => candidate.id === ref.elementId);
		if (
			element &&
			element.type === "video" &&
			currentTime > element.startTime &&
			currentTime < element.startTime + element.duration
		) {
			return { trackId: ref.trackId, elementId: ref.elementId, element };
		}
	}
	return null;
}

export async function freezeFrameAtPlayhead({
	editor,
	elementRef,
}: {
	editor: EditorCore;
	elementRef?: { trackId: string; elementId: string };
}): Promise<FreezeFrameResult> {
	const activeScene = editor.scenes.getActiveSceneOrNull();
	const activeProject = editor.project.getActiveOrNull();
	if (!activeScene || !activeProject) {
		return { status: "no-target" };
	}

	const currentTime = editor.playback.getCurrentTime();
	const target = findFreezeFrameTarget({
		tracks: activeScene.tracks,
		currentTime,
		elementRef,
	});
	if (!target) {
		return { status: "no-target" };
	}
	const { trackId, elementId, element } = target;

	const mediaAsset = editor.media
		.getAssets()
		.find((asset) => asset.id === element.mediaId);
	if (!mediaAsset?.file) {
		return { status: "capture-failed" };
	}

	// Mirrors services/renderer/resolve.ts's resolveVideoNode EXACTLY (trim +
	// retime, including reverse) so the captured frame is the one the user is
	// actually looking at, not an approximation.
	const clipTime = subMediaTime({ a: currentTime, b: element.startTime });
	const retime = isRetimableElement(element) ? element.retime : undefined;
	const sourceTimeTicks = addMediaTime({
		a: element.trimStart,
		b: roundMediaTime({
			time: getSourceTimeAtClipTime({
				clipTime,
				retime,
				clipDuration: element.duration,
			}),
		}),
	});
	const sourceTimeSeconds = mediaTimeToSeconds({ time: sourceTimeTicks });

	const captured = await captureVideoFrameAsFile({
		mediaId: element.mediaId,
		file: mediaAsset.file,
		sourceTimeSeconds,
		name: `${element.name} freeze frame.png`,
	});
	if (!captured) {
		return { status: "capture-failed" };
	}

	const objectUrl = URL.createObjectURL(captured.file);
	const asset: Omit<MediaAsset, "id"> = {
		name: `${element.name} freeze frame`,
		type: "image",
		file: captured.file,
		url: objectUrl,
		thumbnailUrl: objectUrl,
		width: captured.width,
		height: captured.height,
		// Generated from an existing clip, not a real import - keep it out of
		// the media bin / Assemble (mirrors solid-color assets).
		ephemeral: true,
	};

	const addAssetCommand = new AddMediaAssetCommand({
		projectId: activeProject.metadata.id,
		asset,
	});
	const { batch, insertCommand } = buildFreezeFrameBatch({
		trackId,
		elementId,
		splitTime: currentTime,
		stillAssetId: addAssetCommand.getAssetId(),
		tracks: activeScene.tracks,
		leadingCommands: [addAssetCommand],
	});

	editor.command.execute({ command: batch });

	return {
		status: "inserted",
		trackId,
		elementId: insertCommand.getElementId() ?? undefined,
	};
}

/**
 * Pure composition of the four commands (split, ripple, insert, plus
 * whatever the caller wants to run first - normally `AddMediaAssetCommand`)
 * into ONE BatchCommand. Split out from `freezeFrameAtPlayhead` so tests can
 * exercise the split+ripple+insert mechanics directly, without mocking the
 * async frame-capture step - see
 * commands/timeline/element/__tests__/freeze-frame-batch.test.ts.
 *
 * G6 fix (round 18 reopen): `tracks` is now required so the split can find
 * the target clip's linked audio partner (shared `linkId`, same span) BEFORE
 * splitting - see the `linkedPartners` comment below for why that has to
 * happen in the SAME `SplitElementsCommand` call rather than a second one.
 */
export function buildFreezeFrameBatch({
	trackId,
	elementId,
	splitTime,
	stillAssetId,
	tracks,
	leadingCommands = [],
	durationSeconds = FREEZE_FRAME_DURATION_SECONDS,
}: {
	trackId: string;
	elementId: string;
	splitTime: MediaTime;
	stillAssetId: string;
	tracks: SceneTracks;
	leadingCommands?: Command[];
	durationSeconds?: number;
}): { batch: BatchCommand; insertCommand: InsertElementCommand } {
	// CapCut parity choice: the still is silent, so the linked audio is SPLIT
	// (not left running) at the freeze point and its right half rides the
	// same ripple as the video - silence plays under the still instead of the
	// original audio racing ahead of the now-frozen picture. Both halves must
	// come out of the SAME SplitElementsCommand.execute() call so its
	// freshLinkIdByGroup mints ONE fresh linkId shared by the video's right
	// half and the audio's right half (keyed by the ORIGINAL linkId) - two
	// separate split calls would each mint their own fresh id and the right
	// halves would come out unlinked, defeating the ripple's linked-partner
	// propagation below (see ripple-shift-at.ts).
	const linkedPartners = findLinkedPartners({
		ref: { trackId, elementId },
		tracks,
		mode: "timeline",
	});

	const splitCommand = new SplitElementsCommand({
		elements: [{ trackId, elementId }, ...linkedPartners],
		splitTime,
		retainSide: "both",
	});

	const freezeDuration = mediaTimeFromSeconds({ seconds: durationSeconds });

	// Opens the hole on the video's own track (current behavior) AND, via its
	// linked-partner walk, on the audio track the split above just put a
	// freshly-linked right half onto - one ripple call, cross-track by
	// construction. See ripple-shift-at.ts's class doc for the propagation
	// rule (mirrors timeline/magnet.ts's collectMagnetTrimTargets).
	const rippleCommand = new RippleShiftAtCommand({
		trackId,
		atTime: splitTime,
		shiftDuration: freezeDuration,
	});

	const stillElement = buildElementFromMedia({
		mediaId: stillAssetId,
		mediaType: "image",
		name: "Freeze frame",
		duration: freezeDuration,
		startTime: splitTime,
	});
	const insertCommand = new InsertElementCommand({
		element: stillElement,
		placement: { mode: "explicit", trackId },
	});

	return {
		batch: new BatchCommand([
			...leadingCommands,
			splitCommand,
			rippleCommand,
			insertCommand,
		]),
		insertCommand,
	};
}
