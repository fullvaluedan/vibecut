// --- LLM retake-hunt planner (FrameCut, dedicated false-start / flub pass) ---
//
// The redundancy pass groups whole LINES that make the same point and keeps the
// best take. This pass is finer: it hunts RETAKES, FALSE STARTS, and FLUBS at WORD
// granularity, cutting ONLY the flubbed words (the abandoned attempt, the stumble,
// the superseded earlier take) and keeping the clean final delivery. It is the
// recall lever the eval baseline named: hundreds of missed cut words per fixture,
// dominated by retake/repeat material, live below line granularity.
//
// Candidates are WORD-INDEX spans, resolved through the shared, tested word-index
// contract in `llm-reference-sanitizer.ts` (ReferenceCatalog.words +
// startWord/endWord): the LLM never hands back raw seconds, and any out-of-range or
// hallucinated index is dropped, never thrown. Word indices are GLOBAL across the
// whole transcript; a long recording is chunked into windows that slice the LINES
// but never renumber the words (each line carries its own global word anchors), so
// the sanitizer resolves every index against the full word list.
//
// Named `llm-retake` to sit beside `llm-redundancy` (line-level repeats) and
// `llm-context` (out-of-context lines) as the third dedicated recall pass.

import { planJson, type TokenUsage } from "./author";
import type { ClaudeAuth } from "./types";
import {
	chunkTranscriptLines,
	dedupeByKey,
	transcriptExceedsBudget,
} from "./transcript-chunk";
import {
	sanitizeReferencedPlan,
	type ReferenceCatalog,
} from "./llm-reference-sanitizer";

/**
 * Bumped on every WORDING change to the retake prompt. The eval cache keys on the
 * pass INPUT payload, so a prompt revision without an input change would silently
 * replay stale cached candidates; the adapter folds this version into the payload
 * so wording changes bust the cache (the VERIFY_PROMPT_VERSION precedent).
 */
export const RETAKE_PROMPT_VERSION = 1;

/** One transcript word with its own timing (the granularity a retake cut spans). */
export interface RetakeWord {
	text: string;
	startSec: number;
	endSec: number;
}

/** A readable line the model reasons over, carrying the GLOBAL word-index anchors
 * (`startWord`..`endWord`, inclusive) of its words so the model can emit a word span
 * and the sanitizer can resolve it against the full word list. Index-based, never
 * renumbered per chunk. */
export interface RetakeLine {
	lineId: string;
	startWord: number;
	endWord: number;
	text: string;
	startSec: number;
	endSec: number;
	/** True when the pipeline's existing removals substantially cover this line; the
	 * catalog renders it [HANDLED] so the model hunts the UNHANDLED gap instead of
	 * re-finding material other passes already flagged. Set by `markHandledLines`. */
	handled?: boolean;
}

/** A timeline span the pipeline already removes (cut/take_select), in seconds. */
export interface RetakeHandledSpan {
	startSec: number;
	endSec: number;
}

/** One resolved retake cut in TIMELINE seconds (word indices already resolved). */
export interface RetakeCut {
	startSec: number;
	endSec: number;
	reason: string;
	confidence: number;
}

export interface RetakePlan {
	cuts: RetakeCut[];
}

const RETAKE_SCHEMA = {
	type: "object",
	properties: {
		operations: {
			type: "array",
			items: {
				type: "object",
				properties: {
					startWord: { type: "number" },
					endWord: { type: "number" },
					reason: { type: "string" },
					confidence: { type: "number" },
				},
				required: ["startWord", "endWord", "reason", "confidence"],
				additionalProperties: false,
			},
		},
	},
	required: ["operations"],
	additionalProperties: false,
} as const;

/** Matches `@/wasm` TICKS_PER_SECOND (wasm-free local copy). Only used for the
 * sanitizer's zero-length drop check; the resolved cut carries seconds. */
const RETAKE_TICKS_PER_SECOND = 120_000;

/** A speech gap larger than this (or terminal punctuation) breaks a new line, so the
 * transcript reads as sentence-ish lines. Mirrors the eval's `deriveSegments`. */
const RETAKE_LINE_GAP_SEC = 0.6;

/**
 * Chunking budget (R6). Deliberately SMALLER than the redundancy pass's 12k: live
 * measurement showed one big window under-fetches (a single modest batch of finds
 * regardless of transcript size), so a long recording splits into a few windows
 * (2-4 on a 20-30 minute transcript), each swept exhaustively on its own. The
 * overlap keeps a retake that straddles a window boundary visible in one window;
 * word indices stay GLOBAL across windows (lines are sliced, never renumbered).
 */
export const RETAKE_MAX_CHARS = 6_000;
const RETAKE_OVERLAP_LINES = 4;

/** A line is [HANDLED] when at least this fraction of its duration is already
 * covered by the pipeline's existing removal spans. */
export const HANDLED_LINE_COVER_FRACTION = 0.8;

/**
 * Flag the lines whose duration is substantially covered by `handledSpans` (the
 * pipeline's already-proposed removals). The catalog renders them [HANDLED] and the
 * prompt tells the model not to re-propose that material, pointing the pass at the
 * measured gap (the flubs no other pass caught) instead of re-finding easy ones.
 * Overlapping spans are unioned first so they never double-count coverage. Pure.
 */
export function markHandledLines({
	lines,
	handledSpans,
	coverFraction = HANDLED_LINE_COVER_FRACTION,
}: {
	lines: readonly RetakeLine[];
	handledSpans: readonly RetakeHandledSpan[];
	coverFraction?: number;
}): RetakeLine[] {
	const sorted = handledSpans
		.filter((s) => s.endSec > s.startSec)
		.slice()
		.sort((a, b) => a.startSec - b.startSec);
	if (sorted.length === 0) return [...lines];
	const union: RetakeHandledSpan[] = [];
	for (const s of sorted) {
		const last = union[union.length - 1];
		if (last && s.startSec <= last.endSec) {
			if (s.endSec > last.endSec) last.endSec = s.endSec;
		} else {
			union.push({ startSec: s.startSec, endSec: s.endSec });
		}
	}
	return lines.map((line) => {
		const len = line.endSec - line.startSec;
		if (len <= 0) return line;
		let covered = 0;
		for (const s of union) {
			covered += Math.max(
				0,
				Math.min(line.endSec, s.endSec) - Math.max(line.startSec, s.startSec),
			);
		}
		return covered / len >= coverFraction ? { ...line, handled: true } : line;
	});
}

/**
 * Group the timed words into sentence-ish lines, recording each line's GLOBAL word
 * index range by construction (the words are numbered once, over the full array,
 * before any chunking). A new line breaks after a speech gap over
 * RETAKE_LINE_GAP_SEC or after terminal punctuation. Pure → unit-tested.
 */
export function groupWordsIntoLines(words: readonly RetakeWord[]): RetakeLine[] {
	const lines: RetakeLine[] = [];
	let start = 0;
	for (let i = 0; i < words.length; i++) {
		const gapAfter =
			i + 1 < words.length ? words[i + 1].startSec - words[i].endSec : Infinity;
		const terminal = /[.!?]$/.test(words[i].text.trim());
		if (gapAfter > RETAKE_LINE_GAP_SEC || terminal || i === words.length - 1) {
			const text = words
				.slice(start, i + 1)
				.map((w) => w.text.trim())
				.join(" ")
				.replace(/\s+/g, " ")
				.trim();
			lines.push({
				lineId: `L${lines.length}`,
				startWord: start,
				endWord: i,
				text,
				startSec: words[start].startSec,
				endSec: words[i].endSec,
			});
			start = i + 1;
		}
	}
	return lines;
}

/** Render the lines in time order, each tagged with its GLOBAL word-index range so
 * the model can emit a startWord/endWord span, plus a [HANDLED] marker on lines the
 * pipeline already covers (absent flag = byte-identical line). No `undefined`/`NaN`
 * can leak (the indices are integers, timings are numbers, text falls back to "-"). */
export function renderRetakeCatalog(lines: readonly RetakeLine[]): string {
	return lines
		.map((line) => {
			// Full text, never truncated: the tag advertises the line's whole global
			// word range, so hiding words would invite blind (hallucinated) indices.
			const text = line.text.trim().replace(/\s+/g, " ") || "-";
			const handled = line.handled ? " [HANDLED]" : "";
			return `[${line.lineId} w${line.startWord}-${line.endWord}]${handled} (${line.startSec.toFixed(1)}-${line.endSec.toFixed(1)}) "${text}"`;
		})
		.join("\n");
}

export function buildRetakePrompt({
	lines,
	taste,
	handledSpans,
	removalHint,
}: {
	lines: readonly RetakeLine[];
	taste?: string;
	/** The pipeline's already-proposed removal spans. Lines substantially covered are
	 * rendered [HANDLED] and the model is told to hunt the UNHANDLED material instead.
	 * Absent/empty = byte-identical prompt (no marker, no instruction block). */
	handledSpans?: readonly RetakeHandledSpan[];
	/** One-line removal-share hint (e.g. "this creator removes roughly half of raw
	 * words"). Absent = the generic exhaustive wording. */
	removalHint?: string;
}): string {
	const hasHandled = handledSpans !== undefined && handledSpans.length > 0;
	const marked = hasHandled ? markHandledLines({ lines, handledSpans }) : lines;
	const handledBlock = hasHandled
		? `
Lines tagged [HANDLED] are already substantially flagged by the other editing passes - that material is handled; DO NOT re-propose it. Spend your effort on the UNHANDLED material: the retakes, false starts, and flubs hiding in the untagged lines are exactly what every other pass missed.
`
		: "";
	const removalSentence =
		removalHint ||
		"This creator, like most talking-head creators, removes a large share of the raw footage before publishing";
	return `You are an expert video EDITOR hunting RETAKES, FALSE STARTS, and FLUBBED takes in a talking-head recording's transcript. Below is every spoken line IN ORDER. Each line is tagged like [L12 w340-352]: L12 is the line number, and w340-352 gives the GLOBAL word index of its FIRST word (340) and its LAST word (352). Every word in the line is numbered sequentially from that first index, so the third word of [L12 w340-352] is global index 342. These GLOBAL word indices are absolute and never restart, even when you only see part of the transcript.

Your job: sweep the WHOLE transcript LINE BY LINE, top to bottom, and find EVERY retake, false start, flubbed take, abandoned thought, and superseded delivery - not a sample, not the obvious highlights, ALL of them. Cut ONLY the flubbed words and keep the clean final delivery:
- A FALSE START: the speaker begins a sentence, abandons it, and restarts ("so the- so the trick is..."). Cut the abandoned attempt, keep the restart.
- A RETAKE: the speaker delivers a line, then says it again cleaner (immediately or later). Cut the SUPERSEDED earlier take, keep the clean final one.
- A FLUB / stumble: a garbled or stumbled run of words the speaker corrects mid-thought. Cut the stumble, keep the correction.
- An ABANDONED THOUGHT: the speaker starts down a thread and drops it without payoff. Cut the abandoned thread.
${handledBlock}
Emit each cut as a WORD-EXTENT span: "startWord" and "endWord" are GLOBAL word indices (inclusive) covering EXACTLY the flubbed words to REMOVE - the abandoned attempt, the stumble, or the superseded earlier take. Never include the clean words the audience should hear.

Aim for EXHAUSTIVE RECALL. ${removalSentence} - a large share of what gets removed is exactly this retake/false-start material, so expect MANY finds spread across the whole recording. Over-proposing is SAFE: every candidate is a review-only row shown UNCHECKED for the editor to opt into (never auto-applied), and downstream dedupe drops any candidate that duplicates a cut another pass already made. A borderline or redundant candidate costs nothing; a missed flub ships in the final video:
- Flag a plausible flub even when you are only moderately sure, and lower its confidence instead of dropping it.
- Do NOT stop after the first few finds - keep sweeping to the LAST line.
- LEAVE intentional repetition alone: a deliberate callback, an "as I said earlier" recap, or repetition for emphasis is NOT a retake. Never flag those.
- Do NOT cut a clean take. When two deliveries are equally clean, cut the EARLIER one and keep the later.

confidence is 0..1 - set it HONESTLY: high for an obvious abandoned false start, lower for a judgment call. The lower-confidence rows are exactly the ones the editor wants to see and decide on.

TRANSCRIPT:
${renderRetakeCatalog(marked)}
${taste ? `\nEDITOR TASTE (learned from this user's past reviews - respect it):\n${taste}\n` : ""}
Respond with ONLY JSON: {"operations":[{"startWord":340,"endWord":344,"reason":"abandoned false start before the clean restart","confidence":0.0-1.0}, ...]} - each startWord and endWord a GLOBAL word index from the tags above.`;
}

/**
 * Resolve a raw retake response to TIMELINE-seconds cuts through the shared word-
 * index sanitizer (anti-hallucination, R6). Out-of-range / non-integer / reversed
 * indices are dropped, duplicates and overlaps collapse, and a malformed response
 * yields ZERO cuts, never a throw. Pure → unit-tested.
 */
export function sanitizeRetakePlan(
	raw: unknown,
	words: readonly RetakeWord[],
): RetakePlan {
	const catalog: ReferenceCatalog = {
		lines: [],
		words: words.map((w) => ({ startSec: w.startSec, endSec: w.endSec })),
	};
	const { ops } = sanitizeReferencedPlan({
		raw,
		stage: "retake",
		catalog,
		ticksPerSecond: RETAKE_TICKS_PER_SECOND,
	});
	return {
		cuts: ops.map((o) => ({
			startSec: o.startSec,
			endSec: o.endSec,
			reason: o.reason,
			confidence: o.confidence,
		})),
	};
}

/**
 * Merge retake cuts gathered across chunk windows into one list (R6). The window
 * overlap re-surfaces a straddling cut in both windows, and two separate calls
 * rarely resolve identical boundaries, so exact-key dedupe is not enough: after
 * the key dedupe, OVERLAPPING cuts are unioned into one (span = union, confidence
 * = max, reason = the higher-confidence cut's). One review row per flub. Pure,
 * unit-tested.
 */
export function mergeRetakeCuts(cuts: readonly RetakeCut[]): RetakeCut[] {
	const unique = dedupeByKey(cuts, (c) => `${c.startSec.toFixed(3)}:${c.endSec.toFixed(3)}`);
	const sorted = [...unique].sort((a, b) => a.startSec - b.startSec);
	const out: RetakeCut[] = [];
	for (const cut of sorted) {
		const last = out[out.length - 1];
		if (last && cut.startSec < last.endSec) {
			const stronger = cut.confidence > last.confidence ? cut : last;
			out[out.length - 1] = {
				startSec: last.startSec,
				endSec: Math.max(last.endSec, cut.endSec),
				reason: stronger.reason,
				confidence: stronger.confidence,
			};
			continue;
		}
		out.push(cut);
	}
	return out;
}

function addUsage(a: TokenUsage | null, b: TokenUsage | null): TokenUsage | null {
	if (!a) return b;
	if (!b) return a;
	return {
		inputTokens: a.inputTokens + b.inputTokens,
		outputTokens: a.outputTokens + b.outputTokens,
	};
}

/**
 * Build the retake prompt, dispatch it text-only, and return the sanitized cuts plus
 * token usage. Mirrors `planRedundancy`. R7 FAIL-OPEN: zero word timings contribute
 * zero candidates WITHOUT calling the LLM (never segment-granularity guesses, never a
 * throw). A transcript over the prompt budget is chunked into overlapping windows;
 * each window is planned + sanitized against the FULL word set (so every GLOBAL index
 * resolves even though the window showed a slice), then the cuts are merged/deduped.
 */
export async function planRetake({
	words,
	taste,
	handledSpans,
	removalHint,
	auth,
}: {
	words: readonly RetakeWord[];
	taste?: string;
	/** The pipeline's already-proposed removal spans ([HANDLED] mask; see the prompt). */
	handledSpans?: readonly RetakeHandledSpan[];
	/** One-line removal-share hint; absent = the generic exhaustive wording. */
	removalHint?: string;
	auth: ClaudeAuth;
}): Promise<{ plan: RetakePlan; usage: TokenUsage | null }> {
	// R7: no word timings → no candidates, and the LLM is never invoked (guard first).
	if (words.length === 0) return { plan: { cuts: [] }, usage: null };
	const lines = groupWordsIntoLines(words);
	if (lines.length === 0) return { plan: { cuts: [] }, usage: null };

	if (!transcriptExceedsBudget({ lines, maxChars: RETAKE_MAX_CHARS })) {
		const prompt = buildRetakePrompt({ lines, taste, handledSpans, removalHint });
		const { raw, usage } = await planJson({ prompt, auth, schema: RETAKE_SCHEMA });
		return { plan: sanitizeRetakePlan(raw, words), usage };
	}

	const windows = chunkTranscriptLines({
		lines,
		maxChars: RETAKE_MAX_CHARS,
		overlapLines: RETAKE_OVERLAP_LINES,
	});
	const allCuts: RetakeCut[] = [];
	let usage: TokenUsage | null = null;
	for (const window of windows) {
		const prompt = buildRetakePrompt({ lines: window, taste, handledSpans, removalHint });
		const { raw, usage: u } = await planJson({ prompt, auth, schema: RETAKE_SCHEMA });
		// Sanitize against the FULL word set so every GLOBAL index resolves even though
		// the window only showed a slice of the lines (words are never renumbered).
		allCuts.push(...sanitizeRetakePlan(raw, words).cuts);
		usage = addUsage(usage, u);
	}
	return { plan: { cuts: mergeRetakeCuts(allCuts) }, usage };
}
