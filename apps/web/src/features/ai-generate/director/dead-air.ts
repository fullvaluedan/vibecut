/**
 * Deterministic dead-air / low-information detector.
 *
 * After silence removal, the "figuring something out" time the LLM often keeps
 * is sustained HESITATION — a dense mutter-cluster of fillers ("um uh okay um uh
 * okay") with almost no real content. This flags such a span as a cut; the
 * surrounding content survives. Pure + wasm-free → unit-tested.
 *
 * SAFETY over recall: it bridges at most ONE content word between hesitations
 * and stops at any sustained content run, so it never cuts real speech that sits
 * between two clusters. Interspersed searching phrases ("let me see where it is")
 * are left to the LLM cut prompt (which now targets DEAD TIME); individual
 * fillers are the filler detector's job. This is the sustained-run backstop.
 */

import type { DirectorOp } from "@framecut/hf-bridge";
import { normalizeWord, stableCutId, type WordTiming } from "./cut-utils";

/** Tokens that are almost always hesitation when clustered. Kept tight — broader
 * discourse markers (like/so/well/just) carry real meaning too often. */
const HESITATION = new Set([
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
	"hm",
	"mm",
	"mhm",
	"okay",
	"ok",
]);

/** A run needs at least this many hesitation tokens to count as dead air. */
const DEFAULT_MIN_HESITATIONS = 3;
/** ...and must span at least this long (a 1.5s mutter isn't worth a cut). */
const DEFAULT_MIN_SPAN_SECONDS = 2.5;
/** Consecutive content words allowed between hesitations before the run ends. */
const MAX_BRIDGE_CONTENT = 1;
/** Hard cap on a single dead-air cut, so a run never swallows a long section. */
const MAX_SPAN_SECONDS = 20;

interface DeadTok {
	start: number;
	end: number;
	hes: boolean;
}

/**
 * Find dense hesitation runs (≥ `minHesitations` hesitation tokens, separated by
 * at most one content word, spanning ≥ `minSpanSeconds`) and cut each one.
 */
export function detectDeadAirCuts({
	words,
	minHesitations = DEFAULT_MIN_HESITATIONS,
	minSpanSeconds = DEFAULT_MIN_SPAN_SECONDS,
}: {
	words: readonly WordTiming[];
	minHesitations?: number;
	minSpanSeconds?: number;
}): DirectorOp[] {
	const toks: DeadTok[] = [];
	for (const w of words) {
		const n = normalizeWord(w.text);
		if (n.length > 0 && w.end > w.start) {
			toks.push({ start: w.start, end: w.end, hes: HESITATION.has(n) });
		}
	}

	const ops: DirectorOp[] = [];
	let i = 0;
	while (i < toks.length) {
		if (!toks[i].hes) {
			i++;
			continue;
		}
		// Extend the run while hesitations stay dense — bridge at most one content
		// word, stop on a sustained content run or the span cap.
		let hesCount = 0;
		let bestEnd = -1;
		let contentStreak = 0;
		for (let k = i; k < toks.length; k++) {
			if (toks[k].start - toks[i].start > MAX_SPAN_SECONDS) break;
			if (toks[k].hes) {
				hesCount++;
				contentStreak = 0;
				bestEnd = k;
			} else {
				contentStreak++;
				if (contentStreak > MAX_BRIDGE_CONTENT) break;
			}
		}

		const startTok = toks[i];
		if (
			bestEnd >= 0 &&
			hesCount >= minHesitations &&
			toks[bestEnd].end - startTok.start >= minSpanSeconds
		) {
			const endTok = toks[bestEnd];
			ops.push({
				id: `dead-${stableCutId(`${startTok.start.toFixed(3)}:${endTok.end.toFixed(3)}:${hesCount}`)}`,
				op: "cut",
				startSec: startTok.start,
				endSec: endTok.end,
				reason: `Dead air — ${hesCount} hesitations, little content`,
				// Dead-air is subjective; keep confidence modest so it's easy to reject.
				confidence: Math.min(0.75, 0.55 + (hesCount - minHesitations) * 0.04),
				category: "deadair",
			});
			i = bestEnd + 1; // skip past the cut run
		} else {
			i++;
		}
	}

	return ops;
}
