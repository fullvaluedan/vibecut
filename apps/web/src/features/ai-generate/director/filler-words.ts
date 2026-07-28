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

/**
 * Speech flows THROUGH a filler when the gap to the nearest real word is under
 * this on BOTH sides (seconds). Fluent inter-word gaps sit around 0-0.15s; a
 * hesitation pause around a droppable filler is 0.3s+. Round 9 (Dan): cutting a
 * filler out of continuous speech is audible, so those rows start unchecked.
 */
const SMOOTH_GAP_SEC = 0.2;

/** Reason suffix on demoted mid-flow fillers, so the row explains itself. */
const SMOOTH_SUFFIX = " (mid-sentence, speech flows through)";

/** Nearest neighbor with real duration, scanning outward from `from`; undefined at the clip edge. */
function nearestValid(
	words: WordTiming[],
	from: number,
	step: -1 | 1,
): WordTiming | undefined {
	for (let j = from; j >= 0 && j < words.length; j += step) {
		const word = words[j];
		if (word.end > word.start) return word;
	}
	return undefined;
}

/**
 * True when speech flows straight through the filler span [start,end): a real
 * word sits within SMOOTH_GAP_SEC on BOTH sides. A missing neighbor (clip edge)
 * counts as a pause, so edge fillers stay auto-cut.
 */
function flowsThrough({
	words,
	prevIndex,
	nextIndex,
	start,
	end,
}: {
	words: WordTiming[];
	prevIndex: number;
	nextIndex: number;
	start: number;
	end: number;
}): boolean {
	const prev = nearestValid(words, prevIndex, -1);
	const next = nearestValid(words, nextIndex, 1);
	if (!prev || !next) return false;
	return start - prev.end < SMOOTH_GAP_SEC && next.start - end < SMOOTH_GAP_SEC;
}

/**
 * True when a NORMALIZED token is a standalone disfluency ("um"/"uh"/"er"...). The
 * shared content-word guard (coalescing + micro-clip sweep) reuses this so both
 * classify fillers exactly as this detector does, rather than re-inventing the set.
 * Two-word hedges are deliberately not covered: those words carry meaning alone.
 */
export function isFillerToken(normalized: string): boolean {
	return SINGLE_FILLERS.has(normalized);
}

function fillerOp({
	start,
	end,
	reason,
	confidence,
	defaultAccept,
}: {
	start: number;
	end: number;
	reason: string;
	confidence: number;
	/** `false` = surfaced unchecked (mid-flow filler); omit for the accepted default. */
	defaultAccept?: boolean;
}): DirectorOp {
	return {
		id: `fil-${stableCutId(`${start.toFixed(3)}:${end.toFixed(3)}`)}`,
		op: "cut",
		startSec: start,
		endSec: end,
		reason,
		confidence,
		category: "filler",
		...(defaultAccept === false ? { defaultAccept } : {}),
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
				const smooth = flowsThrough({
					words,
					prevIndex: i - 1,
					nextIndex: i + 2,
					start: cur.start,
					end: next.end,
				});
				ops.push(
					fillerOp({
						start: cur.start,
						end: next.end,
						reason: `Filler "${cur.text.trim()} ${next.text.trim()}"${smooth ? SMOOTH_SUFFIX : ""}`,
						confidence: 0.55,
						...(smooth ? { defaultAccept: false } : {}),
					}),
				);
				i += 2;
				continue;
			}
		}

		// Standalone filler word.
		if (SINGLE_FILLERS.has(norm)) {
			const smooth = flowsThrough({
				words,
				prevIndex: i - 1,
				nextIndex: i + 1,
				start: cur.start,
				end: cur.end,
			});
			ops.push(
				fillerOp({
					start: cur.start,
					end: cur.end,
					reason: `Filler "${cur.text.trim()}"${smooth ? SMOOTH_SUFFIX : ""}`,
					confidence: 0.7,
					...(smooth ? { defaultAccept: false } : {}),
				}),
			);
		}
		i++;
	}
	return ops;
}
