/**
 * Shared floor + content-word guard for the second-pass sliver cleanup (2P-U1/U2,
 * KTD2/KTD7). Both the removal-range coalescing (never swallow a real word) and the
 * micro-clip sweep (auto-remove only content-free shards) route their "is this span
 * safe to remove" decision through ONE test here, so they can never disagree.
 *
 * Pure + wasm-free → bun-testable.
 */

import { normalizeWord, type WordTiming } from "./cut-utils";
import { isFillerToken } from "./filler-words";

/**
 * No clip shorter than this (frames at the project fps) may survive a Director apply
 * unless it holds a complete content word (~0.5s at 30fps). One place, converted via
 * the project fps everywhere it's used (coalescing gap, micro-clip sweep, invariant
 * tests) - mirrors the PAUSE_FLOOR_FRAMES precedent.
 */
export const MIN_SURVIVING_CLIP_FRAMES = 15;

/**
 * True when a COMPLETE content word lives inside `[startSec, endSec)`: a word whose
 * whole span is within the range (a word only touching a boundary - partly outside -
 * does NOT count, so a real word straddling a cut edge is never mistaken for
 * swallow-able noise) and which is not a filler token.
 *
 * Returns `false` when `words` is empty/absent - there is genuinely no known content
 * word. Callers decide the fail-open direction from that: coalescing refuses to merge
 * without words, the micro-clip sweep leaves shards opt-in without words.
 */
export function spanHasContentWord({
	startSec,
	endSec,
	words,
}: {
	startSec: number;
	endSec: number;
	words?: readonly WordTiming[];
}): boolean {
	if (!words || words.length === 0) return false;
	for (const w of words) {
		if (w.start >= startSec && w.end <= endSec && w.end > w.start) {
			const norm = normalizeWord(w.text);
			if (norm.length === 0) continue;
			if (isFillerToken(norm)) continue;
			return true;
		}
	}
	return false;
}

/**
 * The content word (trimmed text) inside `[startSec, endSec)`, or `null`. Same test
 * as `spanHasContentWord`; the micro-clip sweep uses it to name the word in a review
 * row's reason.
 */
export function firstContentWord({
	startSec,
	endSec,
	words,
}: {
	startSec: number;
	endSec: number;
	words?: readonly WordTiming[];
}): string | null {
	if (!words || words.length === 0) return null;
	for (const w of words) {
		if (w.start >= startSec && w.end <= endSec && w.end > w.start) {
			const norm = normalizeWord(w.text);
			if (norm.length === 0) continue;
			if (isFillerToken(norm)) continue;
			return w.text.trim();
		}
	}
	return null;
}
