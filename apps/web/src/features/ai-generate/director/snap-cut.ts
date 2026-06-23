/**
 * Snap Director cut boundaries to nearby low-energy troughs (issue E).
 *
 * Director cuts are aligned to transcript SEGMENT edges, but a segment edge can
 * fall mid-word / mid-sound — the join then sounds abrupt (no breathing room).
 * This nudges each removal's start and end to the quietest envelope window within
 * a small search radius, so a cut begins and ends in the silence BETWEEN sounds.
 *
 * Pure + wasm-free → bun-testable. Operates on the SAME RMS energy envelope the
 * audio features + noise guard use (`computeEnergyEnvelope`). Reorder/keep ops are
 * never touched (a reorder MOVES a span; nudging its edges would misalign it).
 * Shared so the silence path can adopt it later — for now it softens the Director
 * cut path, which `remove-silences` (its own ±0.15s pad) does not feed.
 */

import type { DirectorOp } from "@framecut/hf-bridge";
import { ENERGY_WINDOW_SEC } from "./audio-features";

/** How far (seconds) on each side of a boundary to look for a quieter point. Small
 * so a cut never jumps into a different word — just to the adjacent inter-word gap. */
export const DEFAULT_SNAP_SEARCH_SEC = 0.1;

const isRemoval = (op: DirectorOp): boolean => op.op === "cut" || op.op === "take_select";

/**
 * Time (seconds) of the quietest envelope window within ±`searchSec` of `centerSec`.
 * Returns `centerSec` unchanged when the envelope is empty, the radius is zero, or
 * the boundary is ALREADY the local minimum (no pointless sub-window jitter).
 */
export function nearestLowEnergyTime({
	envelope,
	windowSec,
	centerSec,
	searchSec,
}: {
	envelope: readonly number[];
	windowSec: number;
	centerSec: number;
	searchSec: number;
}): number {
	if (envelope.length === 0 || searchSec <= 0) {
		return centerSec;
	}
	const clampW = (w: number): number => Math.max(0, Math.min(envelope.length - 1, w));
	const from = clampW(Math.floor((centerSec - searchSec) / windowSec));
	const to = clampW(Math.ceil((centerSec + searchSec) / windowSec));
	const centerW = clampW(Math.floor(centerSec / windowSec));
	// Seed with the boundary's own window so we only move to a STRICTLY quieter one.
	let bestW = centerW;
	let bestEnergy = envelope[centerW];
	for (let w = from; w <= to; w++) {
		if (envelope[w] < bestEnergy) {
			bestEnergy = envelope[w];
			bestW = w;
		}
	}
	if (bestW === centerW) {
		return centerSec;
	}
	// The midpoint of the quietest window — the calmest instant to cut on.
	return (bestW + 0.5) * windowSec;
}

/**
 * Snap each removal op's [startSec,endSec) to nearby low-energy troughs. Non-removal
 * ops pass through untouched. A snap that would invert/collapse a range keeps the
 * original. After snapping, removals are clipped in time order so a nudge can't make
 * two cuts overlap (a removal swallowed by its predecessor is dropped). With an empty
 * envelope this is a pass-through (no signal to snap to).
 */
export function snapRemovalOps({
	ops,
	envelope,
	windowSec = ENERGY_WINDOW_SEC,
	searchSec = DEFAULT_SNAP_SEARCH_SEC,
}: {
	ops: readonly DirectorOp[];
	envelope: readonly number[];
	windowSec?: number;
	searchSec?: number;
}): DirectorOp[] {
	if (envelope.length === 0) {
		return [...ops];
	}
	const audioEndSec = envelope.length * windowSec;
	const clampSec = (t: number): number => Math.max(0, Math.min(t, audioEndSec));

	const snapped = ops.map((op) => {
		if (!isRemoval(op)) {
			return op;
		}
		const startSec = clampSec(
			nearestLowEnergyTime({ envelope, windowSec, centerSec: op.startSec, searchSec }),
		);
		const endSec = clampSec(
			nearestLowEnergyTime({ envelope, windowSec, centerSec: op.endSec, searchSec }),
		);
		if (endSec <= startSec) {
			return op; // snapping inverted/collapsed the range — leave it as-is
		}
		return { ...op, startSec, endSec };
	});

	// Preserve the non-overlap invariant: a ±searchSec nudge could push a cut's start
	// before the previous cut's end. Clip in time order; drop any that collapse.
	const result = [...snapped].sort((a, b) => a.startSec - b.startSec);
	let prevRemovalEnd = Number.NEGATIVE_INFINITY;
	for (let i = 0; i < result.length; i++) {
		const op = result[i];
		if (!isRemoval(op)) {
			continue;
		}
		if (op.startSec < prevRemovalEnd) {
			result[i] = { ...op, startSec: Math.min(prevRemovalEnd, op.endSec) };
		}
		prevRemovalEnd = Math.max(prevRemovalEnd, result[i].endSec);
	}
	return result.filter((op) => !isRemoval(op) || op.endSec > op.startSec);
}
