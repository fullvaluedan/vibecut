/**
 * Assembled-transcript builder (round 12 U2/R3/KTD4). The final-read side of the
 * verify pass judges join fragments against the ASSEMBLED result - the text that
 * remains, in order, after applying every default-accepted removal - which no
 * other layer ever materializes. This module builds it, plus the OFFERED
 * join-fragment rows the verify prompt adjudicates.
 *
 * Conventions shared with the join-texture layer (KTD1): a word belongs to a
 * removal when its MIDPOINT falls inside the merged default-accepted spans
 * (cut/take_select, defaultAccept absent or true); overlapping/touching spans
 * merge first so one covered region reads as one cut. Where two kept runs meet
 * across a removal, a " [CUT] " marker is inserted so the model can see every
 * join seam.
 *
 * Prompt-size cap: past ASSEMBLED_TRANSCRIPT_MAX_CHARS the full text is replaced
 * by timestamped WINDOWS around each join fragment (WINDOW_CONTEXT_WORDS kept
 * words each side, overlapping windows merged) - the joins are what the final
 * read judges, so the windows keep every judged seam in view at bounded cost.
 *
 * Pure + wasm-free -> bun-testable.
 */

import type { DirectorOp, VerifyJoinFragment } from "@framecut/hf-bridge";
import { isMidpointContained, type WordTiming } from "./cut-utils";

/** Past this many characters the full assembled text is replaced by windows. */
export const ASSEMBLED_TRANSCRIPT_MAX_CHARS = 24_000;

/** Kept words on EACH side of a join fragment in window mode (a few hundred
 * words total per window, centered on the join). */
export const WINDOW_CONTEXT_WORDS = 150;

/** Kept words of context on each side of a join-fragment row. */
export const JOIN_CONTEXT_WORDS = 15;

/** The seam marker inserted where two cuts meet in the assembled text. */
export const CUT_MARKER = "[CUT]";

/** One kept word plus whether at least one removed word precedes it (a seam). */
interface KeptWord {
	text: string;
	start: number;
	end: number;
	/** True when the previous transcript word(s) were removed: a cut seam sits
	 * immediately before this word. */
	cutBefore: boolean;
}

/** Merge the default-accepted removal spans (cut/take_select with defaultAccept
 * absent or true) into sorted, non-overlapping regions. Mirrors join-texture. */
function mergeAcceptedSpans(
	ops: readonly DirectorOp[],
): { startSec: number; endSec: number }[] {
	const spans = ops
		.filter(
			(op) =>
				(op.op === "cut" || op.op === "take_select") &&
				op.defaultAccept !== false,
		)
		.map((op) => ({ startSec: op.startSec, endSec: op.endSec }))
		.sort((a, b) => a.startSec - b.startSec);
	const merged: { startSec: number; endSec: number }[] = [];
	for (const span of spans) {
		const last = merged[merged.length - 1];
		if (last && span.startSec <= last.endSec) {
			last.endSec = Math.max(last.endSec, span.endSec);
		} else {
			merged.push({ ...span });
		}
	}
	return merged;
}

/** Walk the transcript in order and keep every word whose midpoint is NOT inside
 * a merged accepted removal, marking each kept word that follows one or more
 * removed words (`cutBefore`: a seam). */
function collectKeptWords({
	ops,
	words,
}: {
	ops: readonly DirectorOp[];
	words: readonly WordTiming[];
}): KeptWord[] {
	const removedSpans = mergeAcceptedSpans(ops);
	const kept: KeptWord[] = [];
	let pendingCut = false;
	for (const w of words) {
		const removed = removedSpans.some((s) =>
			isMidpointContained({
				spanStart: w.start,
				spanEnd: w.end,
				containerStart: s.startSec,
				containerEnd: s.endSec,
			}),
		);
		if (removed) {
			pendingCut = true;
			continue;
		}
		kept.push({ text: w.text.trim(), start: w.start, end: w.end, cutBefore: pendingCut });
		pendingCut = false;
	}
	return kept;
}

/** Render a run of kept words, inserting the seam marker before every word whose
 * `cutBefore` is set (skipped for the run's first word - a window or the whole
 * text never LEADS with a marker). */
function renderKeptRun(run: readonly KeptWord[]): string {
	return run
		.map((w, i) => (i > 0 && w.cutBefore ? `${CUT_MARKER} ${w.text}` : w.text))
		.join(" ");
}

/** Kept-word index range [first, last] whose midpoints fall inside `span`; falls
 * back to the nearest kept word at/after the span start when the span holds no
 * kept word (defensive - a join fragment always carries kept words). */
function keptIndexRange(
	kept: readonly KeptWord[],
	span: { startSec: number; endSec: number },
): { first: number; last: number } {
	let first = -1;
	let last = -1;
	for (let i = 0; i < kept.length; i++) {
		const w = kept[i];
		if (
			isMidpointContained({
				spanStart: w.start,
				spanEnd: w.end,
				containerStart: span.startSec,
				containerEnd: span.endSec,
			})
		) {
			if (first < 0) first = i;
			last = i;
		}
	}
	if (first < 0) {
		let idx = kept.findIndex((w) => (w.start + w.end) / 2 >= span.startSec);
		if (idx < 0) idx = kept.length - 1;
		first = idx;
		last = idx;
	}
	return { first, last };
}

/**
 * Build the ASSEMBLED post-cut transcript: the kept words in order with a
 * " [CUT] " marker at every seam where two cuts meet. Under `maxChars` the full
 * text returns; over it, timestamped windows around each `joinSpans` entry
 * (WINDOW_CONTEXT_WORDS kept words per side, overlapping windows merged) return
 * instead. With no join spans an oversized text truncates at a word boundary
 * with a trailing [TRUNCATED] note. Empty words or an all-removed transcript
 * yields "". Pure.
 */
export function buildAssembledTranscript({
	words,
	ops,
	joinSpans = [],
	maxChars = ASSEMBLED_TRANSCRIPT_MAX_CHARS,
}: {
	words: readonly WordTiming[];
	/** The final operation list (default-accepted removals define the cut). */
	ops: readonly DirectorOp[];
	/** Join-fragment spans to center windows on when the text exceeds the cap. */
	joinSpans?: readonly { startSec: number; endSec: number }[];
	maxChars?: number;
}): string {
	const kept = collectKeptWords({ ops, words });
	if (kept.length === 0) return "";
	const full = renderKeptRun(kept);
	if (full.length <= maxChars) return full;

	if (joinSpans.length === 0) {
		// No joins to center on: truncate at a word boundary (edge case - the
		// caller only sends the assembled text alongside join fragments).
		const cut = full.lastIndexOf(" ", maxChars);
		return `${full.slice(0, cut > 0 ? cut : maxChars)}\n[TRUNCATED]`;
	}

	// Window mode: one kept-word index range per join span, widened by the
	// context budget, then merged where ranges overlap or touch so no text
	// duplicates across windows.
	const ranges = joinSpans
		.map((span) => {
			const { first, last } = keptIndexRange(kept, span);
			return {
				lo: Math.max(0, first - WINDOW_CONTEXT_WORDS),
				hi: Math.min(kept.length - 1, last + WINDOW_CONTEXT_WORDS),
			};
		})
		.sort((a, b) => a.lo - b.lo);
	const merged: { lo: number; hi: number }[] = [];
	for (const r of ranges) {
		const last = merged[merged.length - 1];
		if (last && r.lo <= last.hi + 1) {
			last.hi = Math.max(last.hi, r.hi);
		} else {
			merged.push({ ...r });
		}
	}
	return merged
		.map(({ lo, hi }) => {
			const run = kept.slice(lo, hi + 1);
			const label = `[window ${run[0].start.toFixed(1)}s-${run[run.length - 1].end.toFixed(1)}s]`;
			return `${label}\n${renderKeptRun(run)}`;
		})
		.join("\n\n");
}

/**
 * Build the OFFERED join-fragment rows the verify pass adjudicates: one row per
 * word-bearing OFFERED join op (category "join", defaultAccept false), carrying
 * the op's stable id, the stranded kept text, its span, and up to
 * `contextWords` KEPT words on each side (removed words never appear in the
 * context - the model must read the fragment exactly as the assembled result
 * strands it). AUTO sliver joins (wordless) are never fragments. A join op
 * whose span holds no kept word is skipped (defensive). Pure.
 */
export function collectJoinFragments({
	ops,
	joinOps,
	words,
	contextWords = JOIN_CONTEXT_WORDS,
}: {
	/** The final operation list (default-accepted removals define kept text). */
	ops: readonly DirectorOp[];
	/** The detected join ops (detectJoinTextureCuts output, not yet appended). */
	joinOps: readonly DirectorOp[];
	words: readonly WordTiming[];
	contextWords?: number;
}): VerifyJoinFragment[] {
	const kept = collectKeptWords({ ops, words });
	const out: VerifyJoinFragment[] = [];
	for (const op of joinOps) {
		if (op.category !== "join" || op.defaultAccept !== false) continue;
		let first = -1;
		let last = -1;
		for (let i = 0; i < kept.length; i++) {
			const w = kept[i];
			if (
				isMidpointContained({
					spanStart: w.start,
					spanEnd: w.end,
					containerStart: op.startSec,
					containerEnd: op.endSec,
				})
			) {
				if (first < 0) first = i;
				last = i;
			}
		}
		if (first < 0) continue;
		const text = kept
			.slice(first, last + 1)
			.map((w) => w.text)
			.join(" ");
		const contextBefore = kept
			.slice(Math.max(0, first - contextWords), first)
			.map((w) => w.text)
			.join(" ");
		const contextAfter = kept
			.slice(last + 1, last + 1 + contextWords)
			.map((w) => w.text)
			.join(" ");
		out.push({
			id: op.id,
			text,
			startSec: op.startSec,
			endSec: op.endSec,
			contextBefore,
			contextAfter,
		});
	}
	return out;
}
