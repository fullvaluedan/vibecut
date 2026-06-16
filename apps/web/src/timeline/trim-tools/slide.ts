import { clampRetimeRate } from "@/retime/rate";

/**
 * Slide (U) body-drag math, in plain ticks.
 *
 * Premiere's Slide tool: dragging a clip's INTERIOR moves the clip ALONG the
 * timeline between its two immediate neighbours while the clip's own content
 * (its `trimStart`/`trimEnd`/`duration`) stays FIXED — the clip is shuttled
 * left/right and the two neighbours absorb the move. The trio's combined span
 * (left.start .. right.end) is unchanged, so nothing downstream ripples.
 *
 * Dragging by +delta (timeline ticks) slides the clip RIGHT:
 *   - the CLIP just moves: `startTime += delta` (trim/duration untouched);
 *   - the LEFT neighbour GROWS from its tail to follow the clip's new start:
 *     `duration += delta`, and it consumes that much of its OWN tail source so
 *     `trimEnd -= delta * leftRate` (its `startTime`/`trimStart` are pinned).
 *     (The prior helper had this backwards — it SHRANK the left neighbour on a
 *     slide-right. The correct behaviour is to GROW it.)
 *   - the RIGHT neighbour SHRINKS from its head: `startTime += delta`,
 *     `duration -= delta`, and it gives up that much of its head source so
 *     `trimStart += delta * rightRate` (its `trimEnd` is pinned).
 * -delta (slide LEFT) is the exact mirror: the left neighbour shrinks (handing
 * its tail source back), the right neighbour grows (reclaiming head source).
 *
 * Retime-aware: under a neighbour with playback rate R, a timeline span of T
 * ticks consumes T * R source ticks (mirroring `getSourceTimeAtClipTime`). Each
 * neighbour consumes source at its OWN rate, so the same clamped timeline delta
 * maps to a different source delta on each side.
 *
 * Clamping (saturate, never throw): `deltaTicks` is clamped to a SINGLE global
 * window, then all three clips are derived from that one clamped delta so every
 * invariant holds by construction.
 *   - maxDelta (slide right) is the tightest of the present neighbours':
 *       · the LEFT neighbour can only grow while it still has tail source to
 *         consume — `leftTrimEnd / leftRate`;
 *       · the RIGHT neighbour can only shrink down to its minimum duration —
 *         `rightDuration - minDuration`.
 *   - minDelta (slide left, negative) is the loosest (max) of:
 *       · the LEFT neighbour shrinking only to its minimum duration —
 *         `-(leftDuration - minDuration)`;
 *       · the RIGHT neighbour growing only while it has head source to reclaim —
 *         `-(rightTrimStart / rightRate)`.
 * A MISSING neighbour (the clip sits at a track edge) simply drops its bound
 * from the window — the slide is then bounded only by the present neighbour. If
 * BOTH neighbours are missing there is nothing to absorb the move, so the helper
 * returns `null`. It also returns `null` when a supplied neighbour is not
 * actually adjacent (left.end != clip.start, or right.start != clip.end) — that
 * signals a stale-data bug in the caller rather than a slideable trio.
 *
 * Source-overshoot discipline (the adversarial finding from the prior build):
 * even after the global clamp, each neighbour's resulting `trimStart`/`trimEnd`
 * is re-clamped into its own source window `[0, sourceDuration]` (and floored at
 * 0) at construction, so a rounding edge or a pre-trimmed neighbour can never
 * push a trim past the source or below zero. The source delta is the CLAMPED
 * timeline delta times that neighbour's rate.
 *
 * Deliberately wasm-free (operates on plain tick numbers, reuses only the
 * wasm-free `clampRetimeRate` from `@/retime/rate`) so it can be unit-tested
 * under bun without pulling in the opencut-wasm binary. The element-patch glue
 * that turns these new bounds into `updateElements` patches lives in the
 * controller, NOT this helper.
 */
export interface SlideNeighbor {
	startTimeTicks: number;
	durationTicks: number;
	trimStartTicks: number;
	trimEndTicks: number;
	/** Full source length; bounds the trim window. Optional for completeness. */
	sourceDurationTicks?: number;
	/** Playback-rate multiplier; sourceDelta = clampedDelta * rate. Default 1. */
	rate?: number;
}

export interface SlideNeighborResult {
	startTimeTicks: number;
	durationTicks: number;
	trimStartTicks: number;
	trimEndTicks: number;
}

export interface SlideTargetArgs {
	clip: {
		startTimeTicks: number;
		durationTicks: number;
	};
	left?: SlideNeighbor | null;
	right?: SlideNeighbor | null;
	/** Body-drag delta along the timeline, already snapped, in ticks. */
	deltaTicks: number;
	/** One-frame floor for a neighbour's on-timeline duration, in ticks. */
	minDurationTicks: number;
}

export interface SlideTargetResult {
	/** The clip's new on-timeline start (its trim/duration are unchanged). */
	startTimeTicks: number;
	left: SlideNeighborResult | null;
	right: SlideNeighborResult | null;
}

/** Clamp a trim value into its neighbour's source window `[0, sourceDuration]`. */
function clampTrim({
	trim,
	sourceDurationTicks,
}: {
	trim: number;
	sourceDurationTicks?: number;
}): number {
	const lower = Math.max(0, trim);
	return sourceDurationTicks == null
		? lower
		: Math.min(lower, Math.max(0, sourceDurationTicks));
}

export function computeSlideTarget({
	clip,
	left,
	right,
	deltaTicks,
	minDurationTicks,
}: SlideTargetArgs): SlideTargetResult | null {
	// Nothing can absorb the move if the clip sits between two track edges.
	if (!left && !right) {
		return null;
	}

	const clipStart = clip.startTimeTicks;
	const clipEnd = clip.startTimeTicks + clip.durationTicks;

	// Adjacency is a pre-flight check, not a saturating bound: a supplied
	// neighbour must actually touch the clip. A gap/overlap means the caller's
	// data is stale, so signal "not applicable" with null rather than masking it.
	if (left && left.startTimeTicks + left.durationTicks !== clipStart) {
		return null;
	}
	if (right && right.startTimeTicks !== clipEnd) {
		return null;
	}

	const minDuration = Math.max(1, Math.round(minDurationTicks));
	const leftRate = left ? clampRetimeRate({ rate: left.rate ?? 1 }) : 1;
	const rightRate = right ? clampRetimeRate({ rate: right.rate ?? 1 }) : 1;

	// Build the global delta window. A missing neighbour drops its bound, so the
	// slide is bounded by the present side only (Infinity is the no-op identity
	// for Math.min/Math.max here).
	//
	// Positive delta (slide right): the LEFT neighbour grows — capped by its
	// spare tail source (trimEnd / leftRate) — and the RIGHT neighbour shrinks —
	// capped by its minimum duration.
	const maxDelta = Math.min(
		left ? left.trimEndTicks / leftRate : Number.POSITIVE_INFINITY,
		right ? right.durationTicks - minDuration : Number.POSITIVE_INFINITY,
	);
	// Negative delta (slide left): the LEFT neighbour shrinks — capped by its
	// minimum duration — and the RIGHT neighbour grows — capped by its spare head
	// source (trimStart / rightRate).
	const minDelta = Math.max(
		left ? minDuration - left.durationTicks : Number.NEGATIVE_INFINITY,
		right ? -(right.trimStartTicks / rightRate) : Number.NEGATIVE_INFINITY,
	);

	// If the window is empty (both sides bottlenecked from opposite directions)
	// the slide is blocked entirely; saturate to zero movement.
	const clampedDelta =
		minDelta > maxDelta
			? 0
			: Math.max(minDelta, Math.min(deltaTicks, maxDelta));

	// Each neighbour consumes source at its OWN rate from the single clamped delta
	// so the source-conservation invariant holds on each side by construction.
	const leftSourceDelta = Math.round(clampedDelta * leftRate);
	const rightSourceDelta = Math.round(clampedDelta * rightRate);

	const leftResult: SlideNeighborResult | null = left
		? {
				// Left start + trimStart are pinned; it grows/shrinks from the tail and
				// consumes/returns tail source (trimEnd). Re-clamp trimEnd into the
				// source window so a pre-trimmed neighbour or a rounding edge can never
				// push it past the source or below 0 (the source-overshoot clamp).
				startTimeTicks: left.startTimeTicks,
				durationTicks: left.durationTicks + clampedDelta,
				trimStartTicks: left.trimStartTicks,
				trimEndTicks: clampTrim({
					trim: left.trimEndTicks - leftSourceDelta,
					sourceDurationTicks: left.sourceDurationTicks,
				}),
			}
		: null;

	const rightResult: SlideNeighborResult | null = right
		? {
				// Right trimEnd is pinned; its head moves and it gives up/takes back head
				// source (trimStart). Re-clamp trimStart into the source window for the
				// same source-overshoot discipline.
				startTimeTicks: right.startTimeTicks + clampedDelta,
				durationTicks: right.durationTicks - clampedDelta,
				trimStartTicks: clampTrim({
					trim: right.trimStartTicks + rightSourceDelta,
					sourceDurationTicks: right.sourceDurationTicks,
				}),
				trimEndTicks: right.trimEndTicks,
			}
		: null;

	return {
		startTimeTicks: clip.startTimeTicks + clampedDelta,
		left: leftResult,
		right: rightResult,
	};
}
