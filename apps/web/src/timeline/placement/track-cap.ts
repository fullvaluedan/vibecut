import type { SceneTracks } from "@/timeline";

/**
 * Hard ceiling on VIDEO tracks. FrameCut guard against runaway track creation —
 * e.g. a Track-Select-Forward selection of N clips being dragged used to spawn
 * one new track PER clip (≈189 tracks reported). Only VIDEO is capped; audio,
 * text, graphic and effect tracks are unbounded.
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
