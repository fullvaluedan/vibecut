import { describe, expect, test } from "bun:test";
import {
	clampCutExtent,
	MIN_EVIDENCE_COVERAGE,
	OVERSIZED_SPAN_SEC,
	type EvidenceSpan,
} from "../clamp-cut-extent";
import { snapRemovalOps } from "../snap-cut";
import { refineCutWordBounds } from "../refine-cut-words";
import { resolveTrimVsCut } from "../resolve-trim-vs-cut";
import { justifyCuts } from "../justify-cuts";
import type { WordTiming } from "../cut-utils";
import type { DirectorOp } from "@framecut/hf-bridge";

const op = ({
	startSec,
	endSec,
	op = "cut",
	id = `t-${startSec}-${endSec}`,
	category,
	confidence = 0.5,
	reason = "test",
	targetStartSec,
	defaultAccept,
}: {
	startSec: number;
	endSec: number;
	op?: DirectorOp["op"];
	id?: string;
	category?: DirectorOp["category"];
	confidence?: number;
	reason?: string;
	targetStartSec?: number;
	defaultAccept?: boolean;
}): DirectorOp => ({
	id,
	op,
	startSec,
	endSec,
	reason,
	confidence,
	...(category !== undefined ? { category } : {}),
	...(targetStartSec !== undefined ? { targetStartSec } : {}),
	...(defaultAccept !== undefined ? { defaultAccept } : {}),
});

const word = (text: string, start: number, end: number): WordTiming => ({
	text,
	start,
	end,
});

/** One non-empty word so the fail-open guard passes; the shrink math is span-only. */
const HAVE_WORDS: WordTiming[] = [word("x", 0, 0.4)];

/** Generate `n` words on a 0.5s grid, each 0.4s long: word i = [0.5i, 0.5i+0.4]. */
function mkWords(n: number): WordTiming[] {
	return Array.from({ length: n }, (_, i) => word(`w${i}`, i * 0.5, i * 0.5 + 0.4));
}

describe("clampCutExtent", () => {
	test("long span with a short evidenced retake shrinks to the retake words", () => {
		// 39s LLM span (0-39) containing a 3s deterministically-evidenced retake at 18-21.
		// With the shrink floor lowered, the span shrinks to exactly the retake evidence;
		// the ~36s of kept dialog around it survives.
		const [shrunk, ...rest] = clampCutExtent({
			ops: [op({ startSec: 0, endSec: 39, category: "vision", confidence: 0.8 })],
			words: HAVE_WORDS,
			evidence: [{ startSec: 18, endSec: 21 }],
			oversizedSpanSec: 8,
			minEvidenceCoverage: 0.05,
		});
		expect(rest).toHaveLength(0);
		expect(shrunk.startSec).toBe(18);
		expect(shrunk.endSec).toBe(21);
		expect(shrunk.op).toBe("cut");
		// Fields preserved, span never grown, id regenerated off the parent's.
		expect(shrunk.category).toBe("vision");
		expect(shrunk.confidence).toBe(0.8);
		expect(shrunk.reason).toBe("test");
		expect(shrunk.id).not.toBe("t-0-39");
		expect(shrunk.defaultAccept).toBeUndefined(); // shrink stays accepted
	});

	test("span with two disjoint evidence runs splits into two ops", () => {
		const out = clampCutExtent({
			ops: [op({ startSec: 0, endSec: 39, reason: "big cut" })],
			words: HAVE_WORDS,
			evidence: [
				{ startSec: 10, endSec: 13 },
				{ startSec: 20, endSec: 23 },
			],
			oversizedSpanSec: 8,
			minEvidenceCoverage: 0.05,
		});
		expect(out).toHaveLength(2);
		expect(out.map((o) => [o.startSec, o.endSec])).toEqual([
			[10, 13],
			[20, 23],
		]);
		// Both carry the parent's reason but distinct freshly-generated ids.
		expect(out[0].reason).toBe("big cut");
		expect(out[1].reason).toBe("big cut");
		expect(out[0].id).not.toBe(out[1].id);
		expect(out[0].id).not.toBe("t-0-39");
	});

	test("adjacent/overlapping evidence runs merge into one shrunk op", () => {
		const out = clampCutExtent({
			ops: [op({ startSec: 0, endSec: 39 })],
			words: HAVE_WORDS,
			evidence: [
				{ startSec: 10, endSec: 15 },
				{ startSec: 14, endSec: 20 }, // overlaps the previous run
			],
			oversizedSpanSec: 8,
			minEvidenceCoverage: 0.05,
		});
		expect(out).toHaveLength(1);
		expect([out[0].startSec, out[0].endSec]).toEqual([10, 20]);
	});

	test("R6-U6 dead-outro shape: silence evidence covering 95pct shrinks, keeps AUTO", () => {
		// The live-test inversion: a 24s LLM plan cut over a dead-air tail was
		// demoted for lack of word-detector evidence. With envelope dead-air +
		// hallucinated spans in the evidence set, it shrinks to the union and
		// ships default-accepted.
		const words = mkWords(120); // words end at 60.0; the cut targets 60-84
		const ops = clampCutExtent({
			ops: [op({ startSec: 60, endSec: 84 })],
			words,
			evidence: [
				{ startSec: 60.2, endSec: 81.9 }, // envelope dead-air run
				{ startSec: 81.9, endSec: 83.5 }, // hallucinated span
			],
		});
		expect(ops).toHaveLength(1);
		expect(ops[0].defaultAccept).not.toBe(false);
		expect(ops[0].startSec).toBeCloseTo(60.2, 3);
		expect(ops[0].endSec).toBeCloseTo(83.5, 3);
	});

	test("oversized span with no evidence is demoted to OFFERED, span untouched", () => {
		const [demoted, ...rest] = clampCutExtent({
			ops: [op({ startSec: 0, endSec: 39, id: "keepme" })],
			words: HAVE_WORDS,
			evidence: [{ startSec: 100, endSec: 110 }], // nowhere near the span
			oversizedSpanSec: 8,
		});
		expect(rest).toHaveLength(0);
		expect(demoted.defaultAccept).toBe(false);
		expect(demoted.startSec).toBe(0); // span never grown or shrunk
		expect(demoted.endSec).toBe(39);
		expect(demoted.id).toBe("keepme"); // span unchanged → id unchanged
	});

	test("evidence below the coverage floor demotes instead of shrinking to a sliver", () => {
		// 0.5s of evidence in a 39s span = ~1.3% coverage, under the default 0.5 floor.
		const [demoted] = clampCutExtent({
			ops: [op({ startSec: 0, endSec: 39 })],
			words: HAVE_WORDS,
			evidence: [{ startSec: 18, endSec: 18.5 }],
			oversizedSpanSec: 8,
		});
		expect(demoted.defaultAccept).toBe(false);
		expect([demoted.startSec, demoted.endSec]).toEqual([0, 39]);
	});

	test("a vision-tagged plan op is disciplined the same as an untagged one", () => {
		const evidence: EvidenceSpan[] = []; // no evidence → both demote
		const [vision] = clampCutExtent({
			ops: [op({ startSec: 0, endSec: 39, category: "vision" })],
			words: HAVE_WORDS,
			evidence,
			oversizedSpanSec: 8,
		});
		const [plain] = clampCutExtent({
			ops: [op({ startSec: 0, endSec: 39 })],
			words: HAVE_WORDS,
			evidence,
			oversizedSpanSec: 8,
		});
		expect(vision.defaultAccept).toBe(false);
		expect(plain.defaultAccept).toBe(false);
		expect(vision.category).toBe("vision"); // tag preserved through discipline
		expect([vision.startSec, vision.endSec]).toEqual([plain.startSec, plain.endSec]);
	});

	test("small span below threshold passes through byte-identical (same reference)", () => {
		const small = op({ startSec: 10, endSec: 15 }); // 5s < default 20s trigger
		const [out] = clampCutExtent({
			ops: [small],
			words: HAVE_WORDS,
			evidence: [{ startSec: 11, endSec: 12 }],
		});
		expect(out).toBe(small); // untouched reference
	});

	test("does not filter by category: a detector-categorized op is still disciplined", () => {
		// The function keys off ARRAY MEMBERSHIP, never category. An oversized op carrying
		// a detector-style category is disciplined exactly like a bare LLM op would be.
		const [out] = clampCutExtent({
			ops: [op({ startSec: 0, endSec: 39, category: "repeat" })],
			words: HAVE_WORDS,
			evidence: [],
			oversizedSpanSec: 8,
		});
		expect(out.defaultAccept).toBe(false); // demoted, not skipped
		expect(out.category).toBe("repeat");
	});

	test("keep and reorder ops pass through untouched even when oversized", () => {
		const keep = op({ startSec: 0, endSec: 39, op: "keep" });
		const reorder = op({ startSec: 0, endSec: 39, op: "reorder", targetStartSec: 5 });
		const out = clampCutExtent({
			ops: [keep, reorder],
			words: HAVE_WORDS,
			evidence: [],
			oversizedSpanSec: 8,
		});
		expect(out[0]).toBe(keep);
		expect(out[1]).toBe(reorder);
	});

	test("take_select removals are disciplined like cuts", () => {
		const [out] = clampCutExtent({
			ops: [op({ startSec: 0, endSec: 39, op: "take_select" })],
			words: HAVE_WORDS,
			evidence: [{ startSec: 18, endSec: 21 }],
			oversizedSpanSec: 8,
			minEvidenceCoverage: 0.05,
		});
		expect(out.op).toBe("take_select");
		expect([out.startSec, out.endSec]).toEqual([18, 21]);
	});

	test("empty / absent words returns ops unchanged (fail-open)", () => {
		const ops = [op({ startSec: 0, endSec: 39 })];
		expect(clampCutExtent({ ops, words: [], evidence: [], oversizedSpanSec: 8 })).toEqual(ops);
		expect(
			clampCutExtent({ ops, words: undefined, evidence: [], oversizedSpanSec: 8 }),
		).toEqual(ops);
	});

	test("shrink collapsing to zero span drops the op", () => {
		// Zero-width evidence inside the span "overlaps" it but clips to nothing, so the
		// shrink yields no positive run → the op is dropped rather than emitted zero-width.
		const out = clampCutExtent({
			ops: [op({ startSec: 0, endSec: 39 })],
			words: HAVE_WORDS,
			evidence: [{ startSec: 20, endSec: 20 }],
			oversizedSpanSec: 8,
			minEvidenceCoverage: 0.05,
		});
		expect(out).toHaveLength(0);
	});

	test("never grows a span: shrunk runs are clipped to the op bounds", () => {
		const [out] = clampCutExtent({
			ops: [op({ startSec: 10, endSec: 40 })],
			words: HAVE_WORDS,
			// Evidence spills past both edges of the op; the shrink is clipped to [10, 40].
			evidence: [{ startSec: 5, endSec: 45 }],
			oversizedSpanSec: 8,
			minEvidenceCoverage: 0.05,
		});
		expect(out.startSec).toBe(10);
		expect(out.endSec).toBe(40);
	});

	test("default constants: oversized-without-evidence demotes, sub-threshold passes", () => {
		// Pins the shipped tuning: 25s > OVERSIZED_SPAN_SEC(20) is disciplined; 10s isn't.
		expect(OVERSIZED_SPAN_SEC).toBe(20);
		expect(MIN_EVIDENCE_COVERAGE).toBe(0.5);
		const big = op({ startSec: 0, endSec: 25 });
		const small = op({ startSec: 0, endSec: 10 });
		const out = clampCutExtent({ ops: [big, small], words: HAVE_WORDS, evidence: [] });
		expect(out[0].defaultAccept).toBe(false); // 25s demoted under defaults
		expect(out[1]).toBe(small); // 10s untouched under defaults
	});

	test("integration: a shrunk op flows through snap → refine → trim → justify word-safe", () => {
		// A 30s LLM cut engulfing a word grid, with evidence covering a mid-run whose edges
		// land INSIDE words (5.3 in w10 [5.0,5.4], 8.7 in w17 [8.5,8.9]). Clamp shrinks to
		// that evidence; the downstream chain must then land the edges on word gaps.
		const words = mkWords(60); // 0..30s
		const clamped = clampCutExtent({
			ops: [op({ startSec: 1.0, endSec: 25.0, id: "seg" })],
			words,
			evidence: [{ startSec: 5.3, endSec: 8.7 }],
			oversizedSpanSec: 8,
			minEvidenceCoverage: 0.05,
		});
		expect(clamped).toHaveLength(1);
		expect([clamped[0].startSec, clamped[0].endSec]).toEqual([5.3, 8.7]);

		const snapped = snapRemovalOps({ ops: clamped, envelope: [] }); // empty → pass-through
		const refined = refineCutWordBounds({ ops: snapped, words });
		const trimmed = resolveTrimVsCut({
			ops: refined,
			clipStartsSec: [],
			clipEndsSec: [],
			toleranceSec: 0.5,
		});
		const final = justifyCuts({ ops: trimmed, words, floorSec: 0.5 });
		expect(final.length).toBeGreaterThan(0);
		for (const f of final) {
			for (const w of words) {
				// No final cut edge lands strictly inside a word.
				expect(f.startSec <= w.start || f.startSec >= w.end).toBe(true);
				expect(f.endSec <= w.start || f.endSec >= w.end).toBe(true);
			}
		}
	});

	test("integration: a demoted op survives the chain as an unchecked review row", () => {
		const words = mkWords(60);
		const clamped = clampCutExtent({
			ops: [op({ startSec: 1.0, endSec: 25.0 })],
			words,
			evidence: [], // no evidence → demote
			oversizedSpanSec: 8,
		});
		const snapped = snapRemovalOps({ ops: clamped, envelope: [] });
		const refined = refineCutWordBounds({ ops: snapped, words });
		const trimmed = resolveTrimVsCut({
			ops: refined,
			clipStartsSec: [],
			clipEndsSec: [],
			toleranceSec: 0.5,
		});
		const final = justifyCuts({ ops: trimmed, words, floorSec: 0.5 });
		expect(final).toHaveLength(1);
		expect(final[0].defaultAccept).toBe(false); // still an opt-in row downstream
	});
});
