import { clampRetimeRate } from "@/retime/rate";

/**
 * Roll (N) cut-drag math, in plain ticks.
 *
 * Premiere's Roll tool: dragging the cut between two ADJACENT clips moves the
 * edit point without rippling the rest of the timeline. The left clip A and the
 * right clip B share a boundary (`A.startTime + A.duration == B.startTime`).
 * Dragging the cut by +delta (timeline ticks) grows A from its tail
 * (`duration += delta`, `trimEnd` shrinks by the source-equivalent) and shrinks
 * B from its head (`startTime += delta`, `duration -= delta`, `trimStart` grows
 * by the source-equivalent). -delta is the mirror. The pair's combined span and
 * every other clip on the timeline are unchanged — A's start and B's end stay
 * pinned, so this never ripples.
 *
 * Retime-aware: under a clip with playback rate R, a timeline span of T ticks
 * consumes T * R source ticks (mirroring `getSourceTimeAtClipTime`). Each clip
 * consumes source at its OWN rate, so the same timeline delta produces a
 * different source delta on each side: A consumes `delta * rateA` from its
 * `trimEnd`, B consumes `delta * rateB` onto its `trimStart`.
 *
 * Deliberately wasm-free (operates on plain tick numbers, reuses only the
 * wasm-free `clampRetimeRate` from `@/retime/rate`) so it can be unit-tested
 * under bun without pulling in the opencut-wasm binary. The glue that turns
 * these new bounds into element patches lives in the controller and is not this
 * helper's concern.
 *
 * Clamping (saturate, never throw): `delta` is clamped globally to the tightest
 * of four bounds — A's right-side source (`A.trimEnd / rateA`), A's minimum
 * duration, B's left-side source (`B.trimStart / rateB`) and B's minimum
 * duration — then both clips are derived from that single clamped delta. If the
 * clips are not adjacent (a gap or overlap), Roll does not apply and the helper
 * returns `null`. If the pair is fully bottlenecked (no room to move in either
 * direction), the clips' original values are returned unchanged.
 */
export interface RollTargetArgs {
	clipAStartTimeTicks: number;
	clipADurationTicks: number;
	clipATrimStartTicks: number;
	clipATrimEndTicks: number;
	clipASourceDurationTicks: number;
	/** Left clip playback rate; defaults to 1x. Clamped to [0.01, 5]. */
	clipARate?: number;
	clipBStartTimeTicks: number;
	clipBDurationTicks: number;
	clipBTrimStartTicks: number;
	clipBTrimEndTicks: number;
	clipBSourceDurationTicks: number;
	/** Right clip playback rate; defaults to 1x. Clamped to [0.01, 5]. */
	clipBRate?: number;
	/** Cut-drag delta along the timeline, already snapped, in ticks. */
	deltaTicks: number;
	/** One-frame floor for each clip's on-timeline duration, in ticks. */
	minDurationTicks: number;
}

export interface RollTarget {
	clipAStartTimeTicks: number;
	clipADurationTicks: number;
	clipATrimStartTicks: number;
	clipATrimEndTicks: number;
	clipBStartTimeTicks: number;
	clipBDurationTicks: number;
	clipBTrimStartTicks: number;
	clipBTrimEndTicks: number;
}

export function computeRollTarget({
	clipAStartTimeTicks,
	clipADurationTicks,
	clipATrimStartTicks,
	clipATrimEndTicks,
	clipARate = 1,
	clipBStartTimeTicks,
	clipBDurationTicks,
	clipBTrimStartTicks,
	clipBTrimEndTicks,
	clipBRate = 1,
	deltaTicks,
	minDurationTicks,
}: RollTargetArgs): RollTarget | null {
	// Note: clipA/BSourceDurationTicks are part of the args for API completeness
	// (the wiring passes full clip state) but are not needed for clamping — roll
	// is source-conserving, so the trim + duration + rate bounds suffice.
	// Adjacency is a pre-flight check, not a saturating bound: Roll only makes
	// sense when A ends exactly where B begins. A gap or an overlap means the
	// pair is not rollable, so signal "not applicable" with null rather than
	// masking the caller's stale-data bug by returning unchanged clips.
	if (clipAStartTimeTicks + clipADurationTicks !== clipBStartTimeTicks) {
		return null;
	}

	const safeRateA = clampRetimeRate({ rate: clipARate });
	const safeRateB = clampRetimeRate({ rate: clipBRate });
	const minDuration = Math.max(1, Math.round(minDurationTicks));

	// Build the global delta window. The tightest bound on each side wins.
	//
	// Positive delta (cut moves right): A grows — capped by A's spare source
	// past its out-point (trimEnd / rateA) — and B shrinks — capped by B's
	// minimum duration.
	const maxDelta = Math.min(
		clipATrimEndTicks / safeRateA,
		clipBDurationTicks - minDuration,
	);
	// Negative delta (cut moves left): A shrinks — capped by A's minimum
	// duration — and B grows leftward — capped by B's spare source before its
	// in-point (trimStart / rateB).
	const minDelta = Math.max(
		minDuration - clipADurationTicks,
		-(clipBTrimStartTicks / safeRateB),
	);

	// If the window is empty (both clips bottlenecked from opposite sides) the
	// roll is blocked entirely; saturate to zero movement and return unchanged.
	const clampedDelta =
		minDelta > maxDelta ? 0 : Math.max(minDelta, Math.min(deltaTicks, maxDelta));

	// Derive each clip's source consumption from the single clamped delta so the
	// invariant `trimStart + visibleSourceSpan + trimEnd == sourceDuration` is
	// preserved on each side by construction.
	const sourceDeltaA = Math.round(clampedDelta * safeRateA);
	const sourceDeltaB = Math.round(clampedDelta * safeRateB);

	// A's start is pinned; it grows/shrinks from the tail and gives up trimEnd.
	const newAStartTime = clipAStartTimeTicks;
	const newADuration = clipADurationTicks + clampedDelta;
	const newATrimEnd = Math.max(0, clipATrimEndTicks - sourceDeltaA);

	// B's end is pinned; it moves its head and takes on trimStart.
	const newBStartTime = clipBStartTimeTicks + clampedDelta;
	const newBDuration = clipBDurationTicks - clampedDelta;
	const newBTrimStart = Math.max(0, clipBTrimStartTicks + sourceDeltaB);

	return {
		clipAStartTimeTicks: newAStartTime,
		clipADurationTicks: newADuration,
		clipATrimStartTicks: clipATrimStartTicks,
		clipATrimEndTicks: newATrimEnd,
		clipBStartTimeTicks: newBStartTime,
		clipBDurationTicks: newBDuration,
		clipBTrimStartTicks: newBTrimStart,
		clipBTrimEndTicks: clipBTrimEndTicks,
	};
}
