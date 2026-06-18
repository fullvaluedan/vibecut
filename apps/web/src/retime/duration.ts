import { clampRetimeRate } from "./rate";

/**
 * Pure duration <-> rate conversion for the constant-speed (Premiere
 * Speed/Duration) UI. Wasm-free on purpose: this file must NOT import `@/wasm`
 * so it can be unit-tested under bun. Operate on plain numbers — the caller
 * decides whether they are ticks or seconds (the relationship is unit-agnostic
 * because rate is dimensionless).
 *
 * The governing relationship: an element's on-timeline duration equals its
 * (fixed) source-window length divided by the playback rate.
 *
 *     timelineDuration = sourceWindowLength / rate
 *     rate             = sourceWindowLength / timelineDuration
 *
 * Both ends honour `clampRetimeRate` (constant, positive rate, 0.01x..5x).
 */

/**
 * Derive the playback rate needed to make a clip occupy `targetTicks` on the
 * timeline, given its fixed source-window length. The result is clamped to the
 * legal retime bounds, so very short/long targets saturate at 5x/0.01x rather
 * than producing an out-of-range rate.
 */
export function rateForTargetDuration({
	sourceWindowTicks,
	targetTicks,
}: {
	sourceWindowTicks: number;
	targetTicks: number;
}): number {
	// `clampRetimeRate` already maps non-finite / non-positive inputs (including
	// a 0 / 0 NaN or division-by-zero Infinity) to a safe in-range rate.
	return clampRetimeRate({ rate: sourceWindowTicks / targetTicks });
}

/**
 * Derive the on-timeline duration a clip will have at a given rate, given its
 * fixed source-window length. The rate is clamped to the legal retime bounds
 * first, so the returned duration matches what the update pipeline will
 * actually store. Returns 0 for a non-positive source window.
 */
export function targetDurationForRate({
	sourceWindowTicks,
	rate,
}: {
	sourceWindowTicks: number;
	rate: number;
}): number {
	if (!Number.isFinite(sourceWindowTicks) || sourceWindowTicks <= 0) {
		return 0;
	}

	const safeRate = clampRetimeRate({ rate });
	return sourceWindowTicks / safeRate;
}
