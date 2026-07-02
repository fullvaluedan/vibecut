/**
 * Emphasis-pause classifier (Dan's issue #4). A pure, wasm-free helper that
 * decides which candidate silence gaps to KEEP as deliberate emphasis beats
 * rather than cut them.
 *
 * Dan's rule: keep up to ~2s of silence between dialog "only if it seems like
 * it makes sense to pause to emphasize and there's not repeats/mistakes around
 * the pause." Operationalized as a deterministic heuristic (KTD1): a gap is an
 * emphasis pause when it is short enough, bounded by speech on both sides (so
 * mid-delivery, not leading/trailing/between-takes), and clear of any nearby
 * repeat/mistake cut.
 *
 * The output is `KeeperSpan`s fed into `mergeDetectedCuts`, which already drops
 * removals overlapping a keeper — so we protect the pause without special-casing
 * each detector (KTD2).
 */

import type { KeeperSpan } from "./cut-utils";
import type { TranscriptWordLite } from "@/features/transcription/transcript-cache";

/** An inter-segment / silence span (seconds) that a detector would cut. */
export interface PauseGap {
	start: number;
	end: number;
}

/** A cut span for a repeat/mistake (seconds). Same shape as a `KeeperSpan`. */
export interface RepeatSpan {
	startSec: number;
	endSec: number;
}

/** Dan's ceiling: silence longer than this is dead air, not an emphasis beat. */
export const MAX_PAUSE_SEC = 2.0;

/**
 * A repeat/mistake cut this close to a gap disqualifies the gap — Dan's "no
 * repeats/mistakes around the pause". The window is applied to both edges.
 */
export const PAUSE_PROXIMITY_SEC = 1.0;

/**
 * How close a word boundary must sit to a gap edge to count as "speech on this
 * side". Absorbs the small slack between a detector's silence boundary and the
 * transcriber's word timings.
 */
export const WORD_BOUNDARY_SNAP_SEC = 0.25;

/**
 * Decide which `gaps` to keep as emphasis pauses. Returns a `KeeperSpan` for
 * every gap where ALL hold:
 *
 * - duration <= `maxPauseSec` (short enough to read as a beat, not dead air);
 * - a word ends within `snapSec` of the gap start AND a word begins within
 *   `snapSec` of the gap end (bounded by speech on both sides);
 * - no `repeatSpan` overlaps the gap or lies within `proximitySec` of it.
 *
 * When `words` is empty the caller has no word timings to reason about, so we
 * return no keepers and the caller falls back to its prior cut behavior. Pure
 * and side-effect free: inputs are never mutated.
 */
export function computeEmphasisPauseKeepers({
	gaps,
	words,
	repeatSpans = [],
	maxPauseSec = MAX_PAUSE_SEC,
	proximitySec = PAUSE_PROXIMITY_SEC,
	snapSec = WORD_BOUNDARY_SNAP_SEC,
}: {
	gaps: readonly PauseGap[];
	words: readonly TranscriptWordLite[];
	repeatSpans?: readonly RepeatSpan[];
	maxPauseSec?: number;
	proximitySec?: number;
	snapSec?: number;
}): KeeperSpan[] {
	if (words.length === 0) return [];

	const keepers: KeeperSpan[] = [];
	for (const gap of gaps) {
		const duration = gap.end - gap.start;
		if (duration <= 0 || duration > maxPauseSec) continue;

		// Bounded by speech: a word must end at the gap's leading edge and another
		// must begin at its trailing edge (mid-delivery, not leading/trailing air).
		const speechBefore = words.some(
			(w) => Math.abs(w.end - gap.start) <= snapSec,
		);
		const speechAfter = words.some(
			(w) => Math.abs(w.start - gap.end) <= snapSec,
		);
		if (!speechBefore || !speechAfter) continue;

		// No repeat/mistake within the proximity window (on either edge). Expand the
		// gap by proximitySec and test for overlap with each repeat span.
		const nearRepeat = repeatSpans.some(
			(r) =>
				r.startSec < gap.end + proximitySec &&
				gap.start - proximitySec < r.endSec,
		);
		if (nearRepeat) continue;

		keepers.push({ startSec: gap.start, endSec: gap.end });
	}
	return keepers;
}

/** A tightening removal (seconds) over a repeat-adjacent pause. */
export interface PauseFloorCut {
	startSec: number;
	endSec: number;
}

/**
 * The counterpart to `computeEmphasisPauseKeepers` for the DISQUALIFIED pauses
 * (Dan's rule #3). A mid-delivery pause that WOULD read as an emphasis beat (short
 * + speech-bounded) but sits next to a repeat/mistake we're cutting anyway should
 * be neither kept whole nor zeroed by the splice: tighten it to leave `floorSec`
 * of silence. Returns a removal covering the pause MINUS a trailing `floorSec`
 * remnant (so a breath survives before the next word); a pause already <= `floorSec`
 * yields nothing. Same qualification as an emphasis keeper, but the near-repeat test
 * is INVERTED (these are exactly the ones a keeper skips). Pure + side-effect free.
 */
export function computeRepeatAdjacentPauseFloors({
	gaps,
	words,
	repeatSpans = [],
	floorSec,
	maxPauseSec = MAX_PAUSE_SEC,
	proximitySec = PAUSE_PROXIMITY_SEC,
	snapSec = WORD_BOUNDARY_SNAP_SEC,
}: {
	gaps: readonly PauseGap[];
	words: readonly TranscriptWordLite[];
	repeatSpans?: readonly RepeatSpan[];
	floorSec: number;
	maxPauseSec?: number;
	proximitySec?: number;
	snapSec?: number;
}): PauseFloorCut[] {
	if (words.length === 0 || floorSec <= 0) return [];

	const cuts: PauseFloorCut[] = [];
	for (const gap of gaps) {
		const duration = gap.end - gap.start;
		if (duration <= 0 || duration > maxPauseSec) continue;
		// Already within the floor: nothing to tighten (and never widen a pause).
		if (duration <= floorSec) continue;

		const speechBefore = words.some((w) => Math.abs(w.end - gap.start) <= snapSec);
		const speechAfter = words.some((w) => Math.abs(w.start - gap.end) <= snapSec);
		if (!speechBefore || !speechAfter) continue;

		const nearRepeat = repeatSpans.some(
			(r) =>
				r.startSec < gap.end + proximitySec &&
				gap.start - proximitySec < r.endSec,
		);
		// Only the repeat-adjacent pauses land here; the rest are kept whole as beats.
		if (!nearRepeat) continue;

		cuts.push({ startSec: gap.start, endSec: gap.end - floorSec });
	}
	return cuts;
}
