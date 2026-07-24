/**
 * Word-boundary refinement (U1, R1/KTD1/KTD2). Every LLM/detector removal has its
 * edges placed by `swallowPauseBounds` FIRST (round 6; pause-widening with an
 * in-speech trough-snap fallback), but a fallback trough can still fall mid-word
 * (a plosive gap inside "because", the quiet between two syllables), so a cut edge can
 * land inside a real word and amputate a fragment ("So", "phone.") that the transcript
 * counts as an essential kept word. This pass corrects exactly those landings: it moves
 * each removal edge OFF any word it lands inside, to that word's nearest gap.
 *
 * Runs AFTER `swallowPauseBounds` and BEFORE `resolveTrimVsCut` (KTD2): edge placement finds
 * the acoustic trough, this pass nudges the few edges that trough left mid-word onto a
 * word gap, trim-vs-cut then sees word-safe edges, and `justifyCuts` judges the refined
 * boundaries. Edges already sitting in a gap are untouched (idempotent). Overwrites
 * `startSec/endSec` in place — the apply path reads only those (KTD1); no side channel.
 *
 * Edge policy (KTD2): an edge inside a word moves to that word's nearer gap. The word is
 * EXCLUDED from the cut (edge shrinks to the far side, word survives) unless the word's
 * MIDPOINT lies inside the cut — then it is SWALLOWED whole (edge grows past it). A
 * removal that collapses to zero-or-negative span (both edges inside one word, or the
 * two edges cross after refining) is dropped. Keep/reorder ops pass through untouched.
 *
 * Fail-open: with no words (a degraded, word-timing-less transcript) every op passes
 * through unchanged — mirrors `justifyCuts` / `spanHasContentWord`. Pure + wasm-free.
 */

import type { DirectorOp } from "@framecut/hf-bridge";
import { normalizeWord, type WordTiming } from "./cut-utils";

const isRemoval = (op: DirectorOp): boolean =>
	op.op === "cut" || op.op === "take_select";

/** A word is a boundary we must not split: positive duration, real (non-empty) text.
 * Punctuation-only / zero-width tokens are ignored so they never nudge an edge. */
function isBoundaryWord(w: WordTiming): boolean {
	return w.end > w.start && normalizeWord(w.text).length > 0;
}

/** The boundary word an edge lands STRICTLY inside (`w.start < t < w.end`), or null.
 * An edge exactly on a word boundary is already in a gap — nothing to refine. */
function wordContaining(t: number, words: readonly WordTiming[]): WordTiming | null {
	for (const w of words) {
		if (!isBoundaryWord(w)) continue;
		if (w.start < t && t < w.end) return w;
	}
	return null;
}

/**
 * Refine every removal op's edges off mid-word landings. `words` are the same
 * transcript word timings the detectors use. Returns a new op list (removals with
 * corrected `startSec/endSec`, collapsed removals dropped; every other op untouched).
 */
export function refineCutWordBounds({
	ops,
	words,
}: {
	ops: readonly DirectorOp[];
	words?: readonly WordTiming[];
}): DirectorOp[] {
	if (!words || words.length === 0) return [...ops]; // fail-open: degraded transcript

	const out: DirectorOp[] = [];
	for (const op of ops) {
		if (!isRemoval(op)) {
			out.push(op);
			continue;
		}
		const startWord = wordContaining(op.startSec, words);
		const endWord = wordContaining(op.endSec, words);

		// Both edges inside the SAME word → the cut sits entirely within one word, which
		// is never a real removal. Drop it (collapse).
		if (startWord && endWord && startWord === endWord) continue;

		let startSec = op.startSec;
		let endSec = op.endSec;

		if (startWord) {
			// The cut removes [startSec, startWord.end) of this word. Swallow the word when
			// its midpoint is in the cut (majority removed → edge grows to word.start);
			// otherwise exclude it (edge shrinks to word.end, the whole word survives).
			const mid = (startWord.start + startWord.end) / 2;
			startSec = mid >= op.startSec ? startWord.start : startWord.end;
		}
		if (endWord) {
			// The cut removes [endWord.start, endSec) of this word. Swallow when the
			// midpoint is in the cut (edge grows to word.end); otherwise exclude it (edge
			// shrinks to word.start, the whole word survives).
			const mid = (endWord.start + endWord.end) / 2;
			endSec = mid <= op.endSec ? endWord.end : endWord.start;
		}

		if (endSec <= startSec) continue; // refining collapsed the span → drop
		if (startSec === op.startSec && endSec === op.endSec) {
			out.push(op); // already word-safe → byte-identical
		} else {
			out.push({ ...op, startSec, endSec });
		}
	}
	return out;
}
