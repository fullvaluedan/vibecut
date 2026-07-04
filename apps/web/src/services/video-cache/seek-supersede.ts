/**
 * Pure supersession decision for the video-frame cache (wasm-free → bun-testable).
 *
 * The preview RAF loop re-requests the frame at the current playhead every tick.
 * Superseding queued decodes by a monotonic COUNT (the old behavior) meant those
 * same-time repeats kept cancelling the in-flight decode — so a slow deep seek
 * into a long source never completed and the preview froze on the first frame.
 * Superseding by requested TIME instead lets same-time repeats coalesce while a
 * genuinely newer seek still wins.
 */

/**
 * Requested times within this many seconds count as "the same seek" (playhead
 * float jitter or the RAF loop re-requesting the current frame) and must NOT
 * supersede an in-flight decode. Well below a single frame's duration, so a real
 * scrub/seek still supersedes.
 */
export const SEEK_SUPERSEDE_EPSILON_SEC = 1e-3;

/**
 * True when a queued decode for `requestedTime` is stale because a DIFFERENT
 * latest time has since been requested. A same-time repeat (within epsilon), or
 * no recorded latest, is NOT superseded.
 */
export function isSeekSuperseded({
	requestedTime,
	latestTime,
	epsilon = SEEK_SUPERSEDE_EPSILON_SEC,
}: {
	requestedTime: number;
	latestTime: number | undefined;
	epsilon?: number;
}): boolean {
	if (latestTime === undefined) return false;
	return Math.abs(latestTime - requestedTime) > epsilon;
}
