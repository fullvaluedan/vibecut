/**
 * Deterministic repeated-PHRASE detector.
 *
 * The word-duplicate detector catches a single doubled word; this catches a
 * multi-word PHRASE the speaker says again within a window — common in a single
 * continuous recording where they restart or re-explain the same line. The
 * EARLIER instance is the cut (keep the LAST attempt, like a retake), never the
 * gap between them. Pure + wasm-free so it's unit-tested; the ops merge into the
 * Director plan and show in the Review modal. Verbatim matches start ACCEPTED
 * (U1: obvious repeats leave without row-toggling); review remains the gate.
 *
 * VERBATIM / near-verbatim repeats only — token n-gram matching can't see a
 * PARAPHRASED restatement (same point, different words); the LLM cut prompt
 * handles those. This is the reliable backstop for the literal-repeat case.
 *
 * Round 6 U4 (live-test fix): a short n-gram shared by two DIFFERENT sentences
 * ("We are going to build it" vs "we are going to showcase") is common English,
 * not a retake, and auto-cutting it amputates a sentence mid-speech. When the
 * caller supplies `segments`, each match is gated on WHOLE-SEGMENT similarity:
 * the two occurrences' containing segments must be near-identical
 * (similarity >= HIGH_SIMILAR, a true retake) for the op to keep its AUTO
 * default; anything below demotes to an unchecked review row. Without
 * segments (legacy callers) behavior is unchanged. Aligns with the repeat
 * brainstorm R7: the LLM redundancy pass is the primary repeat catcher and the
 * lexical detectors are its high-precision backstop.
 *
 * Round 11 (hermes AUTO essLost attribution): the U4 gate had a hole. When BOTH
 * occurrences of the phrase live inside ONE segment, the similarity test compares
 * that segment with ITSELF and returns 1.0 no matter what, so every intra-segment
 * repeat kept its AUTO default unchecked by any real evidence. That is the common
 * shape of a mid-sentence stumble ("we are going to start this up we are going to
 * launch a small instance"), and on hermes 17 of the 23 ops that took this path
 * destroyed dialog Dan KEPT. Same-segment matches now demote to a review row; the
 * cross-segment comparison, which has two distinct texts to weigh, is unchanged.
 */

import type { DirectorOp } from "@framecut/hf-bridge";
import { isMidpointContained, normalizeWord, stableCutId, type WordTiming } from "./cut-utils";
import { HIGH_SIMILAR, similarity } from "./text-similarity";

/** Min consecutive matching tokens for a phrase repeat (shorter = noisy). */
const DEFAULT_MIN_PHRASE_WORDS = 4;
/** Only match a later repeat within this much time — a far-apart repeat reads as
 * a deliberate callback/recap, not a restart. */
const DEFAULT_WINDOW_SECONDS = 60;
/** Cap a single cut's length so one huge repeated block isn't one giant removal. */
const MAX_PHRASE_WORDS = 40;

interface NormToken {
	norm: string;
	start: number;
	end: number;
	raw: string;
}

/**
 * Find phrases the speaker repeats verbatim within `windowSeconds` and cut the
 * EARLIER occurrence (keeping the later one). A run of N repeats yields N-1 cuts,
 * so the last attempt survives.
 */
export function detectPhraseRepeatCuts({
	words,
	segments,
	minPhraseWords = DEFAULT_MIN_PHRASE_WORDS,
	windowSeconds = DEFAULT_WINDOW_SECONDS,
}: {
	words: readonly WordTiming[];
	/** Transcript segments for the U4 similarity gate; absent = legacy behavior
	 * (every match keeps its AUTO default). */
	segments?: readonly { text: string; start: number; end: number }[];
	minPhraseWords?: number;
	windowSeconds?: number;
}): DirectorOp[] {
	/** The segment containing [spanStart, spanEnd)'s midpoint, or null. */
	const containingSegment = (
		spanStart: number,
		spanEnd: number,
	): { text: string; start: number; end: number } | null => {
		if (!segments) return null;
		return (
			segments.find((seg) =>
				isMidpointContained({
					spanStart,
					spanEnd,
					containerStart: seg.start,
					containerEnd: seg.end,
				}),
			) ?? null
		);
	};
	// Drop punctuation-only/empty tokens so they don't break an otherwise
	// consecutive phrase; each kept token carries its own timing.
	const tokens: NormToken[] = [];
	for (const w of words) {
		const norm = normalizeWord(w.text);
		if (norm.length > 0 && w.end > w.start) {
			tokens.push({ norm, start: w.start, end: w.end, raw: w.text });
		}
	}

	const ops: DirectorOp[] = [];
	let i = 0;
	while (i < tokens.length) {
		let bestLen = 0;
		let bestJ = -1;
		// Look for a later start `j` of the same run, within the time window and
		// without overlapping the earlier run.
		for (let j = i + 1; j < tokens.length; j++) {
			if (tokens[j].start - tokens[i].end > windowSeconds) break;
			let len = 0;
			while (
				i + len < j && // earlier and later runs must stay disjoint
				j + len < tokens.length &&
				tokens[i + len].norm === tokens[j + len].norm
			) {
				len++;
			}
			if (len > bestLen) {
				bestLen = len;
				bestJ = j;
			}
		}

		if (bestLen >= minPhraseWords && bestJ >= 0) {
			const len = Math.min(bestLen, MAX_PHRASE_WORDS);
			const startTok = tokens[i];
			const endTok = tokens[i + len - 1];
			const preview = tokens
				.slice(i, Math.min(i + 6, i + len))
				.map((t) => t.raw.trim())
				.join(" ");
			// U4 similarity gate: only a match whose two occurrences live in
			// near-identical WHOLE segments is a true retake worth an AUTO cut.
			// A shared n-gram across different sentences demotes to review.
			let confirmedRetake = true;
			// True when both occurrences resolved to the SAME segment, i.e. the
			// similarity test had nothing to compare against (round 11).
			let sameSegment = false;
			// An EMPTY segments array carries no information to gate on (degraded
			// transcripts, tests): legacy behavior, same as absent.
			if (segments && segments.length > 0) {
				const laterStart = tokens[bestJ];
				const laterEnd = tokens[Math.min(bestJ + len - 1, tokens.length - 1)];
				const earlierSeg = containingSegment(startTok.start, endTok.end);
				const laterSeg = containingSegment(laterStart.start, laterEnd.end);
				// Identity, not text equality: `containingSegment` returns the element
				// from the caller's array, so one segment holding both occurrences is
				// exactly `earlierSeg === laterSeg` and needs no tolerance constant.
				sameSegment = earlierSeg !== null && earlierSeg === laterSeg;
				confirmedRetake =
					!sameSegment &&
					earlierSeg !== null &&
					laterSeg !== null &&
					similarity({ a: earlierSeg.text, b: laterSeg.text }) >= HIGH_SIMILAR;
			}
			ops.push({
				id: `rep-${stableCutId(`${preview}:${startTok.start.toFixed(3)}:${endTok.end.toFixed(3)}`)}`,
				op: "cut",
				startSec: startTok.start,
				endSec: endTok.end,
				reason: confirmedRetake
					? `Repeated phrase "${preview}${len > 6 ? "…" : ""}": earlier of two near-identical takes`
					: sameSegment
						? `Phrase "${preview}${len > 6 ? "…" : ""}" repeats INSIDE one sentence: a stumble or deliberate emphasis, review before cutting`
						: `Phrase "${preview}${len > 6 ? "…" : ""}" recurs in a DIFFERENT sentence: likely natural repetition, review before cutting`,
				// A longer verbatim run is a stronger restart signal.
				confidence: Math.min(0.9, 0.55 + (bestLen - minPhraseWords) * 0.05),
				category: "repeat",
				...(confirmedRetake ? {} : { defaultAccept: false }),
			});
			i += len; // skip past the cut phrase so it isn't re-matched
		} else {
			i++;
		}
	}

	return ops;
}
