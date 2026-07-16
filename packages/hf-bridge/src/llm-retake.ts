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
 * Chunking budget (R6): a transcript whose line text exceeds this is split into
 * overlapping windows so a long recording never overflows the prompt and silently
 * loses its tail. Matches the redundancy pass's budget; the overlap keeps a retake
 * that straddles a window boundary visible in one window.
 */
const RETAKE_MAX_CHARS = 12_000;
const RETAKE_OVERLAP_LINES = 4;

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
 * the model can emit a startWord/endWord span. No `undefined`/`NaN` can leak (the
 * indices are integers, timings are numbers, text falls back to "-"). */
export function renderRetakeCatalog(lines: readonly RetakeLine[]): string {
	return lines
		.map((line) => {
			const text = line.text.trim().replace(/\s+/g, " ").slice(0, 200) || "-";
			return `[${line.lineId} w${line.startWord}-${line.endWord}] (${line.startSec.toFixed(1)}-${line.endSec.toFixed(1)}) "${text}"`;
		})
		.join("\n");
}

export function buildRetakePrompt({
	lines,
	taste,
}: {
	lines: readonly RetakeLine[];
	taste?: string;
}): string {
	return `You are an expert video EDITOR hunting RETAKES, FALSE STARTS, and FLUBBED takes in a talking-head recording's transcript. Below is every spoken line IN ORDER. Each line is tagged like [L12 w340-352]: L12 is the line number, and w340-352 gives the GLOBAL word index of its FIRST word (340) and its LAST word (352). Every word in the line is numbered sequentially from that first index, so the third word of [L12 w340-352] is global index 342. These GLOBAL word indices are absolute and never restart, even when you only see part of the transcript.

Your job: find every RETAKE, FALSE START, and FLUB, and cut ONLY the flubbed words while keeping the clean final delivery:
- A FALSE START: the speaker begins a sentence, abandons it, and restarts ("so the- so the trick is..."). Cut the abandoned attempt, keep the restart.
- A RETAKE: the speaker delivers a line, then immediately says it again cleaner. Cut the SUPERSEDED earlier take, keep the clean final one.
- A FLUB / stumble: a garbled or stumbled run of words the speaker corrects mid-thought. Cut the stumble, keep the correction.

Emit each cut as a WORD-EXTENT span: "startWord" and "endWord" are GLOBAL word indices (inclusive) covering EXACTLY the flubbed words to REMOVE - the abandoned attempt, the stumble, or the superseded earlier take. Never include the clean words the audience should hear.

Aim for RECALL. This is the recall pass: surface every plausible retake or false-start for review. The editor reviews every candidate before anything is removed, and these rows start UNCHECKED, so a borderline candidate costs nothing:
- Flag a plausible flub even when you are only moderately sure, and lower its confidence instead of dropping it.
- LEAVE intentional repetition alone: a deliberate callback, an "as I said earlier" recap, or repetition for emphasis is NOT a retake. Never flag those.
- Do NOT cut a clean take. When two deliveries are equally clean, cut the EARLIER one and keep the later.

confidence is 0..1 - set it HONESTLY: high for an obvious abandoned false start, lower for a judgment call. The lower-confidence rows are exactly the ones the editor wants to see and decide on.

TRANSCRIPT:
${renderRetakeCatalog(lines)}
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
 * Merge retake cuts gathered across chunk windows into one list (R6). The overlap
 * re-surfaces a straddling cut in two windows, so dedupe by span key. Pure →
 * unit-tested.
 */
export function mergeRetakeCuts(cuts: readonly RetakeCut[]): RetakeCut[] {
	return dedupeByKey(cuts, (c) => `${c.startSec.toFixed(3)}:${c.endSec.toFixed(3)}`);
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
	auth,
}: {
	words: readonly RetakeWord[];
	taste?: string;
	auth: ClaudeAuth;
}): Promise<{ plan: RetakePlan; usage: TokenUsage | null }> {
	// R7: no word timings → no candidates, and the LLM is never invoked (guard first).
	if (words.length === 0) return { plan: { cuts: [] }, usage: null };
	const lines = groupWordsIntoLines(words);
	if (lines.length === 0) return { plan: { cuts: [] }, usage: null };

	if (!transcriptExceedsBudget({ lines, maxChars: RETAKE_MAX_CHARS })) {
		const prompt = buildRetakePrompt({ lines, taste });
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
		const prompt = buildRetakePrompt({ lines: window, taste });
		const { raw, usage: u } = await planJson({ prompt, auth, schema: RETAKE_SCHEMA });
		// Sanitize against the FULL word set so every GLOBAL index resolves even though
		// the window only showed a slice of the lines (words are never renumbered).
		allCuts.push(...sanitizeRetakePlan(raw, words).cuts);
		usage = addUsage(usage, u);
	}
	return { plan: { cuts: mergeRetakeCuts(allCuts) }, usage };
}
