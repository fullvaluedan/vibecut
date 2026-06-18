/**
 * Pure frame-delta math for keyboard nudging (U6).
 *
 * One video frame is `ticksPerSecond * (fpsDenominator / fpsNumerator)` ticks.
 * Kept free of the wasm `MediaTime` brand so it is unit-testable without the
 * runtime — callers wrap the result in `mediaTime({ ticks })`. Mirrors the
 * `Math.round((TICKS_PER_SECOND * fps.denominator) / fps.numerator)` recipe used
 * by frame-step/playhead nudge, with an explicit `frames`/`direction` factor.
 */
export function frameOffsetTicks({
	ticksPerSecond,
	fpsNumerator,
	fpsDenominator,
	frames = 1,
	direction = 1,
}: {
	ticksPerSecond: number;
	fpsNumerator: number;
	fpsDenominator: number;
	/** How many frames to move (defaults to a single frame). */
	frames?: number;
	/** `1` for forward (later), `-1` for backward (earlier). */
	direction?: 1 | -1;
}): number {
	const ticksPerFrame = Math.round(
		(ticksPerSecond * fpsDenominator) / fpsNumerator,
	);
	return ticksPerFrame * frames * direction;
}
