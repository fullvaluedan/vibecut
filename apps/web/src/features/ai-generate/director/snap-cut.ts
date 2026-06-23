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

/** A timeline span to KEEP (seconds) — Highlight mode's unit. */
export interface SnapSpan {
	startSec: number;
	endSec: number;
}

/**
 * Time (seconds) of the quietest envelope window with its MIDPOINT in [fromSec,toSec],
 * seeded at `centerSec`'s own window so it only moves to a STRICTLY quieter point (no
 * pointless sub-window jitter). Returns `centerSec` when the envelope is empty or the
 * boundary is already the local minimum. The shared core behind both the symmetric
 * removal snap and the directional keep snap.
 */
function quietestWindowTime({
	envelope,
	windowSec,
	centerSec,
	fromSec,
	toSec,
}: {
	envelope: readonly number[];
	windowSec: number;
	centerSec: number;
	fromSec: number;
	toSec: number;
}): number {
	if (envelope.length === 0 || !Number.isFinite(centerSec) || windowSec <= 0) {
		return centerSec;
	}
	const clampW = (w: number): number => Math.max(0, Math.min(envelope.length - 1, w));
	const from = clampW(Math.floor(fromSec / windowSec));
	const to = clampW(Math.ceil(toSec / windowSec));
	const centerW = clampW(Math.floor(centerSec / windowSec));
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
	if (searchSec <= 0) {
		return centerSec;
	}
	return quietestWindowTime({
		envelope,
		windowSec,
		centerSec,
		fromSec: centerSec - searchSec,
		toSec: centerSec + searchSec,
	});
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

/**
 * Snap a removal's edges OUT to a nearby CLIP edge so the cut doesn't leave a tiny
 * remnant of that clip (issue: 2-frame / 13-frame slivers the Director's cut left
 * at the start). When a removal's start sits just INSIDE a clip start, or its end
 * just inside a clip end, within `toleranceSec`, the boundary is extended to the
 * clip edge — the cut swallows the would-be sliver. Mirrors `silence-refine`'s
 * clip-edge snap (minus the video-protection, which the Director must not apply —
 * it removes content on purpose). Non-removal ops pass through.
 *
 * Conservative: only fires when the boundary is ALREADY within a remnant's length
 * of a clip edge, so it extends a removal by at most `toleranceSec` (a few frames)
 * to absorb the sliver — it never reaches across real kept content.
 */
export function snapRemovalsToClipEdges({
	ops,
	clipStartsSec,
	clipEndsSec,
	toleranceSec,
}: {
	ops: readonly DirectorOp[];
	clipStartsSec: readonly number[];
	clipEndsSec: readonly number[];
	toleranceSec: number;
}): DirectorOp[] {
	if (toleranceSec <= 0) {
		return [...ops];
	}
	return ops.map((op) => {
		if (!isRemoval(op)) {
			return op;
		}
		// Snap to the NEAREST qualifying clip edge, not the first one in array order:
		// clipStartsSec/clipEndsSec arrive in track/element order (main, then overlays),
		// NOT sorted by time, so "first within tolerance" could be the FARTHER edge and
		// over-cut the real content between two close clips.
		let startSec = op.startSec;
		let bestStartGap = Number.POSITIVE_INFINITY;
		for (const clipStart of clipStartsSec) {
			const gap = op.startSec - clipStart; // start sits just inside this clip start
			if (gap > 0 && gap <= toleranceSec && gap < bestStartGap) {
				bestStartGap = gap;
				startSec = clipStart;
			}
		}
		let endSec = op.endSec;
		let bestEndGap = Number.POSITIVE_INFINITY;
		for (const clipEnd of clipEndsSec) {
			const gap = clipEnd - op.endSec; // end sits just inside this clip end
			if (gap > 0 && gap <= toleranceSec && gap < bestEndGap) {
				bestEndGap = gap;
				endSec = clipEnd;
			}
		}
		return startSec !== op.startSec || endSec !== op.endSec
			? { ...op, startSec, endSec }
			: op;
	});
}

/**
 * Snap KEEP-span edges OUTWARD to nearby low-energy troughs (Highlight mode): a
 * span's start moves only to-or-BEFORE itself and its end only to-or-AFTER, so the
 * cuts AROUND the kept span land in the quiet while the span itself never shrinks
 * into a word (worst case it keeps a few frames more silence). Spans are clamped to
 * [0, audioEnd] and to their neighbours so they stay disjoint + ordered. Empty
 * envelope → pass-through. The directional opposite of `snapRemovalOps` — a removal
 * lands its edges on quiet by moving symmetrically; a keep does it by expanding.
 */
export function snapKeepSpans({
	spans,
	envelope,
	windowSec = ENERGY_WINDOW_SEC,
	searchSec = DEFAULT_SNAP_SEARCH_SEC,
}: {
	spans: readonly SnapSpan[];
	envelope: readonly number[];
	windowSec?: number;
	searchSec?: number;
}): SnapSpan[] {
	const cleaned = spans
		.filter((s) => s.endSec > s.startSec)
		.map((s) => ({ startSec: s.startSec, endSec: s.endSec }))
		.sort((a, b) => a.startSec - b.startSec);
	if (envelope.length === 0 || searchSec <= 0) {
		return cleaned;
	}
	const audioEndSec = envelope.length * windowSec;
	const out: SnapSpan[] = [];
	let prevEnd = 0;
	for (let i = 0; i < cleaned.length; i++) {
		const s = cleaned[i];
		// A span lying beyond the envelope's length can't be snapped meaningfully; clamping
		// it would collapse it to a zero-length (dropped) span. Pass it through unchanged.
		if (s.startSec >= audioEndSec) {
			out.push({ startSec: s.startSec, endSec: s.endSec });
			prevEnd = s.endSec;
			continue;
		}
		// Start: snap EARLIER into quiet, never before the previous span's end or 0.
		const rawStart = quietestWindowTime({
			envelope,
			windowSec,
			centerSec: s.startSec,
			fromSec: s.startSec - searchSec,
			toSec: s.startSec,
		});
		const startSec = Math.max(prevEnd, 0, Math.min(rawStart, s.startSec));
		// End: snap LATER into quiet, never past the next span's start or the audio end.
		const nextStart = i + 1 < cleaned.length ? cleaned[i + 1].startSec : audioEndSec;
		const rawEnd = quietestWindowTime({
			envelope,
			windowSec,
			centerSec: s.endSec,
			fromSec: s.endSec,
			toSec: s.endSec + searchSec,
		});
		const endSec = Math.min(nextStart, audioEndSec, Math.max(rawEnd, s.endSec));
		out.push({ startSec, endSec: Math.max(endSec, startSec) });
		prevEnd = out[out.length - 1].endSec;
	}
	return out;
}
