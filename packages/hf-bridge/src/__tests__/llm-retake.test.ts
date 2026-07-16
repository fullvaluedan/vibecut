import { describe, expect, test } from "bun:test";
import {
	buildRetakePrompt,
	groupWordsIntoLines,
	HANDLED_LINE_COVER_FRACTION,
	markHandledLines,
	mergeRetakeCuts,
	planRetake,
	renderRetakeCatalog,
	RETAKE_MAX_CHARS,
	sanitizeRetakePlan,
	type RetakeWord,
} from "../llm-retake";
import { chunkTranscriptLines } from "../transcript-chunk";
import type { ClaudeAuth } from "../types";

/** Words on a 0.3s grid (0.02s gaps → no gap-break; only terminal punctuation breaks). */
const mkWords = (text: string): RetakeWord[] =>
	text
		.split(/\s+/)
		.filter(Boolean)
		.map((w, i) => ({ text: w, startSec: i * 0.3, endSec: i * 0.3 + 0.28 }));

/** Four words with distinct, resolvable timings for the word-index resolution tests. */
const WORDS: RetakeWord[] = [
	{ text: "a", startSec: 0.0, endSec: 0.4 },
	{ text: "b", startSec: 0.4, endSec: 0.9 },
	{ text: "c", startSec: 1.0, endSec: 1.6 },
	{ text: "d", startSec: 2.0, endSec: 2.5 },
];

describe("groupWordsIntoLines", () => {
	test("assigns GLOBAL, contiguous word indices, breaking on terminal punctuation", () => {
		const lines = groupWordsIntoLines(mkWords("one two. three four five."));
		expect(lines.map((l) => [l.startWord, l.endWord])).toEqual([
			[0, 1],
			[2, 4],
		]);
		expect(lines.map((l) => l.lineId)).toEqual(["L0", "L1"]);
		expect(lines[1].text).toBe("three four five.");
	});

	test("empty words → no lines", () => {
		expect(groupWordsIntoLines([])).toEqual([]);
	});
});

describe("buildRetakePrompt (load-bearing substrings)", () => {
	const prompt = buildRetakePrompt({
		lines: groupWordsIntoLines(mkWords("so the- so the trick. and now the demo.")),
	});

	test("carries the RECALL framing", () => {
		expect(prompt).toContain("RECALL");
	});

	test("defines retakes and false starts", () => {
		expect(prompt.toLowerCase()).toContain("retake");
		expect(prompt.toLowerCase()).toContain("false start");
		expect(prompt.toLowerCase()).toContain("flub");
	});

	test("demands a word-extent span via startWord/endWord", () => {
		expect(prompt).toContain("startWord");
		expect(prompt).toContain("endWord");
		expect(prompt).toContain("WORD-EXTENT");
	});

	test("exposes GLOBAL word-index anchors on each line", () => {
		expect(prompt).toContain("GLOBAL");
		expect(prompt).toContain("[L0 w0-"); // first line's global word anchor
	});

	test("keeps the clean take (do-not-cut instruction) and reviews unchecked", () => {
		expect(prompt).toContain("keep the clean");
		expect(prompt).toContain("UNCHECKED");
	});

	test("no undefined/NaN leaks, even for a feature-less line", () => {
		expect(prompt).not.toContain("undefined");
		expect(prompt).not.toContain("NaN");
		const out = renderRetakeCatalog([
			{ lineId: "L0", startWord: 0, endWord: 0, text: "", startSec: 0, endSec: 1 },
		]);
		expect(out).not.toContain("undefined");
		expect(out).not.toContain("NaN");
		expect(out).toContain('"-"'); // empty text falls back to "-"
	});

	test("demands an EXHAUSTIVE whole-transcript sweep, not a sample", () => {
		expect(prompt).toContain("EXHAUSTIVE RECALL");
		expect(prompt).toContain("LINE BY LINE");
		expect(prompt).toContain("EVERY retake");
		expect(prompt).toContain("abandoned thought");
		expect(prompt).toContain("superseded delivery");
		expect(prompt).toContain("not a sample");
		expect(prompt).toContain("keep sweeping to the LAST line");
	});

	test("states over-proposing is safe (review-only, never auto-applied, deduped)", () => {
		expect(prompt).toContain("Over-proposing is SAFE");
		expect(prompt).toContain("never auto-applied");
		expect(prompt).toContain("dedupe");
	});
});

describe("buildRetakePrompt removal hint", () => {
	const lines = groupWordsIntoLines(mkWords("one two. three four five."));

	test("a provided removalHint appears verbatim, replacing the generic wording", () => {
		const hint = "this creator removes roughly half of raw words";
		const prompt = buildRetakePrompt({ lines, removalHint: hint });
		expect(prompt).toContain(hint);
		expect(prompt).not.toContain("like most talking-head creators");
	});

	test("absent removalHint keeps the generic large-share wording", () => {
		const prompt = buildRetakePrompt({ lines });
		expect(prompt).toContain("removes a large share of the raw footage");
	});
});

describe("buildRetakePrompt handled-region mask", () => {
	// line0 = words 0-1 spanning [0, 0.58]; line1 = words 2-4 spanning [0.6, 1.48].
	const lines = groupWordsIntoLines(mkWords("one two. three four five."));

	test("lines substantially covered by handledSpans are tagged [HANDLED]", () => {
		const prompt = buildRetakePrompt({
			lines,
			handledSpans: [{ startSec: 0, endSec: 0.58 }], // covers line0 fully
		});
		expect(prompt).toContain("[L0 w0-1] [HANDLED]");
		expect(prompt).not.toContain("[L1 w2-4] [HANDLED]"); // uncovered line stays untagged
	});

	test("the mask instruction demands hunting the UNHANDLED material", () => {
		const prompt = buildRetakePrompt({
			lines,
			handledSpans: [{ startSec: 0, endSec: 0.58 }],
		});
		expect(prompt).toContain("DO NOT re-propose");
		expect(prompt).toContain("UNHANDLED");
	});

	test("absent/empty handledSpans yields a byte-identical prompt (no marker, no block)", () => {
		const bare = buildRetakePrompt({ lines });
		expect(buildRetakePrompt({ lines, handledSpans: [] })).toBe(bare);
		expect(buildRetakePrompt({ lines, handledSpans: undefined, removalHint: undefined })).toBe(
			bare,
		);
		expect(bare).not.toContain("[HANDLED]");
	});
});

describe("markHandledLines", () => {
	const line = (startSec: number, endSec: number, i = 0) => ({
		lineId: `L${i}`,
		startWord: i,
		endWord: i,
		text: "x",
		startSec,
		endSec,
	});

	test("full coverage marks the line; partial coverage below the fraction does not", () => {
		expect(HANDLED_LINE_COVER_FRACTION).toBe(0.8);
		const [full] = markHandledLines({
			lines: [line(0, 1)],
			handledSpans: [{ startSec: 0, endSec: 1 }],
		});
		expect(full.handled).toBe(true);
		const [half] = markHandledLines({
			lines: [line(0, 1)],
			handledSpans: [{ startSec: 0, endSec: 0.5 }], // 50% < 80%
		});
		expect(half.handled).toBeUndefined();
	});

	test("overlapping spans are unioned, never double-counted", () => {
		// Two spans sum to 1.0s of raw overlap but union to only 0.5s of the 1s line.
		const [out] = markHandledLines({
			lines: [line(0, 1)],
			handledSpans: [
				{ startSec: 0, endSec: 0.5 },
				{ startSec: 0.1, endSec: 0.5 },
			],
		});
		expect(out.handled).toBeUndefined();
	});

	test("empty spans return the lines unmarked", () => {
		const [out] = markHandledLines({ lines: [line(0, 1)], handledSpans: [] });
		expect(out.handled).toBeUndefined();
	});
});

describe("chunking preserves GLOBAL word indices", () => {
	test("the chunk budget is the smaller exhaustive-sweep size (6k, not redundancy's 12k)", () => {
		// Pins the under-fetch fix: a long transcript splits into a few windows, each
		// swept exhaustively, instead of one over-stuffed prompt.
		expect(RETAKE_MAX_CHARS).toBe(6_000);
	});

	test("a late window still renders its lines' original (non-zero) word anchors", () => {
		// 40 single-word sentences → 40 one-word lines, global word indices 0..39.
		const words = mkWords(
			Array.from({ length: 40 }, (_, i) => `word${i}.`).join(" "),
		);
		const lines = groupWordsIntoLines(words);
		expect(lines).toHaveLength(40);
		expect(lines[0].startWord).toBe(0);
		expect(lines[39].startWord).toBe(39);

		const windows = chunkTranscriptLines({ lines, maxChars: 80, overlapLines: 2 });
		expect(windows.length).toBeGreaterThan(1);

		const lastWindow = windows[windows.length - 1];
		const first = lastWindow[0];
		// The window's lines were SLICED, never renumbered: their word indices are global.
		expect(first.startWord).toBeGreaterThan(0);
		const prompt = buildRetakePrompt({ lines: lastWindow });
		expect(prompt).toContain(`w${first.startWord}-${first.endWord}`);
		// The first global line (w0) is NOT in a late window's prompt.
		expect(prompt).not.toContain("[L0 w0-");
	});
});

describe("sanitizeRetakePlan (word-index → seconds via the shared sanitizer)", () => {
	test("a valid word-index span resolves to seconds (word.start .. word.end)", () => {
		const plan = sanitizeRetakePlan(
			{ operations: [{ startWord: 1, endWord: 2, reason: "flub", confidence: 0.8 }] },
			WORDS,
		);
		expect(plan.cuts).toHaveLength(1);
		expect(plan.cuts[0]).toMatchObject({
			startSec: 0.4, // WORDS[1].startSec
			endSec: 1.6, // WORDS[2].endSec
			reason: "flub",
			confidence: 0.8,
		});
	});

	test("a hallucinated (out-of-range) index is dropped; a valid sibling survives", () => {
		const plan = sanitizeRetakePlan(
			{
				operations: [
					{ startWord: 0, endWord: 1, reason: "ok", confidence: 0.9 },
					{ startWord: 2, endWord: 99, reason: "bad", confidence: 0.9 }, // out of range
				],
			},
			WORDS,
		);
		expect(plan.cuts).toHaveLength(1);
		expect(plan.cuts[0].startSec).toBe(0); // the valid sibling
	});

	test("never throws on malformed shapes (yields zero cuts)", () => {
		expect(sanitizeRetakePlan("not json{", WORDS).cuts).toEqual([]);
		expect(sanitizeRetakePlan({}, WORDS).cuts).toEqual([]);
		expect(sanitizeRetakePlan(null, WORDS).cuts).toEqual([]);
	});
});

describe("mergeRetakeCuts (windowed dedupe)", () => {
	test("a cut surfaced in two overlapping windows collapses to one", () => {
		const merged = mergeRetakeCuts([
			{ startSec: 1, endSec: 2, reason: "a", confidence: 0.9 },
			{ startSec: 1, endSec: 2, reason: "b", confidence: 0.8 }, // same span, next window
			{ startSec: 3, endSec: 4, reason: "c", confidence: 0.7 },
		]);
		expect(merged.map((c) => [c.startSec, c.endSec])).toEqual([
			[1, 2],
			[3, 4],
		]);
	});
});

describe("planRetake fail-open (R7)", () => {
	// A custom endpoint that would REJECT fast if dispatched - proves the empty-words
	// guard returns BEFORE any LLM call (a live call would fetch this dead host).
	const NO_CALL_AUTH: ClaudeAuth = {
		mode: "custom",
		baseUrl: "http://127.0.0.1:9/v1",
		model: "unused",
	};

	test("empty words → zero candidates WITHOUT invoking the LLM", async () => {
		await expect(planRetake({ words: [], auth: NO_CALL_AUTH })).resolves.toEqual({
			plan: { cuts: [] },
			usage: null,
		});
	});
});
