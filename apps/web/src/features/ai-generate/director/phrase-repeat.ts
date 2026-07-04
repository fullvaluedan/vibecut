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
 */

import type { DirectorOp } from "@framecut/hf-bridge";
import { normalizeWord, stableCutId, type WordTiming } from "./cut-utils";

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
	minPhraseWords = DEFAULT_MIN_PHRASE_WORDS,
	windowSeconds = DEFAULT_WINDOW_SECONDS,
}: {
	words: readonly WordTiming[];
	minPhraseWords?: number;
	windowSeconds?: number;
}): DirectorOp[] {
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
			ops.push({
				id: `rep-${stableCutId(`${preview}:${startTok.start.toFixed(3)}:${endTok.end.toFixed(3)}`)}`,
				op: "cut",
				startSec: startTok.start,
				endSec: endTok.end,
				reason: `Repeated phrase "${preview}${len > 6 ? "…" : ""}" — earlier of two near-identical takes`,
				// A longer verbatim run is a stronger restart signal.
				confidence: Math.min(0.9, 0.55 + (bestLen - minPhraseWords) * 0.05),
				category: "repeat",
			});
			i += len; // skip past the cut phrase so it isn't re-matched
		} else {
			i++;
		}
	}

	return ops;
}
