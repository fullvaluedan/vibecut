import { type MediaTime, TICKS_PER_SECOND, ZERO_MEDIA_TIME } from "@/wasm";

/**
 * Head gravity (Dan's fork, 2026-07-17): the main track's absolute snap-to-0
 * pin is replaced by a 2-second gravity zone. A main-track placement or move
 * whose requested start lands under this threshold snaps to 0; at or beyond
 * it, clips move freely (only the >= 0 clamp applies). One shared constant so
 * the drag clamp (group-move/resolve-move.ts), the update-pipeline startTime
 * enforce rule, and placement/main-track.ts can never drift apart.
 *
 * FrameCut-owned module (new file, not upstream).
 */
export const HEAD_GRAVITY_SEC = 2.0;

const HEAD_GRAVITY_TICKS = HEAD_GRAVITY_SEC * TICKS_PER_SECOND;

/** Whether a requested start lies inside the gravity zone `[0, 2s)`. */
export function isUnderHeadGravity({
	startTime,
}: {
	startTime: MediaTime;
}): boolean {
	return startTime < HEAD_GRAVITY_TICKS;
}

/**
 * Snap a requested main-track start to 0 when it lands inside the gravity
 * zone; otherwise return it unchanged. A negative request is under gravity by
 * definition and snaps to 0 too.
 */
export function snapToHead({
	startTime,
}: {
	startTime: MediaTime;
}): MediaTime {
	return isUnderHeadGravity({ startTime }) ? ZERO_MEDIA_TIME : startTime;
}
