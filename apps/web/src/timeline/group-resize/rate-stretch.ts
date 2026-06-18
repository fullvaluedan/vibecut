import {
	rateForTargetDuration,
	targetDurationForRate,
} from "@/retime/duration";

/**
 * Rate-Stretch (R) edge-drag math, in plain ticks.
 *
 * Premiere's Rate-Stretch tool: dragging a clip edge changes the clip's
 * playback RATE so its on-timeline length follows the cursor — the source
 * window (`trimStart`/`trimEnd`) stays fixed; only the speed changes. Pulling
 * the right edge outward slows the clip down (rate < 1); pushing it inward
 * speeds it up (rate > 1). The left edge does the same with the right edge
 * pinned, so the clip's end stays put and its start moves.
 *
 * Deliberately wasm-free (operates on plain tick numbers, reuses the wasm-free
 * `@/retime/duration` helpers) so it can be unit-tested under bun. The
 * MediaTime glue that turns this into resize updates lives in
 * `compute-rate-stretch.ts`.
 *
 * Returns `null` when the element has no usable source window (e.g. a
 * generated element with no `sourceDuration`) — such elements aren't
 * rate-stretchable and are left untouched by the caller.
 */
export interface RateStretchTargetArgs {
	side: "left" | "right";
	startTimeTicks: number;
	durationTicks: number;
	trimStartTicks: number;
	trimEndTicks: number;
	sourceDurationTicks: number;
	/** Drag delta along the dragged edge, already snapped, in ticks. */
	deltaTicks: number;
	/** End of the nearest clip to the left, or null if none. */
	leftNeighborBoundTicks: number | null;
	/** Start of the nearest clip to the right, or null if none. */
	rightNeighborBoundTicks: number | null;
	/** One-frame floor for the clip's on-timeline duration, in ticks. */
	minDurationTicks: number;
}

export interface RateStretchTarget {
	rate: number;
	newDurationTicks: number;
	newStartTimeTicks: number;
}

export function computeRateStretchTarget({
	side,
	startTimeTicks,
	durationTicks,
	trimStartTicks,
	trimEndTicks,
	sourceDurationTicks,
	deltaTicks,
	leftNeighborBoundTicks,
	rightNeighborBoundTicks,
	minDurationTicks,
}: RateStretchTargetArgs): RateStretchTarget | null {
	const sourceWindowTicks = sourceDurationTicks - trimStartTicks - trimEndTicks;
	if (!(sourceWindowTicks > 0)) return null;

	const endTicks = startTimeTicks + durationTicks;
	const minDuration = Math.max(1, Math.round(minDurationTicks));

	// The on-timeline duration the edge drag is asking for.
	let targetDuration =
		side === "right" ? durationTicks + deltaTicks : durationTicks - deltaTicks;

	// Clamp against the neighbour on the dragged side so the stretch never
	// overlaps an adjacent clip (v1 keeps the existing reject-overlap guard;
	// the overwrite edit model is a separate sub-unit).
	if (side === "right") {
		if (rightNeighborBoundTicks !== null) {
			targetDuration = Math.min(
				targetDuration,
				rightNeighborBoundTicks - startTimeTicks,
			);
		}
	} else {
		const leftFloor = leftNeighborBoundTicks ?? 0;
		targetDuration = Math.min(targetDuration, endTicks - leftFloor);
	}
	targetDuration = Math.max(minDuration, targetDuration);

	let rate = rateForTargetDuration({
		sourceWindowTicks,
		targetTicks: targetDuration,
	});
	let newDuration = Math.max(
		minDuration,
		Math.round(targetDurationForRate({ sourceWindowTicks, rate })),
	);

	if (side === "right") {
		return { rate, newDurationTicks: newDuration, newStartTimeTicks: startTimeTicks };
	}

	let newStartTime = endTicks - newDuration;
	if (newStartTime < 0) {
		// Rate saturated (clip would slow past the 0.01x floor) and now reaches
		// before 0:00 — pin the left edge to the sequence start and re-derive the
		// rate from the fixed [0, end] window.
		newDuration = Math.max(minDuration, endTicks);
		rate = rateForTargetDuration({ sourceWindowTicks, targetTicks: newDuration });
		newDuration = Math.max(
			minDuration,
			Math.round(targetDurationForRate({ sourceWindowTicks, rate })),
		);
		newStartTime = 0;
	}

	return { rate, newDurationTicks: newDuration, newStartTimeTicks: newStartTime };
}
