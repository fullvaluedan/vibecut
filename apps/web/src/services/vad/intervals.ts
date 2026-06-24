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

/** Speech blobs closer than this are one breath — merge them. */
const DEFAULT_MERGE_GAP_SEC = 0.3;
/** A speech blob shorter than this is a blip (a click/breath) — drop it. */
const DEFAULT_MIN_SPEECH_SEC = 0.2;
/** Pad each speech edge so a word onset/tail isn't clipped by a tight VAD bound. */
const DEFAULT_PAD_SEC = 0.15;

/**
 * Refine raw VAD speech intervals: clamp to [0,totalSec], merge near-adjacent,
 * drop sub-`minSpeechSec` blips, pad edges by `padSec` (re-merging any overlap
 * the padding introduces), then derive the gaps as the complement. Always
 * returns a partition: `speech ∪ gaps` covers [0, totalSec] with no overlap.
 */
export function refineSpeechIntervals({
	raw,
	totalSec,
	mergeGapSec = DEFAULT_MERGE_GAP_SEC,
	minSpeechSec = DEFAULT_MIN_SPEECH_SEC,
	padSec = DEFAULT_PAD_SEC,
}: {
	raw: readonly Interval[];
	totalSec: number;
	mergeGapSec?: number;
	minSpeechSec?: number;
	padSec?: number;
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
	const padded: Interval[] = [];
	for (const iv of merged) {
		if (iv.endSec - iv.startSec < minSpeechSec) continue;
		const next = {
			startSec: Math.max(0, iv.startSec - padSec),
			endSec: Math.min(totalSec, iv.endSec + padSec),
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
