/**
 * Hallucination guard (round 6 U1): detect transcript spans whose AUDIO is
 * silence and quarantine them from every speech-presence consumer.
 *
 * Whisper hallucinates fluent text over silence (the live-test tail: 30s
 * "Thank you." segments carrying single 9-21s "words"). Those fake words make
 * dead air look like speech to every word/segment-driven detector, block the
 * silence passes, and poison per-segment features. This module flags a segment
 * as hallucinated ONLY when BOTH hold (KTD3, conservative AND):
 *
 *   1. TEXT-SIDE ABSURDITY: any single word longer than MAX_PLAUSIBLE_WORD_SEC,
 *      or segment wpm below MIN_PLAUSIBLE_WPM over a span of WPM_MIN_SPAN_SEC+.
 *   2. ENERGY: the segment's mean envelope RMS sits below the silence
 *      threshold, so the audio really is silence (quiet-but-real speech and
 *      loud music with sparse words both survive).
 *
 * The threshold is min(SILENCE_RMS_CEILING, median(segment energies) x
 * MEDIAN_RATIO) where the median is computed ONLY over segments that pass the
 * text-side screen (KTD1): the screen needs no energy, which breaks the
 * circularity where near-zero hallucinated segments drag the median toward 0
 * on hallucination-heavy footage. With zero screened segments the fixed
 * ceiling applies alone.
 *
 * Pure + wasm-free, seconds in and out, generic over the caller's word/segment
 * shapes. Fail-open: an empty envelope or empty words returns the inputs
 * unchanged (mirrors refine-cut-words / justify-cuts).
 */

import { meanEnergyOverRange } from "./audio-features";
import { isMidpointContained } from "./cut-utils";

/** Mirrors remove-silences.ts RMS_THRESHOLD: linear RMS ceiling for "silence". */
export const SILENCE_RMS_CEILING = 0.015;
/** Adaptive component: fraction of the screened-median segment energy. */
export const MEDIAN_RATIO = 0.5;
/** No real spoken word lasts this long; Whisper's silence-bleed words do. */
export const MAX_PLAUSIBLE_WORD_SEC = 3;
/** Below this speaking rate over a long span, the "speech" is not speech. */
export const MIN_PLAUSIBLE_WPM = 30;
/** The wpm screen only fires on spans at least this long (short segments are noisy). */
export const WPM_MIN_SPAN_SEC = 5;

interface SpanText {
	text: string;
	start: number;
	end: number;
}

export interface HallucinatedSpan {
	startSec: number;
	endSec: number;
}

export interface HallucinationGuardResult<W extends SpanText, S extends SpanText> {
	/** Words outside every flagged segment (midpoint containment). */
	cleanWords: W[];
	/** Segments that were not flagged, original order preserved. */
	cleanSegments: S[];
	/** Indices into the ORIGINAL segments array that survived; the caller uses
	 * these to filter any segments-parallel array (features) identically. */
	survivingSegmentIndices: number[];
	/** Flagged segment spans, merged where they overlap or touch. */
	hallucinatedSpans: HallucinatedSpan[];
}

/** Words whose midpoint lies inside [startSec, endSec). */
function wordsWithin<W extends SpanText>(
	words: readonly W[],
	startSec: number,
	endSec: number,
): W[] {
	return words.filter((w) =>
		isMidpointContained({
			spanStart: w.start,
			spanEnd: w.end,
			containerStart: startSec,
			containerEnd: endSec,
		}),
	);
}

/** The text-side absurdity screen (no energy involved), per KTD3 leg 1. */
function isTextAbsurd<W extends SpanText>(segment: SpanText, segWords: readonly W[]): boolean {
	for (const w of segWords) {
		if (w.end - w.start > MAX_PLAUSIBLE_WORD_SEC) return true;
	}
	const durationSec = segment.end - segment.start;
	if (durationSec >= WPM_MIN_SPAN_SEC) {
		const wpm = segWords.length > 0 ? (segWords.length / durationSec) * 60 : 0;
		if (wpm < MIN_PLAUSIBLE_WPM) return true;
	}
	return false;
}

/**
 * The silence threshold shared by the guard, the envelope dead-air detector,
 * and the swallow walk (KTD1): min(fixed ceiling, median x ratio) over CLEAN
 * per-segment energies. A degenerate median (0: muted or digitally-silent
 * audio with a transcript) falls back to the fixed ceiling; a strict
 * `< threshold` test against 0 would silently disable every silence consumer
 * on exactly the fully-dead footage they exist to clean. One definition here
 * so the three passes can never diverge.
 */
export function computeSilenceThreshold(segmentEnergies: readonly number[]): number {
	if (segmentEnergies.length === 0) {
		return SILENCE_RMS_CEILING;
	}
	const sorted = [...segmentEnergies].sort((a, b) => a - b);
	const adaptive = sorted[Math.floor(sorted.length / 2)] * MEDIAN_RATIO;
	return adaptive > 0 ? Math.min(SILENCE_RMS_CEILING, adaptive) : SILENCE_RMS_CEILING;
}

/**
 * Flag hallucinated segments and return the cleaned views. See the module
 * header for criteria. The original arrays are never mutated.
 */
export function guardHallucinations<W extends SpanText, S extends SpanText>({
	words,
	segments,
	envelope,
	windowSec,
}: {
	words: readonly W[];
	segments: readonly S[];
	envelope: readonly number[];
	windowSec: number;
}): HallucinationGuardResult<W, S> {
	const passThrough = (): HallucinationGuardResult<W, S> => ({
		cleanWords: [...words],
		cleanSegments: [...segments],
		survivingSegmentIndices: segments.map((_, i) => i),
		hallucinatedSpans: [],
	});
	if (envelope.length === 0 || words.length === 0 || segments.length === 0) {
		return passThrough();
	}

	const segWords = segments.map((seg) => wordsWithin(words, seg.start, seg.end));
	const absurd = segments.map((seg, i) => isTextAbsurd(seg, segWords[i]));
	const energies = segments.map((seg) =>
		meanEnergyOverRange({ envelope, windowSec, startSec: seg.start, endSec: seg.end }),
	);

	// KTD1: the adaptive median only sees segments the TEXT screen trusts.
	const screenedEnergies = energies.filter((_, i) => !absurd[i]);
	const threshold = computeSilenceThreshold(screenedEnergies);

	// Energy leg: judge the segment's WORD SPANS, not the whole-segment mean.
	// A sparse real utterance in a long trailing-pause segment (a quiet "Okay."
	// followed by 6s of room tone) has a sub-threshold WHOLE-segment mean but a
	// clearly energetic word span; a hallucinated word's span is itself silent.
	// Wordless segments fall back to the whole-segment mean.
	const wordSpanSilent = segments.map((_, i) => {
		if (segWords[i].length === 0) return energies[i] < threshold;
		const maxWordEnergy = segWords[i].reduce(
			(max, w) =>
				Math.max(
					max,
					meanEnergyOverRange({ envelope, windowSec, startSec: w.start, endSec: w.end }),
				),
			0,
		);
		return maxWordEnergy < threshold;
	});
	const flagged = segments.map((_, i) => absurd[i] && wordSpanSilent[i]);
	if (!flagged.some(Boolean)) {
		return passThrough();
	}

	const survivingSegmentIndices: number[] = [];
	const cleanSegments: S[] = [];
	const flaggedSpans: HallucinatedSpan[] = [];
	segments.forEach((seg, i) => {
		if (flagged[i]) {
			flaggedSpans.push({ startSec: seg.start, endSec: seg.end });
		} else {
			survivingSegmentIndices.push(i);
			cleanSegments.push(seg);
		}
	});

	// Merge overlapping/touching flagged spans into maximal runs.
	flaggedSpans.sort((a, b) => a.startSec - b.startSec);
	const hallucinatedSpans: HallucinatedSpan[] = [];
	for (const span of flaggedSpans) {
		const last = hallucinatedSpans[hallucinatedSpans.length - 1];
		if (last && span.startSec <= last.endSec) {
			last.endSec = Math.max(last.endSec, span.endSec);
		} else {
			hallucinatedSpans.push({ ...span });
		}
	}

	const cleanWords = words.filter(
		(w) =>
			!hallucinatedSpans.some((s) =>
				isMidpointContained({
					spanStart: w.start,
					spanEnd: w.end,
					containerStart: s.startSec,
					containerEnd: s.endSec,
				}),
			),
	);

	return { cleanWords, cleanSegments, survivingSegmentIndices, hallucinatedSpans };
}
