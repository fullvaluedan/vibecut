/**
 * Deterministic filler / false-start detector (Round-2 U2). Reuses the word-level
 * transcript timing the duplicate detector already requests. Catches the
 * unambiguous fillers the LLM misses at segment granularity — standalone
 * "um/uh/er", bounded two-word hedges ("you know", "i mean"), and cut-off false
 * starts (whisper marks these with a trailing dash). Context-dependent words
 * (like / so / well) are deliberately left to the LLM. Pure + wasm-free; the cuts
 * are review-flagged, not auto-applied.
 */

import type { DirectorOp } from "@framecut/hf-bridge";
import { normalizeWord, stableCutId, type WordTiming } from "./cut-utils";

/** Standalone disfluencies — high precision, safe to cut on sight. */
const SINGLE_FILLERS = new Set([
	"um",
	"umm",
	"uh",
	"uhh",
	"uhm",
	"er",
	"err",
	"erm",
	"ah",
	"eh",
	"hmm",
	"mm",
	"mhm",
]);

/** Two-word hedge phrases (normalized) that read as filler when adjacent. */
const HEDGES: ReadonlyArray<readonly [string, string]> = [
	["you", "know"],
	["i", "mean"],
	["sort", "of"],
	["kind", "of"],
];

/** Whisper marks an interrupted / cut-off word with a trailing dash. */
const CUTOFF = /[-—]\s*$/;

function fillerOp({
	start,
	end,
	reason,
	confidence,
}: {
	start: number;
	end: number;
	reason: string;
	confidence: number;
}): DirectorOp {
	return {
		id: `fil-${stableCutId(`${start.toFixed(3)}:${end.toFixed(3)}`)}`,
		op: "cut",
		startSec: start,
		endSec: end,
		reason,
		confidence,
		category: "filler",
	};
}

/**
 * Return `cut` ops for standalone fillers, two-word hedges, and cut-off false
 * starts found in the word stream. Each carries `category: "filler"`.
 */
export function detectFillerCuts({
	words,
}: {
	words: WordTiming[];
}): DirectorOp[] {
	const ops: DirectorOp[] = [];
	let i = 0;
	while (i < words.length) {
		const cur = words[i];
		if (cur.end <= cur.start) {
			i++;
			continue;
		}
		const norm = normalizeWord(cur.text);

		// False start: a cut-off fragment (whisper's trailing dash, e.g. "th-").
		if (CUTOFF.test(cur.text)) {
			ops.push(
				fillerOp({
					start: cur.start,
					end: cur.end,
					reason: `False start "${cur.text.trim()}"`,
					confidence: 0.7,
				}),
			);
			i++;
			continue;
		}

		// Two-word hedge ("you know", "i mean") — cut the whole span.
		const next = words[i + 1];
		if (next && next.end > next.start) {
			const nn = normalizeWord(next.text);
			if (HEDGES.some(([a, b]) => a === norm && b === nn)) {
				ops.push(
					fillerOp({
						start: cur.start,
						end: next.end,
						reason: `Filler "${cur.text.trim()} ${next.text.trim()}"`,
						confidence: 0.55,
					}),
				);
				i += 2;
				continue;
			}
		}

		// Standalone filler word.
		if (SINGLE_FILLERS.has(norm)) {
			ops.push(
				fillerOp({
					start: cur.start,
					end: cur.end,
					reason: `Filler "${cur.text.trim()}"`,
					confidence: 0.7,
				}),
			);
		}
		i++;
	}
	return ops;
}
