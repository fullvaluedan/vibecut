import { describe, expect, test } from "bun:test";
import {
	applyJoinVerdicts,
	applyVerifyVerdicts,
	collectVerifyCandidates,
	JOIN_SWALLOW_MIN_CONFIDENCE,
} from "../verify-apply";
import type {
	DirectorOp,
	RedundancyLine,
	RetakeWord,
	VerifyJoinVerdict,
	VerifyVerdict,
} from "@framecut/hf-bridge";

/**
 * Pure-mapping tests for the verify wiring (U2). collectVerifyCandidates filters the
 * recall rows in op order and attaches the covered text + tighten anchors; applyVerify-
 * Verdicts maps the index-keyed verdicts back onto the SAME op list (reject removes,
 * tighten overwrites only seconds, keep/no-verdict/non-candidate untouched).
 */

const WORDS: RetakeWord[] = [
	{ text: "so", startSec: 0.0, endSec: 0.4 },
	{ text: "hello", startSec: 0.5, endSec: 0.9 },
	{ text: "world", startSec: 1.0, endSec: 1.4 },
	{ text: "this", startSec: 1.5, endSec: 1.9 },
	{ text: "is", startSec: 2.0, endSec: 2.4 },
	{ text: "test", startSec: 2.5, endSec: 2.9 },
];

const LINES: RedundancyLine[] = [
	{ lineId: "L0", startSec: 0.0, endSec: 1.4, text: "so hello world" },
	{ lineId: "L1", startSec: 1.5, endSec: 2.9, text: "this is test" },
];

const op = (o: Partial<DirectorOp> & { id: string }): DirectorOp => ({
	op: "cut",
	startSec: 0,
	endSec: 1,
	reason: "r",
	confidence: 0.7,
	...o,
});

const retakeOp = op({
	id: "r1",
	startSec: 1.0,
	endSec: 1.9,
	reason: "flub",
	confidence: 0.7,
	category: "retake",
	defaultAccept: false,
});
const structuralOp = op({
	id: "s1",
	startSec: 0.5,
	endSec: 2.4,
	reason: "tangent",
	confidence: 0.8,
	category: "structural",
	defaultAccept: false,
});
const fillerOp = op({
	id: "f1",
	startSec: 0.0,
	endSec: 0.4,
	reason: "um",
	confidence: 0.9,
	category: "filler",
});

describe("collectVerifyCandidates", () => {
	test("filters recall rows IN OP ORDER, skipping non-candidates, with correct anchors for both kinds", () => {
		// A non-candidate (filler) sits between the two recall rows: it must be skipped
		// WITHOUT disturbing the order or index of the candidates around it.
		const cands = collectVerifyCandidates({
			ops: [retakeOp, fillerOp, structuralOp],
			words: WORDS,
			lines: LINES,
		});
		expect(cands).toHaveLength(2);

		// [C0] = the retake row: word-index anchors from the words overlapping [1.0,1.9]
		// (w2 "world", w3 "this"), covered text joined in order.
		expect(cands[0].category).toBe("retake");
		expect(cands[0].startSec).toBe(1.0);
		expect(cands[0].endSec).toBe(1.9);
		expect(cands[0].reason).toBe("flub");
		expect(cands[0].confidence).toBe(0.7);
		expect(cands[0].coveredText).toBe("world this");
		expect(cands[0].startWord).toBe(2);
		expect(cands[0].endWord).toBe(3);
		// A retake row carries WORD anchors, never line anchors.
		expect(cands[0].startLineId).toBeUndefined();
		expect(cands[0].endLineId).toBeUndefined();

		// [C1] = the structural row: line-id anchors from the lines overlapping [0.5,2.4]
		// (L0 and L1), covered text from the words overlapping the same span.
		expect(cands[1].category).toBe("structural");
		expect(cands[1].startLineId).toBe("L0");
		expect(cands[1].endLineId).toBe("L1");
		expect(cands[1].coveredText).toBe("hello world this is");
		// A structural row carries LINE anchors, never word anchors.
		expect(cands[1].startWord).toBeUndefined();
		expect(cands[1].endWord).toBeUndefined();
	});

	test("empty ops → no candidates", () => {
		expect(
			collectVerifyCandidates({ ops: [], words: WORDS, lines: LINES }),
		).toEqual([]);
	});

	test("a recall row with no overlapping words/lines omits its anchors", () => {
		// A retake span entirely in a wordless gap: no covered text, no word anchors.
		const gapRetake = op({
			id: "r-gap",
			startSec: 10,
			endSec: 11,
			category: "retake",
			defaultAccept: false,
		});
		const [c] = collectVerifyCandidates({
			ops: [gapRetake],
			words: WORDS,
			lines: LINES,
		});
		expect(c.coveredText).toBe("");
		expect(c.startWord).toBeUndefined();
		expect(c.endWord).toBeUndefined();
	});
});

describe("applyVerifyVerdicts", () => {
	// The op list the pipeline hands in: two recall rows (candidate 0 = retake, candidate
	// 1 = structural) with a non-candidate filler between them.
	const OPS = [retakeOp, fillerOp, structuralOp];
	const CANDS = collectVerifyCandidates({ ops: OPS, words: WORDS, lines: LINES });

	test("reject removes EXACTLY the indexed candidate's op, nothing else", () => {
		// Reject candidate 1 (the structural row) → structuralOp gone, the other two stay.
		const out = applyVerifyVerdicts({
			ops: OPS,
			candidates: CANDS,
			verdicts: [{ index: 1, verdict: "reject" }],
		});
		expect(out.map((o) => o.id)).toEqual(["r1", "f1"]);

		// Reject candidate 0 (the retake row) → retakeOp gone, filler + structural stay.
		const out0 = applyVerifyVerdicts({
			ops: OPS,
			candidates: CANDS,
			verdicts: [{ index: 0, verdict: "reject" }],
		});
		expect(out0.map((o) => o.id)).toEqual(["f1", "s1"]);
	});

	test("tighten overwrites ONLY startSec/endSec; every other field survives", () => {
		const out = applyVerifyVerdicts({
			ops: OPS,
			candidates: CANDS,
			verdicts: [{ index: 0, verdict: "tighten", startSec: 1.2, endSec: 1.7 }],
		});
		const tightened = out.find((o) => o.id === "r1")!;
		expect(tightened.startSec).toBe(1.2);
		expect(tightened.endSec).toBe(1.7);
		// Preserved: category, defaultAccept (false), reason, id, confidence, op kind.
		expect(tightened.category).toBe("retake");
		expect(tightened.defaultAccept).toBe(false);
		expect(tightened.reason).toBe("flub");
		expect(tightened.confidence).toBe(0.7);
		expect(tightened.op).toBe("cut");
		// The other rows are untouched.
		expect(out.map((o) => o.id)).toEqual(["r1", "f1", "s1"]);
	});

	test("a verdict for a non-candidate (out-of-range) index is ignored; nothing changes", () => {
		const out = applyVerifyVerdicts({
			ops: OPS,
			candidates: CANDS,
			// Index 5 has no candidate (only 0 and 1 exist); a negative index never matches.
			verdicts: [
				{ index: 5, verdict: "reject" },
				{ index: -1, verdict: "reject" },
			],
		});
		expect(out).toEqual(OPS);
	});

	test("keep and no-verdict pass through unchanged; non-candidate ops are never touched", () => {
		const out = applyVerifyVerdicts({
			ops: OPS,
			candidates: CANDS,
			// Candidate 0 keeps explicitly; candidate 1 has no verdict at all.
			verdicts: [{ index: 0, verdict: "keep" }],
		});
		expect(out).toEqual(OPS);
	});

	test("empty ops and empty candidates are safe", () => {
		expect(
			applyVerifyVerdicts({ ops: [], candidates: [], verdicts: [] }),
		).toEqual([]);
		// Verdicts with no candidates to pair against are inert; ops flow through.
		const verdicts: VerifyVerdict[] = [{ index: 0, verdict: "reject" }];
		expect(
			applyVerifyVerdicts({ ops: [fillerOp], candidates: [], verdicts }),
		).toEqual([fillerOp]);
	});
});

/**
 * Final-read join promotion (round 12 U2/R3): a confident "swallow" flips an
 * OFFERED join row to checked; everything else - "keep", low confidence, an
 * unknown id, a malformed entry - leaves every row exactly as detected, and a
 * non-join op is never touched (fail toward OFFERED, never toward removal).
 */
describe("applyJoinVerdicts", () => {
	// A word-bearing OFFERED fragment row and an AUTO (accepted) sliver row, as
	// the join-texture layer mints them, plus a non-join bystander.
	const fragmentJoin = op({
		id: "j-frag",
		startSec: 5.0,
		endSec: 5.5,
		reason: 'Stranded between two cuts: "so..." - swallow it?',
		confidence: 0.6,
		category: "join",
		defaultAccept: false,
	});
	const sliverJoin = op({
		id: "j-sliver",
		startSec: 6.0,
		endSec: 6.05,
		reason: "Silent sliver (0.05s) between two cuts - swallowed for a clean join",
		confidence: 0.6,
		category: "join",
	});
	const OPS = [fillerOp, fragmentJoin, sliverJoin];

	test("a swallow at EXACTLY the threshold promotes; every other field survives", () => {
		const out = applyJoinVerdicts({
			ops: OPS,
			verdicts: [
				{ id: "j-frag", verdict: "swallow", confidence: JOIN_SWALLOW_MIN_CONFIDENCE },
			],
		});
		const promoted = out.find((o) => o.id === "j-frag")!;
		expect(promoted.defaultAccept).toBe(true);
		expect(promoted.category).toBe("join");
		expect(promoted.reason).toBe(fragmentJoin.reason);
		expect(promoted.startSec).toBe(5.0);
		expect(promoted.endSec).toBe(5.5);
		// The bystanders are untouched (the filler and the AUTO sliver).
		expect(out.find((o) => o.id === "f1")).toBe(fillerOp);
		expect(out.find((o) => o.id === "j-sliver")).toBe(sliverJoin);
	});

	test("a swallow BELOW the threshold leaves the row OFFERED", () => {
		const out = applyJoinVerdicts({
			ops: OPS,
			verdicts: [{ id: "j-frag", verdict: "swallow", confidence: 0.69 }],
		});
		expect(out.find((o) => o.id === "j-frag")!.defaultAccept).toBe(false);
	});

	test("a keep verdict leaves the row OFFERED even at full confidence", () => {
		const out = applyJoinVerdicts({
			ops: OPS,
			verdicts: [{ id: "j-frag", verdict: "keep", confidence: 1 }],
		});
		expect(out.find((o) => o.id === "j-frag")!.defaultAccept).toBe(false);
	});

	test("an id matching no join op is ignored; a non-join op with the id is never touched", () => {
		// "f1" IS an op id in the list, but not a join op: it must pass through
		// untouched even with a confident swallow naming it.
		const out = applyJoinVerdicts({
			ops: OPS,
			verdicts: [
				{ id: "j-unknown", verdict: "swallow", confidence: 0.95 },
				{ id: "f1", verdict: "swallow", confidence: 0.95 },
			],
		});
		expect(out).toEqual(OPS);
	});

	test("an already-accepted join (AUTO sliver) is never re-flagged by a verdict", () => {
		const out = applyJoinVerdicts({
			ops: OPS,
			verdicts: [{ id: "j-sliver", verdict: "swallow", confidence: 0.95 }],
		});
		// defaultAccept stays ABSENT (accepted), not overwritten to explicit true.
		expect(out.find((o) => o.id === "j-sliver")).toBe(sliverJoin);
	});

	test("malformed verdict entries promote nothing (belt on top of the sanitizer)", () => {
		const malformed = [
			null,
			{ id: "j-frag", verdict: "swallow" }, // missing confidence
			{ id: "j-frag", verdict: "swallow", confidence: "high" }, // non-number
			{ id: "j-frag", verdict: "swallow", confidence: Number.NaN }, // non-finite
			{ verdict: "swallow", confidence: 0.9 }, // missing id
		] as unknown as VerifyJoinVerdict[];
		expect(applyJoinVerdicts({ ops: OPS, verdicts: malformed })).toEqual(OPS);
	});

	test("empty verdicts pass every op through unchanged", () => {
		expect(applyJoinVerdicts({ ops: OPS, verdicts: [] })).toEqual(OPS);
	});
});
