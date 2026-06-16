/**
 * Ripple (B) edge-drag math, in plain ticks.
 *
 * Premiere's Ripple Edit tool: trimming one edge of a clip ALSO shifts every
 * downstream clip on the same track by the same timeline delta, so no gap or
 * overlap opens up — the timeline "ripples". Unlike a normal trim, ripple is
 * NOT clamped by neighbours (it pushes them out of the way); it is clamped only
 * by the clip's own source window and a one-frame minimum.
 *
 * Semantic choice (the clip stays anchored at its `startTime`):
 *   - The clip's own `startTimeTicks` is NEVER moved by the drag itself. The
 *     dragged clip is glued to its left position for BOTH edges.
 *   - Its `durationTicks` and source window (`trimStartTicks`/`trimEndTicks`)
 *     change per the drag.
 *   - Downstream clips shift by the resulting duration change (`rippleShift`),
 *     where "downstream" means clips whose `startTime >= rippleShiftBoundary`.
 *   - RIGHT edge: the boundary is the clip's ORIGINAL end (start + old
 *     duration); extending the clip pushes everything after it right, shortening
 *     pulls them left.
 *   - LEFT edge: the boundary is the clip's `startTime`; trimming more head
 *     shrinks the clip and pulls downstream left to close the gap, extending the
 *     head grows the clip and pushes downstream right. The clip itself sits at
 *     `startTime` so it does not move; only clips strictly after it ripple.
 *
 * Source-window math mirrors `group-resize/compute-resize.ts`
 * (`getSourceDeltaForClipDelta`): a timeline delta maps to a source delta via
 * the clip's playback `rate` (`sourceDelta = clipDelta * rate`). The invariant
 * `trimStart + duration * rate + trimEnd == sourceDuration` is preserved by
 * saturating trims to `[0, ∞)`, then shrinking `duration` if the visible source
 * span would exceed what the source actually contains.
 *
 * Deliberately wasm-free (operates on plain tick numbers + a plain `rate`
 * multiplier, default 1) so it can be unit-tested under bun. The element-patch
 * glue that turns this into resize/move updates and applies the downstream
 * shift lives in the controller integration (NOT here).
 *
 * Returns `null` when the element has no usable source window (e.g. a generated
 * element with `sourceDuration` 0/missing, or a fully collapsed source window)
 * — such elements aren't ripple-trimmable and are left untouched by the caller.
 */
export interface RippleTrimTargetArgs {
	side: "left" | "right";
	startTimeTicks: number;
	durationTicks: number;
	trimStartTicks: number;
	trimEndTicks: number;
	sourceDurationTicks: number;
	/** Drag delta along the dragged edge, already snapped, in ticks. */
	deltaTicks: number;
	/** Plain playback-rate multiplier (sourceDelta = clipDelta * rate). */
	rate?: number;
	/** One-frame floor for the clip's on-timeline duration, in ticks. */
	minDurationTicks: number;
}

export interface RippleTrimTarget {
	startTimeTicks: number;
	durationTicks: number;
	trimStartTicks: number;
	trimEndTicks: number;
	/** Clips with `startTime >= this` shift by `rippleShiftDeltaTicks`. */
	rippleShiftBoundaryTicks: number;
	/** Signed timeline shift applied to downstream clips, in ticks. */
	rippleShiftDeltaTicks: number;
}

export function computeRippleTrimTarget({
	side,
	startTimeTicks,
	durationTicks,
	trimStartTicks,
	trimEndTicks,
	sourceDurationTicks,
	deltaTicks,
	rate = 1,
	minDurationTicks,
}: RippleTrimTargetArgs): RippleTrimTarget | null {
	// A clip with no usable source window is not ripple-trimmable. Guards both
	// generated elements (sourceDuration 0/missing) and a fully collapsed window
	// (trimStart + trimEnd already consuming all the source).
	const visibleSourceTicks =
		sourceDurationTicks - trimStartTicks - trimEndTicks;
	if (!(sourceDurationTicks > 0) || !(visibleSourceTicks > 0)) return null;

	const safeRate = Number.isFinite(rate) && rate > 0 ? rate : 1;
	const minDuration = Math.max(1, Math.round(minDurationTicks));

	// The original boundary downstream clips ripple from. RIGHT: the clip's
	// original end; LEFT: the clip's (unchanged) start.
	const rippleShiftBoundaryTicks =
		side === "right" ? startTimeTicks + durationTicks : startTimeTicks;

	// Degenerate / no-op drag: return the clip untouched with zero ripple.
	if (deltaTicks === 0) {
		return {
			startTimeTicks,
			durationTicks,
			trimStartTicks,
			trimEndTicks,
			rippleShiftBoundaryTicks,
			rippleShiftDeltaTicks: 0,
		};
	}

	// The trim on the NON-dragged side is fixed; only the dragged side flexes.
	const fixedTrim = side === "right" ? trimStartTicks : trimEndTicks;

	// Step 1: requested on-timeline duration. RIGHT +delta extends, LEFT +delta
	// trims the head (shortens). Negative deltas do the reverse.
	let newDuration =
		side === "right" ? durationTicks + deltaTicks : durationTicks - deltaTicks;

	// Step 2: floor at one frame.
	newDuration = Math.max(minDuration, newDuration);

	// Step 3: source-extent ceiling. With the non-dragged trim fixed, the visible
	// span (newDuration * rate) can grow only until the dragged trim hits 0, i.e.
	// until it reaches `sourceDuration - fixedTrim`. Shrink duration to fit.
	const maxVisibleSource = sourceDurationTicks - fixedTrim;
	const maxDurationForSource = Math.floor(maxVisibleSource / safeRate);
	if (newDuration > maxDurationForSource) {
		newDuration = maxDurationForSource;
	}

	// Step 4: re-floor at one frame (in case the source-extent clamp undercut it).
	newDuration = Math.max(minDuration, newDuration);

	// Step 5: derive the dragged-side trim. It moves by the ACTUAL (clamped)
	// source delta — `(newDuration - oldDuration) * rate` — so shortening returns
	// the freed source to the trim and extending consumes it; tracking the
	// clamped change (not the raw requested delta) keeps the result correct when
	// minDuration or the source-extent ceiling bit. The result is then clamped
	// into `[0, sourceDuration - fixedTrim - newDuration*rate]`: the lower bound
	// keeps trims non-negative, the upper bound is the source-extent invariant
	// (`trimStart + duration*rate + trimEnd <= sourceDuration`) and forces the
	// dragged trim to 0 when the clip has been extended to fill all the source on
	// that side.
	const oldDraggedTrim = side === "right" ? trimEndTicks : trimStartTicks;
	const actualSourceDelta = (newDuration - durationTicks) * safeRate;
	const draggedTrimCeiling = Math.max(
		0,
		Math.round(sourceDurationTicks - fixedTrim - newDuration * safeRate),
	);
	const draggedTrim = Math.min(
		draggedTrimCeiling,
		Math.max(0, Math.round(oldDraggedTrim - actualSourceDelta)),
	);

	const newTrimStart = side === "right" ? trimStartTicks : draggedTrim;
	const newTrimEnd = side === "right" ? draggedTrim : trimEndTicks;

	// Step 6: the signed timeline shift for downstream clips.
	const rippleShiftDeltaTicks = newDuration - durationTicks;

	return {
		startTimeTicks,
		durationTicks: newDuration,
		trimStartTicks: newTrimStart,
		trimEndTicks: newTrimEnd,
		rippleShiftBoundaryTicks,
		rippleShiftDeltaTicks,
	};
}
