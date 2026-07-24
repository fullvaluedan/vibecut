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
 *  - After widening, removals are clipped so two cuts can never overlap (same
 *    invariant as snapRemovalOps), but NOT by raw time order alone (round 12):
 *    every widen walk only looks at words/keepers, never at neighboring ops,
 *    so two removals on opposite sides of one pause can both widen into the
 *    same silence and land overlapping. DEFAULT-ACCEPTED removals resolve
 *    against each other FIRST, in start order, exactly as before this fix
 *    (byte-identical whenever nothing here is OFFERED). Their territory is
 *    then frozen; a never-auto-applied OFFERED row (retake/structural/lexical
 *    backstop) is trimmed against that frozen territory afterward, so a
 *    recall row a user may never accept can no longer silently erase an
 *    accepted cut just because it happened to sort earlier by raw start time
 *    (the join-the-group diagnostic: an OFFERED retake row swallowed the
 *    accepted pacing cut over a real 3.4s dead pause, leaving nothing AUTO
 *    over it). OFFERED-vs-OFFERED overlaps still resolve by start order among
 *    themselves, unchanged.
 *
 * Pure + wasm-free, seconds in and out. `words` must be the CLEAN words
 * (post hallucination-guard) so silence-bleed text never blocks a swallow.
 */

import type { DirectorOp } from "@framecut/hf-bridge";
import { ENERGY_WINDOW_SEC } from "./audio-features";
import { DEFAULT_SNAP_SEARCH_SEC, nearestLowEnergyTime } from "./snap-cut";
import { SILENCE_RMS_CEILING } from "./hallucination-guard";
import { stableCutId } from "./cut-utils";

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
	keepers = [],
	handleSec = HANDLE_SEC,
	searchSec = DEFAULT_SNAP_SEARCH_SEC,
}: {
	ops: readonly DirectorOp[];
	envelope: readonly number[];
	windowSec?: number;
	threshold?: number;
	/** CLEAN words (post hallucination-guard); the walk stops at word +/- handle.
	 * EMPTY words = degraded transcript: no widening at all (bounded trough snap
	 * only), since an uncapped walk could swallow a whole quiet region. */
	words: readonly { start: number; end: number }[];
	/** Protected spans the walk must never enter (emphasis-pause keepers: the
	 * word-FREE beats merge-time protection preserved; words alone cannot stop
	 * a walk through them). */
	keepers?: readonly { startSec: number; endSec: number }[];
	handleSec?: number;
	searchSec?: number;
}): DirectorOp[] {
	if (envelope.length === 0) {
		return [...ops];
	}
	const audioEndSec = envelope.length * windowSec;
	const silent = (w: number): boolean =>
		w >= 0 && w < envelope.length && envelope[w] < threshold;
	const widenAllowed = words.length > 0;

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
	const prevKeeperEnd = (t: number): number => {
		let best = Number.NEGATIVE_INFINITY;
		for (const k of keepers) {
			if (k.endSec <= t + 1e-6 && k.endSec > best) best = k.endSec;
		}
		return best;
	};
	const nextKeeperStart = (t: number): number => {
		let best = Number.POSITIVE_INFINITY;
		for (const k of keepers) {
			if (k.startSec >= t - 1e-6 && k.startSec < best) best = k.startSec;
		}
		return best;
	};

	const widened = ops.map((op) => {
		if (!isRemoval(op)) {
			return op;
		}
		let startSec = op.startSec;
		let endSec = op.endSec;

		// Edges already flush at the timeline/audio extremes stay put: the
		// envelope-dead-air detector cuts leading silence from 0 and trailing
		// silence to totalSec by design, and an out-of-range window would read
		// as "speech" and let the fallback snap pull the flush edge back in.
		const startAtEdge = startSec <= 1e-6;
		const endAtEdge = endSec >= audioEndSec - 1e-6;

		// START edge: the window containing the instant just BEFORE the boundary
		// decides silence-vs-speech (floor(start/win) - 1 skipped the boundary's
		// own window whenever start was not window-aligned, jumping the walk
		// over un-inspected audio).
		if (!startAtEdge) {
			const preWindow = Math.floor((startSec - 1e-9) / windowSec);
			if (widenAllowed && silent(preWindow)) {
				let w = preWindow;
				while (silent(w - 1)) w--;
				const silenceStartSec = w * windowSec;
				const prevEnd = prevWordEnd(op.startSec);
				const wordLimit = prevEnd === Number.NEGATIVE_INFINITY ? 0 : prevEnd + handleSec;
				const keeperLimit = prevKeeperEnd(op.startSec);
				const limit = Math.max(
					wordLimit,
					keeperLimit === Number.NEGATIVE_INFINITY ? 0 : keeperLimit,
				);
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
		}

		// END edge: the window just AFTER the boundary decides.
		if (!endAtEdge) {
			const endWindow = Math.floor(endSec / windowSec);
			if (widenAllowed && silent(endWindow)) {
				let w = endWindow;
				while (silent(w + 1)) w++;
				const silenceEndSec = Math.min((w + 1) * windowSec, audioEndSec);
				const nextStart = nextWordStart(op.endSec);
				const wordLimit =
					nextStart === Number.POSITIVE_INFINITY ? audioEndSec : nextStart - handleSec;
				const keeperLimit = nextKeeperStart(op.endSec);
				endSec = Math.max(op.endSec, Math.min(silenceEndSec, wordLimit, keeperLimit));
			} else {
				endSec = Math.max(
					0,
					Math.min(
						audioEndSec,
						nearestLowEnergyTime({ envelope, windowSec, centerSec: endSec, searchSec }),
					),
				);
			}
		}

		if (endSec <= startSec) {
			return op; // the edge math inverted the range; keep the original
		}
		if (startSec === op.startSec && endSec === op.endSec) {
			return op; // byte-identical when nothing moved
		}
		return { ...op, startSec, endSec };
	});

	// Non-overlap invariant (same as snapRemovalOps): clip in start order, drop
	// any removal a predecessor swallowed entirely. Extracted so it can run
	// TWICE below (round 12): once over accepted-only removals (byte-identical
	// to the old single pass whenever every removal is accepted), once over
	// offered-only removals after they have been trimmed against the accepted
	// result.
	const clipByStartOrder = (list: DirectorOp[]): DirectorOp[] => {
		const sorted = [...list].sort((a, b) => a.startSec - b.startSec);
		let prevEnd = Number.NEGATIVE_INFINITY;
		for (let i = 0; i < sorted.length; i++) {
			const op = sorted[i];
			if (op.startSec < prevEnd) {
				sorted[i] = { ...op, startSec: Math.min(prevEnd, op.endSec) };
			}
			prevEnd = Math.max(prevEnd, sorted[i].endSec);
		}
		return sorted.filter((op) => op.endSec > op.startSec);
	};

	const nonRemovals = widened.filter((op) => !isRemoval(op));
	const removals = widened.filter(isRemoval);
	const isAccepted = (op: DirectorOp): boolean => op.defaultAccept !== false;
	// Pass 1: DEFAULT-ACCEPTED removals only, resolved exactly like the old
	// single pass. This is the ENTIRE algorithm whenever nothing here is
	// OFFERED, so a plan with no retake/structural/backstop rows nearby is
	// untouched by this change.
	const acceptedRemovals = clipByStartOrder(removals.filter(isAccepted));
	// Pass 2: SUBTRACT the now-frozen accepted territory from each OFFERED
	// removal before letting offered rows fight over what is left. The accepted
	// islands are disjoint and start-sorted (clipByStartOrder above), so one
	// offered interval can survive as ZERO sub-spans (fully covered by accepted
	// cuts), ONE (untouched, or trimmed on a side), or MANY (it spanned the GAPS
	// between two or more accepted islands: offered [3,20] minus accepted [0,5]
	// and [10,15] leaves BOTH [5,10] and [15,20]). The old single-span return
	// could not express that many-survivor answer and silently discarded every
	// remainder past the first, erasing a survivor that overlapped nothing.
	// Each surviving sub-span is a clone of the offered op. A single untouched or
	// single-side-trimmed survivor keeps the original id (byte-identical to the
	// pre-fix behavior); a multi-span result re-keys every clone on its own
	// coordinates so the ids stay deterministic AND distinct (mirrors
	// stableCutId's coordinate keying; the `.s<hash>` suffix keeps the original
	// id family so id-prefix consumers still recognize it).
	const subtractAccepted = (op: DirectorOp): DirectorOp[] => {
		const survivors: { startSec: number; endSec: number }[] = [];
		let cursor = op.startSec;
		for (const acc of acceptedRemovals) {
			if (acc.endSec <= cursor) continue; // entirely behind the cursor
			if (acc.startSec >= op.endSec) break; // past the offered interval
			if (acc.startSec > cursor) {
				survivors.push({ startSec: cursor, endSec: Math.min(acc.startSec, op.endSec) });
			}
			cursor = Math.max(cursor, acc.endSec);
			if (cursor >= op.endSec) break;
		}
		if (cursor < op.endSec) {
			survivors.push({ startSec: cursor, endSec: op.endSec });
		}
		const kept = survivors.filter((s) => s.endSec > s.startSec);
		if (
			kept.length === 1 &&
			kept[0].startSec === op.startSec &&
			kept[0].endSec === op.endSec
		) {
			return [op]; // nothing accepted touched this interval: unchanged
		}
		if (kept.length <= 1) {
			// Zero survivors (fully swallowed) or a single-side trim: same id as
			// the old single-span path emitted.
			return kept.map((s) => ({ ...op, startSec: s.startSec, endSec: s.endSec }));
		}
		return kept.map((s) => ({
			...op,
			id: `${op.id}.s${stableCutId(`${s.startSec.toFixed(3)}:${s.endSec.toFixed(3)}`)}`,
			startSec: s.startSec,
			endSec: s.endSec,
		}));
	};
	const offeredRemovals = removals.filter((op) => !isAccepted(op));
	const trimmedOffered = offeredRemovals
		.flatMap(subtractAccepted)
		.filter((op) => op.endSec > op.startSec);
	// Pass 3: remaining OFFERED-vs-OFFERED overlaps resolve by start order
	// among themselves, same rule as before.
	const finalOffered = clipByStartOrder(trimmedOffered);

	return [...nonRemovals, ...acceptedRemovals, ...finalOffered].sort(
		(a, b) => a.startSec - b.startSec,
	);
}
