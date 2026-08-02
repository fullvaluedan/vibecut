import type { SceneTracks } from "@/timeline";

/**
 * Hard ceiling on VIDEO tracks. FrameCut guard against runaway track creation —
 * e.g. a Track-Select-Forward selection of N clips being dragged used to spawn
 * one new track PER clip (≈189 tracks reported). AUDIO is capped too (see
 * MAX_AUDIO_TRACKS below); text, graphic and effect tracks stay unbounded.
 *
 * Enforced at three seams, all of which call into this module:
 *  - `resolveTrackPlacement` (the decider): clamps a would-be new video track
 *    onto the topmost existing video lane once at the cap (covers drag-from-bin,
 *    insert, and the move anchor's drop-target).
 *  - `resolveNewTrackMove` (group move): caps + collapses new video tracks.
 *  - `AddTrackCommand` (direct/manual/AI adds): reuses the topmost video lane.
 */
export const MAX_VIDEO_TRACKS = 8;

/**
 * Current video-track count. `main` (V1) is always a VideoTrack and is never
 * created/destroyed, so it counts as 1; the rest are overlay tracks typed
 * `"video"`.
 */
export function videoTrackCount(tracks: SceneTracks): number {
	return 1 + tracks.overlay.filter((track) => track.type === "video").length;
}

export function isAtVideoTrackCap(tracks: SceneTracks): boolean {
	return videoTrackCount(tracks) >= MAX_VIDEO_TRACKS;
}

/** How many more video tracks may be created before hitting the cap. */
export function remainingVideoTrackBudget(tracks: SceneTracks): number {
	return Math.max(0, MAX_VIDEO_TRACKS - videoTrackCount(tracks));
}

/**
 * The lane to reuse when a new video track would exceed the cap: the topmost
 * existing overlay video track (where a new top track would otherwise go),
 * falling back to the always-present main track.
 */
export function lastVideoTrackId(tracks: SceneTracks): string {
	const topVideoOverlay = tracks.overlay.find((track) => track.type === "video");
	return topVideoOverlay?.id ?? tracks.main.id;
}

/**
 * Hard ceiling on AUDIO tracks, mirroring MAX_VIDEO_TRACKS (Dan, 2026-08-01:
 * "up to 8 video tracks and up to 8 audio tracks"). Enforced at the same
 * seams as video EXCEPT the reuse rule differs: audio separation must NEVER
 * fail at the cap, so instead of clamping onto a fixed lane it reuses the
 * LEAST-OCCUPIED existing audio lane for the clip's own span (see
 * `leastOccupiedAudioTrackId`). Text/graphic/effect lanes stay uncapped.
 */
export const MAX_AUDIO_TRACKS = 8;

export function audioTrackCount(tracks: SceneTracks): number {
	return tracks.audio.length;
}

export function isAtAudioTrackCap(tracks: SceneTracks): boolean {
	return audioTrackCount(tracks) >= MAX_AUDIO_TRACKS;
}

/** How many more audio tracks may be created before hitting the cap. */
export function remainingAudioTrackBudget(tracks: SceneTracks): number {
	return Math.max(0, MAX_AUDIO_TRACKS - audioTrackCount(tracks));
}

/**
 * The lane to reuse when a new audio track would exceed the cap: the existing
 * audio track with the FEWEST elements overlapping `span`, ties broken by
 * lowest index (A1 before A2, ...). Always returns a real track id once at
 * the cap (MAX_AUDIO_TRACKS is never 0), so separation can never throw for
 * lack of a lane.
 */
export function leastOccupiedAudioTrackId({
	tracks,
	span,
}: {
	tracks: SceneTracks;
	span: { startTime: number; duration: number };
}): string {
	const spanEnd = span.startTime + span.duration;
	let bestId = tracks.audio[0]?.id ?? "";
	let bestOverlapCount = Number.POSITIVE_INFINITY;
	for (const track of tracks.audio) {
		const overlapCount = track.elements.filter((element) => {
			const elementEnd = element.startTime + element.duration;
			return span.startTime < elementEnd && spanEnd > element.startTime;
		}).length;
		if (overlapCount < bestOverlapCount) {
			bestOverlapCount = overlapCount;
			bestId = track.id;
		}
	}
	return bestId;
}
