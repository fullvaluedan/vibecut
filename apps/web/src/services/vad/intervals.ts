/**
 * Pure VAD interval math (Plan A / U3) — wasm-free, unit-tested. Turns the raw
 * speech intervals a Silero VAD pass emits into clean, padded speech intervals +
 * their complement non-speech gaps over `[0, totalSec]`. Kept separate from the
 * VAD worker so the windowing rules (merge / min-duration / padding / gap
 * complement) are testable without a model.
 */

/** A half-open interval in timeline seconds. */
export interface Interval {
	startSec: number;
	endSec: number;
}

export interface RefinedSpeech {
	/** Cleaned, padded, non-overlapping speech intervals (ascending). */
	speech: Interval[];
	/** The complement of `speech` within [0, totalSec] (the non-speech gaps). */
	gaps: Interval[];
}

/*
 * Auto-editor cut dials as named one-line constants (U6). Starting values follow
 * auto-editor's silence conventions; they are TUNED IN U7 against Dan's real
 * recordings, not final. One line each so a tuning pass is a single-number edit.
 * This module is the single home for the VAD-path silence dials.
 */

/**
 * Minimum removable silence: speech blobs separated by a gap this short or
 * shorter are treated as one breath and merged, so the gap is never cut (auto-
 * editor's min-cut). A silence has to exceed this to be removable at all.
 */
const MIN_REMOVABLE_SILENCE_SEC = 0.2;
/**
 * Minimum surviving island: a speech blob shorter than this is a blip (click /
 * breath / one-frame VAD flicker) and is absorbed into the surrounding silence
 * rather than kept as a tiny island (auto-editor's min-clip).
 */
const MIN_SURVIVING_ISLAND_SEC = 0.1;
/**
 * Asymmetric edge padding (auto-editor margin around kept content). The HEAD
 * (word onset / breath-in before speech) needs less room than the TAIL: cutting
 * a word's trailing DECAY is what sounds robotic, so the tail keeps more.
 */
const PAD_HEAD_SEC = 0.2;
const PAD_TAIL_SEC = 0.35;

/**
 * Silero VAD frame-processor dials tuned for OFFLINE cut detection over a whole
 * recording, NOT live mic streaming. Passed to `NonRealTimeVAD.new()` in the VAD
 * worker (browser-only, so the effect is tuned by U7 on real footage; asserted
 * here only for offline-vs-streaming shape). Library mic defaults for reference:
 * `minSpeechMs` 400, `redemptionMs` 1400.
 */
export const OFFLINE_VAD_OPTIONS: { minSpeechMs: number; redemptionMs: number } = {
	/**
	 * Raised above the 400ms mic default so a cough / click / one-frame blip isn't
	 * counted as a speech island that fragments the surrounding silence. U7 tunes.
	 */
	minSpeechMs: 600,
	/**
	 * Grace period a dip below threshold waits before ending a speech segment; it
	 * sets the shortest silence that can open a gap. Held near the library default
	 * so natural sub-second sentence pauses stay INSIDE speech (never cut), while
	 * true dead air past the dead-air floor still surfaces as a gap. U7 tunes.
	 */
	redemptionMs: 1400,
};

/**
 * Refine raw VAD speech intervals: clamp to [0,totalSec], merge near-adjacent
 * (gap <= mergeGapSec, the min removable silence), drop sub-`minSpeechSec` blips,
 * pad edges asymmetrically (`padHeadSec` before, `padTailSec` after, re-merging
 * any overlap the padding introduces), then derive the gaps as the complement.
 * Always returns a partition: `speech ∪ gaps` covers [0, totalSec] with no
 * overlap. This padding is the SINGLE silence-margin source for the VAD path (the
 * downstream dead-air detector adds none), so gaps arrive already trimmed.
 */
export function refineSpeechIntervals({
	raw,
	totalSec,
	mergeGapSec = MIN_REMOVABLE_SILENCE_SEC,
	minSpeechSec = MIN_SURVIVING_ISLAND_SEC,
	padHeadSec = PAD_HEAD_SEC,
	padTailSec = PAD_TAIL_SEC,
}: {
	raw: readonly Interval[];
	totalSec: number;
	mergeGapSec?: number;
	minSpeechSec?: number;
	padHeadSec?: number;
	padTailSec?: number;
}): RefinedSpeech {
	const sorted = raw
		.map((iv) => ({
			startSec: Math.max(0, Math.min(iv.startSec, totalSec)),
			endSec: Math.max(0, Math.min(iv.endSec, totalSec)),
		}))
		.filter((iv) => iv.endSec > iv.startSec)
		.sort((a, b) => a.startSec - b.startSec);

	// Merge intervals separated by ≤ mergeGapSec.
	const merged: Interval[] = [];
	for (const iv of sorted) {
		const last = merged[merged.length - 1];
		if (last && iv.startSec - last.endSec <= mergeGapSec) {
			last.endSec = Math.max(last.endSec, iv.endSec);
		} else {
			merged.push({ ...iv });
		}
	}

	// Drop short blips, then pad + re-merge (padding can re-introduce overlaps).
	// Padding is asymmetric: the head (word onset) keeps less room than the tail
	// (trailing decay cut-off is what sounds robotic).
	const padded: Interval[] = [];
	for (const iv of merged) {
		if (iv.endSec - iv.startSec < minSpeechSec) continue;
		const next = {
			startSec: Math.max(0, iv.startSec - padHeadSec),
			endSec: Math.min(totalSec, iv.endSec + padTailSec),
		};
		const last = padded[padded.length - 1];
		if (last && next.startSec <= last.endSec) {
			last.endSec = Math.max(last.endSec, next.endSec);
		} else {
			padded.push(next);
		}
	}

	// Gaps = complement of speech within [0, totalSec].
	const gaps: Interval[] = [];
	let cursor = 0;
	for (const iv of padded) {
		if (iv.startSec > cursor) gaps.push({ startSec: cursor, endSec: iv.startSec });
		cursor = Math.max(cursor, iv.endSec);
	}
	if (cursor < totalSec) gaps.push({ startSec: cursor, endSec: totalSec });

	return { speech: padded, gaps };
}
