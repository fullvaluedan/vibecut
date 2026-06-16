import { clampRetimeRate } from "@/retime/rate";

/**
 * Slip (Y) body-drag math, in plain ticks.
 *
 * Premiere's Slip tool: dragging a clip's INTERIOR slides the SOURCE window under
 * the clip while the clip's on-timeline position (`startTime`) and `duration`
 * stay FIXED — the footage shifts, the clip does not. Because the on-timeline
 * `duration` is fixed, the visible source span (`duration * rate`) is also fixed;
 * only the in/out point (`trimStart`/`trimEnd`) slides along the source.
 *
 * Dragging by +delta (timeline ticks) reveals LATER footage: `trimStart` grows by
 * the source-equivalent and `trimEnd` shrinks by the same amount (the visible
 * window walks forward through the source). -delta is the mirror — `trimStart`
 * shrinks toward 0 and `trimEnd` grows. The pair stays balanced so the invariant
 * `trimStart + duration * rate + trimEnd == sourceDuration` holds throughout.
 *
 * Retime-aware: under a clip with playback rate R, a timeline span of T ticks
 * consumes T * R source ticks (mirroring `getSourceTimeAtClipTime`). So a timeline
 * drag of `deltaTicks` moves the source window by `deltaTicks * R`.
 *
 * Clamping (saturate, never throw): the freed window is
 * `windowSize = sourceDuration - duration * rate` — the total slack between the
 * source's length and what the fixed visible span consumes. `trimStart` is the
 * slider into that window, clamped to `[0, max(0, windowSize)]`:
 *   - the LOWER clamp (0) stops a -delta drag once the window's head reaches the
 *     start of the source (`trimStart` hits 0, `trimEnd` hits `windowSize`);
 *   - the UPPER clamp (`windowSize`) stops a +delta drag once the window's tail
 *     reaches the end of the source (`trimStart` hits `windowSize`, `trimEnd`
 *     hits 0). This upper clamp is the fix the prior helper lacked: without it an
 *     out-of-range +delta would push `trimStart` past the source and force a
 *     NEGATIVE visible span. With it, the visible span stays exactly
 *     `duration * rate` and is never negative.
 * `trimEnd` is then derived from the ACTUAL clamped shift (`newTrimStart -
 * trimStartTicks`) so the two move by the same source amount even when a clamp
 * bit; a final `Math.max(0, ...)` on `trimEnd` is a safety net against rounding.
 *
 * Deliberately wasm-free (operates on plain tick numbers, reuses only the
 * wasm-free `clampRetimeRate` from `@/retime/rate`) so it can be unit-tested under
 * bun without pulling in the opencut-wasm binary. The element-patch glue that
 * turns the new in/out point into an `updateElements` trim patch (and which never
 * touches `startTime`/`duration`) lives in the controller, NOT this helper.
 */
export interface SlipTargetArgs {
	trimStartTicks: number;
	trimEndTicks: number;
	sourceDurationTicks: number;
	durationTicks: number;
	/** Body-drag delta along the timeline, already snapped, in ticks. */
	deltaTicks: number;
	/** Plain playback-rate multiplier (sourceDelta = deltaTicks * rate). */
	rate?: number;
}

export interface SlipTarget {
	trimStartTicks: number;
	trimEndTicks: number;
}

export function computeSlipTarget({
	trimStartTicks,
	trimEndTicks,
	sourceDurationTicks,
	durationTicks,
	deltaTicks,
	rate = 1,
}: SlipTargetArgs): SlipTarget {
	const safeRate = clampRetimeRate({ rate });

	// The timeline drag maps to a source shift via the clip's playback rate.
	const sourceDelta = Math.round(deltaTicks * safeRate);

	// The freed window: total source slack once the FIXED visible span
	// (duration * rate) is accounted for. `trimStart` can range over [0, window];
	// at window the source's tail is reached and `trimEnd` hits 0. Guard against a
	// negative window (a clip whose visible span already exceeds its source) by
	// flooring the upper bound at 0 so the clamp degenerates to "pin at 0".
	const windowSize = sourceDurationTicks - durationTicks * safeRate;
	const maxTrimStart = Math.max(0, windowSize);

	// Slide the in-point and UPPER-clamp it so an out-of-range delta can never
	// push the visible span negative (the missing-clamp bug the prior helper had).
	const newTrimStart = Math.min(
		maxTrimStart,
		Math.max(0, trimStartTicks + sourceDelta),
	);

	// Derive the out-point from the ACTUAL clamped shift so both ends move by the
	// same source amount even when a clamp bit; `Math.max(0, ...)` is a rounding
	// safety net (the clamp above already keeps it non-negative in exact math).
	const actualShift = newTrimStart - trimStartTicks;
	const newTrimEnd = Math.max(0, trimEndTicks - actualShift);

	return {
		trimStartTicks: newTrimStart,
		trimEndTicks: newTrimEnd,
	};
}
