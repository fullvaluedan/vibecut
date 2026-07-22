import { describe, expect, test } from "bun:test";
import type { ReferenceWord } from "../llm-reference-sanitizer";
import type { RedundancyLine } from "../llm-redundancy";
import {
	buildVerifyPrompt,
	planVerify,
	sanitizeVerifyPlan,
	type VerifyCandidate,
	type VerifyJoinFragment,
} from "../llm-verify";
import type { ClaudeAuth } from "../types";

/** Word i spans [i, i+0.5]; 0.5 fractions stay exact for toEqual. */
const mkWords = (n: number): ReferenceWord[] =>
	Array.from({ length: n }, (_, i) => ({ startSec: i, endSec: i + 0.5 }));

/** Line L#{i} spans [i*2, i*2 + 1.5]. */
const mkLines = (...texts: string[]): RedundancyLine[] =>
	texts.map((text, i) => ({
		lineId: `L${i}`,
		startSec: i * 2,
		endSec: i * 2 + 1.5,
		text,
	}));

const WORDS = mkWords(12);
const LINES = mkLines("l0", "l1", "l2", "l3", "l4", "l5", "l6");

// C0 retake: word range [w2-w8] -> span [2, 8.5]; coveredText is 7 tokens, one per
// covered word index, so the anchored runs are exact.
const retakeC: VerifyCandidate = {
	category: "retake",
	startSec: 2,
	endSec: 8.5,
	reason: "abandoned false start before the clean restart",
	confidence: 0.7,
	coveredText: "so the- so the trick is simple",
	startWord: 2,
	endWord: 8,
};
// C1 structural: line range [L2-L5] -> span [4, 11.5].
const structC: VerifyCandidate = {
	category: "structural",
	startSec: 4,
	endSec: 11.5,
	reason: "tangent about lunch that never pays off",
	confidence: 0.5,
	coveredText: "a whole tangent about lunch",
	startLineId: "L2",
	endLineId: "L5",
};

// Two join fragments for the final-read block (round 12 U2).
const fragA: VerifyJoinFragment = {
	id: "join-abc",
	text: "so...",
	startSec: 12.3,
	endSec: 13.1,
	contextBefore: "we wrapped the demo",
	contextAfter: "lets talk deployment",
};
const fragB: VerifyJoinFragment = {
	id: "join-def",
	text: "and look at that",
	startSec: 44.0,
	endSec: 45.2,
	contextBefore: "hit the button",
	contextAfter: "next step is",
};

describe("buildVerifyPrompt (load-bearing substrings)", () => {
	const prompt = buildVerifyPrompt({ candidates: [retakeC, structC], lines: LINES });

	test("frames the job as damage review, not taste", () => {
		expect(prompt).toContain("DAMAGE REVIEW");
		expect(prompt.toLowerCase()).toContain("damage review, not taste");
	});

	test("names the keep/reject/tighten verdict enum", () => {
		expect(prompt).toContain('"keep"');
		expect(prompt).toContain('"reject"');
		expect(prompt).toContain('"tighten"');
	});

	test("tags each candidate with its C-index", () => {
		expect(prompt).toContain("[C0]");
		expect(prompt).toContain("[C1]");
	});

	test("renders each candidate's own anchors for BOTH kinds", () => {
		expect(prompt).toContain("[w2-w8]"); // retake word range
		expect(prompt).toContain("[L2-L5]"); // structural line range
	});

	test("breaks each candidate's covered content into anchored interior rows", () => {
		// Retake: covered words in small anchored runs (6 per run).
		expect(prompt).toContain('  w2-w7: "so the- so the trick is"');
		expect(prompt).toContain('  w8-w8: "simple"');
		// Structural: one row per covered line, from the catalog.
		expect(prompt).toContain('  L2: "l2"');
		expect(prompt).toContain('  L5: "l5"');
	});

	test("carries the edge-bleed tighten bias (tighten, never keep, on bleeding edges)", () => {
		expect(prompt).toContain("does not belong to the flub or tangent its reason names");
		expect(prompt).toContain("small edge bleed is NEVER a reason to keep");
		expect(prompt).toContain("tighten to the core");
		expect(prompt).toContain("wrong at its CORE"); // reject reserved for core-wrong
	});

	test("echoes each candidate's reason", () => {
		expect(prompt).toContain("abandoned false start before the clean restart");
		expect(prompt).toContain("tangent about lunch that never pays off");
	});

	test("instructs the model NOT to re-litigate recall", () => {
		expect(prompt).toContain("Do NOT re-litigate");
		expect(prompt).toContain("recall was the finder pass's job");
	});

	test("no undefined/NaN leaks, even for empty text/reason", () => {
		expect(prompt).not.toContain("undefined");
		expect(prompt).not.toContain("NaN");
		const bare = buildVerifyPrompt({
			candidates: [{ ...retakeC, coveredText: "", reason: "" }],
			lines: LINES,
		});
		expect(bare).not.toContain("undefined");
		expect(bare).not.toContain("NaN");
		expect(bare).toContain('"-"'); // empty text/reason fall back to "-"
	});

	test("without join fragments, no final-read block and no joinVerdicts hint", () => {
		expect(prompt).not.toContain("ASSEMBLED RESULT");
		expect(prompt).not.toContain("JOIN FRAGMENTS");
		expect(prompt).not.toContain("joinVerdicts");
	});
});

describe("buildVerifyPrompt (final-read block, round 12 U2)", () => {
	const prompt = buildVerifyPrompt({
		candidates: [retakeC],
		lines: LINES,
		assembledTranscript: "we wrapped the demo [CUT] so... [CUT] lets talk deployment",
		joinFragments: [fragA, fragB],
	});

	test("renders the assembled result with its seam-marker explanation", () => {
		expect(prompt).toContain("ASSEMBLED RESULT");
		expect(prompt).toContain('" [CUT] " marks where two cuts meet');
		expect(prompt).toContain(
			"we wrapped the demo [CUT] so... [CUT] lets talk deployment",
		);
	});

	test("renders each fragment as a J-row with id, span, stranded text, and BOTH readings", () => {
		expect(prompt).toContain("[J0 id=join-abc]");
		expect(prompt).toContain("[J1 id=join-def]");
		expect(prompt).toContain('stranded: "so..."');
		expect(prompt).toContain("12.3s-13.1s");
		// Round 13: the alternative is spelled out, not left to be imagined.
		expect(prompt).toContain(
			"keep it   -> ...we wrapped the demo >>so...<< lets talk deployment...",
		);
		expect(prompt).toContain(
			"swallow   -> ...we wrapped the demo [CUT] lets talk deployment...",
		);
	});

	test("frames the swallow/keep judgment as earning screen time, with confidence", () => {
		expect(prompt).toContain('"swallow"');
		// Round 13: swallow is the stated default, the criterion is earned screen
		// time rather than well-formedness, and the confidence field is explicitly
		// calibrated (it is what the swallow gate reads).
		expect(prompt).toContain("EARNS ITS SCREEN TIME");
		expect(prompt).toContain('"swallow" (the DEFAULT)');
		expect(prompt).toContain("CONFIDENCE IS LOAD-BEARING");
		expect(prompt).toContain('"confidence": 0..1');
	});

	test("extends the JSON instruction with a joinVerdicts example", () => {
		expect(prompt).toContain('"joinVerdicts":[{"id":"join-abc","verdict":"swallow","confidence":0.9}');
	});

	test("zero candidates + fragments still renders a coherent prompt (no undefined)", () => {
		const fragOnly = buildVerifyPrompt({
			candidates: [],
			lines: LINES,
			assembledTranscript: "a [CUT] b",
			joinFragments: [fragA],
		});
		expect(fragOnly).toContain("(none this run");
		expect(fragOnly).toContain("[J0 id=join-abc]");
		expect(fragOnly).not.toContain("undefined");
		expect(fragOnly).not.toContain("NaN");
	});
});

describe("sanitizeVerifyPlan (keep / reject map by index)", () => {
	test("keep and reject pass through keyed by index", () => {
		const plan = sanitizeVerifyPlan({
			raw: { verdicts: [
				{ index: 0, verdict: "keep" },
				{ index: 1, verdict: "reject" },
			] },
			candidates: [retakeC, structC],
			lines: LINES,
			words: WORDS,
		});
		expect(plan.verdicts).toEqual([
			{ index: 0, verdict: "keep" },
			{ index: 1, verdict: "reject" },
		]);
	});
});

describe("sanitizeVerifyPlan (tighten resolves to inner seconds)", () => {
	test("a valid inner WORD range on a retake candidate resolves", () => {
		const plan = sanitizeVerifyPlan({
			raw: { verdicts: [{ index: 0, verdict: "tighten", startWord: 3, endWord: 6 }] },
			candidates: [retakeC],
			lines: LINES,
			words: WORDS,
		});
		// word3.start=3 .. word6.end=6.5, strictly inside [2, 8.5].
		expect(plan.verdicts).toEqual([
			{ index: 0, verdict: "tighten", startSec: 3, endSec: 6.5 },
		]);
	});

	test("a valid inner LINE range on a structural candidate resolves", () => {
		const plan = sanitizeVerifyPlan({
			raw: { verdicts: [{ index: 0, verdict: "tighten", startLineId: "L3", endLineId: "L4" }] },
			candidates: [structC],
			lines: LINES,
			words: WORDS,
		});
		// L3.start=6 .. L4.end=9.5, strictly inside [4, 11.5].
		expect(plan.verdicts).toEqual([
			{ index: 0, verdict: "tighten", startSec: 6, endSec: 9.5 },
		]);
	});
});

describe("sanitizeVerifyPlan (tighten degrade-to-keep guards)", () => {
	test("a tighten equal to or wider than the original span degrades to keep", () => {
		const equal = sanitizeVerifyPlan({
			raw: { verdicts: [{ index: 0, verdict: "tighten", startWord: 2, endWord: 8 }] },
			candidates: [retakeC], // span == [w2-w8]
			lines: LINES,
			words: WORDS,
		});
		expect(equal.verdicts).toEqual([{ index: 0, verdict: "keep" }]);

		const wider = sanitizeVerifyPlan({
			raw: { verdicts: [{ index: 0, verdict: "tighten", startWord: 1, endWord: 9 }] },
			candidates: [retakeC],
			lines: LINES,
			words: WORDS,
		});
		expect(wider.verdicts).toEqual([{ index: 0, verdict: "keep" }]);
	});

	test("a tighten with an unknown line id or out-of-range word index degrades to keep", () => {
		const badLine = sanitizeVerifyPlan({
			raw: { verdicts: [{ index: 0, verdict: "tighten", startLineId: "L99", endLineId: "L4" }] },
			candidates: [structC],
			lines: LINES,
			words: WORDS,
		});
		expect(badLine.verdicts).toEqual([{ index: 0, verdict: "keep" }]);

		const badWord = sanitizeVerifyPlan({
			raw: { verdicts: [{ index: 0, verdict: "tighten", startWord: 99, endWord: 100 }] },
			candidates: [retakeC],
			lines: LINES,
			words: WORDS,
		});
		expect(badWord.verdicts).toEqual([{ index: 0, verdict: "keep" }]);
	});
});

describe("sanitizeVerifyPlan (drops bad index / verdict entries)", () => {
	test("unknown, duplicate, and fractional indices are dropped", () => {
		const plan = sanitizeVerifyPlan({
			raw: { verdicts: [
				{ index: 5, verdict: "keep" }, // out of range (2 candidates)
				{ index: 1.5, verdict: "keep" }, // fractional
				{ index: 0, verdict: "keep" }, // valid, first for index 0
				{ index: 0, verdict: "reject" }, // duplicate index -> dropped
			] },
			candidates: [retakeC, structC],
			lines: LINES,
			words: WORDS,
		});
		expect(plan.verdicts).toEqual([{ index: 0, verdict: "keep" }]);
	});

	test("an unknown verdict string is dropped; its candidate passes through unverified", () => {
		const plan = sanitizeVerifyPlan({
			raw: { verdicts: [
				{ index: 0, verdict: "maybe" }, // unknown verdict -> dropped
				{ index: 1, verdict: "keep" },
			] },
			candidates: [retakeC, structC],
			lines: LINES,
			words: WORDS,
		});
		expect(plan.verdicts).toEqual([{ index: 1, verdict: "keep" }]);
	});
});

describe("sanitizeVerifyPlan (individual resolution: overlapping tightens)", () => {
	test("two tightens whose narrowed ranges overlap each other BOTH resolve", () => {
		// A single batched resolver call sorts by start and drops the overlapping
		// second op; per-candidate resolution keeps both intact.
		const c0: VerifyCandidate = {
			category: "retake",
			startSec: 0,
			endSec: 6.5,
			reason: "a",
			confidence: 0.6,
			coveredText: "x",
			startWord: 0,
			endWord: 6,
		};
		const c1: VerifyCandidate = {
			category: "retake",
			startSec: 3,
			endSec: 9.5,
			reason: "b",
			confidence: 0.6,
			coveredText: "y",
			startWord: 3,
			endWord: 9,
		};
		const plan = sanitizeVerifyPlan({
			raw: { verdicts: [
				{ index: 0, verdict: "tighten", startWord: 2, endWord: 5 }, // -> [2, 5.5]
				{ index: 1, verdict: "tighten", startWord: 4, endWord: 7 }, // -> [4, 7.5] (overlaps)
			] },
			candidates: [c0, c1],
			lines: LINES,
			words: WORDS,
		});
		expect(plan.verdicts).toEqual([
			{ index: 0, verdict: "tighten", startSec: 2, endSec: 5.5 },
			{ index: 1, verdict: "tighten", startSec: 4, endSec: 7.5 },
		]);
	});
});

describe("sanitizeVerifyPlan (malformed responses never throw)", () => {
	test("non-JSON, empty object, and null all yield zero verdicts", () => {
		const args = { candidates: [retakeC], lines: LINES, words: WORDS };
		expect(sanitizeVerifyPlan({ raw: "not json{", ...args }).verdicts).toEqual([]);
		expect(sanitizeVerifyPlan({ raw: {}, ...args }).verdicts).toEqual([]);
		expect(sanitizeVerifyPlan({ raw: null, ...args }).verdicts).toEqual([]);
	});
});

describe("sanitizeVerifyPlan (join verdicts, round 12 U2)", () => {
	const args = {
		candidates: [retakeC],
		lines: LINES,
		words: WORDS,
		joinFragments: [fragA, fragB],
	};

	test("well-formed swallow/keep verdicts pass through with clamped confidence", () => {
		const plan = sanitizeVerifyPlan({
			raw: {
				verdicts: [],
				joinVerdicts: [
					{ id: "join-abc", verdict: "swallow", confidence: 0.9 },
					{ id: "join-def", verdict: "keep", confidence: 1.7 }, // clamps to 1
				],
			},
			...args,
		});
		expect(plan.joinVerdicts).toEqual([
			{ id: "join-abc", verdict: "swallow", confidence: 0.9 },
			{ id: "join-def", verdict: "keep", confidence: 1 },
		]);
	});

	test("unknown id, unknown verdict, bad confidence, and duplicates are dropped", () => {
		const plan = sanitizeVerifyPlan({
			raw: {
				verdicts: [],
				joinVerdicts: [
					{ id: "join-zzz", verdict: "swallow", confidence: 0.9 }, // not a sent fragment
					{ id: "join-abc", verdict: "maybe", confidence: 0.9 }, // unknown verdict
					{ id: "join-abc", verdict: "swallow", confidence: "high" }, // non-number confidence
					{ id: "join-abc", verdict: "swallow", confidence: Number.NaN }, // non-finite
					{ id: "join-def", verdict: "keep", confidence: 0.6 }, // valid, first for its id
					{ id: "join-def", verdict: "swallow", confidence: 0.9 }, // duplicate id
					{ id: 7, verdict: "swallow", confidence: 0.9 }, // non-string id
					"not an object",
				],
			},
			...args,
		});
		expect(plan.joinVerdicts).toEqual([
			{ id: "join-def", verdict: "keep", confidence: 0.6 },
		]);
	});

	test("a malformed or absent joinVerdicts array yields zero join verdicts", () => {
		expect(
			sanitizeVerifyPlan({ raw: { verdicts: [] }, ...args }).joinVerdicts,
		).toEqual([]);
		expect(
			sanitizeVerifyPlan({
				raw: { verdicts: [], joinVerdicts: "nope" },
				...args,
			}).joinVerdicts,
		).toEqual([]);
		// A malformed verdicts array must not take the join verdicts down with it.
		expect(
			sanitizeVerifyPlan({
				raw: {
					verdicts: "nope",
					joinVerdicts: [{ id: "join-abc", verdict: "swallow", confidence: 0.8 }],
				},
				...args,
			}),
		).toEqual({
			verdicts: [],
			joinVerdicts: [{ id: "join-abc", verdict: "swallow", confidence: 0.8 }],
		});
	});

	test("join verdicts for fragments that were never sent yield nothing (no fragments)", () => {
		const plan = sanitizeVerifyPlan({
			raw: {
				verdicts: [],
				joinVerdicts: [{ id: "join-abc", verdict: "swallow", confidence: 0.9 }],
			},
			candidates: [retakeC],
			lines: LINES,
			words: WORDS,
		});
		expect(plan.joinVerdicts).toEqual([]);
	});
});

describe("planVerify fail-open (R4)", () => {
	// A custom endpoint that would REJECT fast if dispatched - proves the empty-
	// candidates guard returns BEFORE any LLM call (a live call would fetch this host).
	const NO_CALL_AUTH: ClaudeAuth = {
		mode: "custom",
		baseUrl: "http://127.0.0.1:9/v1",
		model: "unused",
	};

	test("empty candidates AND empty fragments -> empty verdicts WITHOUT invoking the LLM", async () => {
		await expect(
			planVerify({ candidates: [], lines: LINES, words: WORDS, auth: NO_CALL_AUTH }),
		).resolves.toEqual({ plan: { verdicts: [], joinVerdicts: [] }, usage: null });
		await expect(
			planVerify({
				candidates: [],
				lines: LINES,
				words: WORDS,
				joinFragments: [],
				auth: NO_CALL_AUTH,
			}),
		).resolves.toEqual({ plan: { verdicts: [], joinVerdicts: [] }, usage: null });
	});

	test("join fragments ALONE fire the pass (round 12 U2: the call is attempted)", async () => {
		// The unreachable endpoint proves the inverse of the guard test above: with
		// zero candidates but one fragment, planVerify must DISPATCH (and here fail).
		await expect(
			planVerify({
				candidates: [],
				lines: LINES,
				words: WORDS,
				assembledTranscript: "a [CUT] b",
				joinFragments: [fragA],
				auth: NO_CALL_AUTH,
			}),
		).rejects.toThrow();
	});
});
