/**
 * Pause-swallowing boundary placement (round 6 U3): every removal edge lands
 * precisely, read off the waveform.
 *
 * The old trough snap (snap-cut.ts) RELOCATED a boundary to the quietest
 * window within 0.25s, which leaves the rest of the pause in the kept
 * footage: a cut placed inside a 1.5s pause ships ~0.7s of silence on each
 * side of the join (the live-test "silences at heads/tails"). This pass
 * WIDENS instead: each removal edge walks outward through contiguous
 * sub-threshold envelope windows and stops at the neighboring clean word's
 * boundary plus HANDLE_SEC of room tone, so the join carries a natural breath
 * and nothing more. Dan's bar (2026-07-17): no crossfades; a join that needs
 * one was cut wrong.
 *
 * Rules per removal edge:
 *  - Silence adjacent (the window just outside the boundary is sub-threshold):
 *    widen through the silence run, capped at the neighbor word boundary
 *    +/- HANDLE_SEC and at the audio edges. Only ever widen.
 *  - Speech adjacent: fall back to the trough snap (relocate within
 *    searchSec), exactly today's behavior; refineCutWordBounds downstream
 *    remains the word-safety backstop for those edges.
 *  - keep/reorder ops pass through untouched; an empty envelope is a
 *    pass-through; a widen that would invert keeps the original edge pair.
 *  - After widening, removals are clipped in time order so two cuts can never
 *    overlap (same invariant as snapRemovalOps).
 *
 * Pure + wasm-free, seconds in and out. `words` must be the CLEAN words
 * (post hallucination-guard) so silence-bleed text never blocks a swallow.
 */

import type { DirectorOp } from "@framecut/hf-bridge";
import { ENERGY_WINDOW_SEC } from "./audio-features";
import { DEFAULT_SNAP_SEARCH_SEC, nearestLowEnergyTime } from "./snap-cut";
import { SILENCE_RMS_CEILING } from "./hallucination-guard";

/** Room tone left between a widened cut edge and the neighboring word
 * (mirrors remove-silences PADDING_SEC). */
export const HANDLE_SEC = 0.15;

const isRemoval = (op: DirectorOp): boolean => op.op === "cut" || op.op === "take_select";

/**
 * Swallow the pauses around every removal's edges. See the module header.
 * `threshold` defaults to the fixed silence ceiling for callers that cannot
 * compute the adaptive clean-median (the keeper-swap path); the pipeline
 * passes the shared KTD1 threshold.
 */
export function swallowPauseBounds({
	ops,
	envelope,
	windowSec = ENERGY_WINDOW_SEC,
	threshold = SILENCE_RMS_CEILING,
	words,
	handleSec = HANDLE_SEC,
	searchSec = DEFAULT_SNAP_SEARCH_SEC,
}: {
	ops: readonly DirectorOp[];
	envelope: readonly number[];
	windowSec?: number;
	threshold?: number;
	/** CLEAN words (post hallucination-guard); the walk stops at word +/- handle. */
	words: readonly { start: number; end: number }[];
	handleSec?: number;
	searchSec?: number;
}): DirectorOp[] {
	if (envelope.length === 0) {
		return [...ops];
	}
	const audioEndSec = envelope.length * windowSec;
	const silent = (w: number): boolean =>
		w >= 0 && w < envelope.length && envelope[w] < threshold;

	const prevWordEnd = (t: number): number => {
		let best = Number.NEGATIVE_INFINITY;
		for (const w of words) {
			if (w.end <= t + 1e-6 && w.end > best) best = w.end;
		}
		return best;
	};
	const nextWordStart = (t: number): number => {
		let best = Number.POSITIVE_INFINITY;
		for (const w of words) {
			if (w.start >= t - 1e-6 && w.start < best) best = w.start;
		}
		return best;
	};

	const widened = ops.map((op) => {
		if (!isRemoval(op)) {
			return op;
		}
		let startSec = op.startSec;
		let endSec = op.endSec;

		// START edge: the window just BEFORE the boundary decides silence-vs-speech.
		const startWindow = Math.floor(startSec / windowSec) - 1;
		if (silent(startWindow)) {
			let w = startWindow;
			while (silent(w - 1)) w--;
			const silenceStartSec = w * windowSec;
			const prevEnd = prevWordEnd(op.startSec);
			const limit = prevEnd === Number.NEGATIVE_INFINITY ? 0 : prevEnd + handleSec;
			startSec = Math.min(op.startSec, Math.max(silenceStartSec, limit, 0));
		} else {
			startSec = Math.max(
				0,
				Math.min(
					audioEndSec,
					nearestLowEnergyTime({ envelope, windowSec, centerSec: startSec, searchSec }),
				),
			);
		}

		// END edge: the window just AFTER the boundary decides.
		const endWindow = Math.floor(endSec / windowSec);
		if (silent(endWindow)) {
			let w = endWindow;
			while (silent(w + 1)) w++;
			const silenceEndSec = Math.min((w + 1) * windowSec, audioEndSec);
			const nextStart = nextWordStart(op.endSec);
			const limit =
				nextStart === Number.POSITIVE_INFINITY ? audioEndSec : nextStart - handleSec;
			endSec = Math.max(op.endSec, Math.min(silenceEndSec, limit));
		} else {
			endSec = Math.max(
				0,
				Math.min(
					audioEndSec,
					nearestLowEnergyTime({ envelope, windowSec, centerSec: endSec, searchSec }),
				),
			);
		}

		if (endSec <= startSec) {
			return op; // the edge math inverted the range; keep the original
		}
		if (startSec === op.startSec && endSec === op.endSec) {
			return op; // byte-identical when nothing moved
		}
		return { ...op, startSec, endSec };
	});

	// Non-overlap invariant (same as snapRemovalOps): clip in time order, drop
	// any removal a predecessor swallowed entirely.
	const result = [...widened].sort((a, b) => a.startSec - b.startSec);
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
