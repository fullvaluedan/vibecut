import { describe, expect, test } from "bun:test";
import {
	formatScorecard,
	proposalsBySource,
	scoreCutProposals,
	scoreDual,
	toProposedCutSpans,
} from "../score";
import { buildDirectorProposals } from "../../build-director-proposals";
import type { TruthCutSpan } from "../align";
import type { DirectorOp } from "@framecut/hf-bridge";
import type { TranscriptionWord } from "@/transcription/types";

function words(text: string, startAt = 0): TranscriptionWord[] {
	return text
		.split(/\s+/)
		.filter(Boolean)
		.map((w, i) => ({
			text: w,
			start: startAt + i * 0.3,
			end: startAt + i * 0.3 + 0.28,
		}));
}

function truthSpan(
	rawWords: TranscriptionWord[],
	startIndex: number,
	endIndex: number,
): TruthCutSpan {
	return {
		startIndex,
		endIndex,
		startSec: rawWords[startIndex].start,
		endSec: rawWords[endIndex].end,
		text: rawWords
			.slice(startIndex, endIndex + 1)
			.map((w) => w.text)
			.join(" "),
	};
}

describe("scoreCutProposals", () => {
	// 10 words; Dan cut words 3..5 ("um wait no").
	const raw = words("intro line here um wait no the real content follows");
	const truth = [truthSpan(raw, 3, 5)];

	test("perfect proposal: recall 1, precision 1, nothing lost", () => {
		const sc = scoreCutProposals({
			rawWords: raw,
			truthCutSpans: truth,
			proposedSpans: [{ startSec: raw[3].start, endSec: raw[5].end }],
		});
		expect(sc.cutRecall).toBe(1);
		expect(sc.cutPrecision).toBe(1);
		expect(sc.essentialWordsLost).toBe(0);
		expect(sc.missedSpans).toEqual([]);
		expect(sc.falseCutSpans).toEqual([]);
		expect(sc.meanBoundaryErrorSec).toBeCloseTo(0, 5);
	});

	test("missed cut shows up as recall < 1 with the surviving text", () => {
		const sc = scoreCutProposals({
			rawWords: raw,
			truthCutSpans: truth,
			proposedSpans: [],
		});
		expect(sc.cutRecall).toBe(0);
		expect(sc.missedCutWords).toBe(3);
		expect(sc.missedSpans).toHaveLength(1);
		expect(sc.missedSpans[0].text).toBe("um wait no");
	});

	test("overreaching cut destroys kept dialog and is named", () => {
		// Proposal eats the truth span PLUS the three following kept words —
		// the exact 'essential dialog cut off' failure.
		const sc = scoreCutProposals({
			rawWords: raw,
			truthCutSpans: truth,
			proposedSpans: [{ startSec: raw[3].start, endSec: raw[8].end }],
		});
		expect(sc.cutRecall).toBe(1);
		expect(sc.essentialWordsLost).toBe(3);
		expect(sc.falseCutSpans[0].text).toBe("the real content");
		expect(sc.cutPrecision).toBeCloseTo(3 / 6, 5);
	});

	test("boundary grazing counts as boundary error, not a destroyed word", () => {
		// Proposal overshoots the span end by 100ms into the next word's head
		// but not past its midpoint: no word lost, boundary error > 0.
		const sc = scoreCutProposals({
			rawWords: raw,
			truthCutSpans: truth,
			proposedSpans: [
				{ startSec: raw[3].start, endSec: raw[5].end + 0.1 },
			],
		});
		expect(sc.essentialWordsLost).toBe(0);
		expect(sc.meanBoundaryErrorSec).toBeGreaterThan(0.04);
	});

	test("duplicate-word attribution swap is not penalized twice", () => {
		// "the the": truth labeled the FIRST copy cut, the detector cut the
		// SECOND — identical words, equivalent edit. Must score as a hit, not
		// as one false cut plus one miss.
		const dupRaw = words("verify the the logs");
		const sc = scoreCutProposals({
			rawWords: dupRaw,
			truthCutSpans: [truthSpan(dupRaw, 1, 1)],
			proposedSpans: [{ startSec: dupRaw[2].start, endSec: dupRaw[2].end }],
		});
		expect(sc.cutRecall).toBe(1);
		expect(sc.essentialWordsLost).toBe(0);
		expect(sc.missedCutWords).toBe(0);
	});

	test("attribution swap requires identical text — different words stay wrong", () => {
		const otherRaw = words("verify some the logs");
		const sc = scoreCutProposals({
			rawWords: otherRaw,
			truthCutSpans: [truthSpan(otherRaw, 1, 1)], // Dan cut "some"
			proposedSpans: [
				{ startSec: otherRaw[2].start, endSec: otherRaw[2].end }, // we cut "the"
			],
		});
		expect(sc.essentialWordsLost).toBe(1);
		expect(sc.missedCutWords).toBe(1);
	});

	test("no truth cuts + no proposals = clean sheet, not NaN", () => {
		const sc = scoreCutProposals({
			rawWords: raw,
			truthCutSpans: [],
			proposedSpans: [],
		});
		expect(sc.cutRecall).toBe(1);
		expect(sc.cutPrecision).toBe(1);
		expect(sc.meanBoundaryErrorSec).toBeNull();
	});

	test("formatScorecard names the failures", () => {
		const sc = scoreCutProposals({
			rawWords: raw,
			truthCutSpans: truth,
			proposedSpans: [{ startSec: raw[3].start, endSec: raw[8].end }],
		});
		const text = formatScorecard("fixture-a", sc);
		expect(text).toContain("ESSENTIAL WORDS LOST  3");
		expect(text).toContain('"the real content"');
	});
});

describe("kept-output match rate (R1/R2/R3)", () => {
	// 10 distinct words so nothing triggers the duplicate-attribution swap.
	const raw = words(
		"alpha bravo charlie delta echo foxtrot golf hotel india juliet",
	);

	test("hand-computed kept-F1 on an FP/FN mix", () => {
		// Truth cut = {3,4,5}. Proposal cuts {4,5,6,7} (midpoint rule):
		//   bothKeep=5 (0,1,2,8,9), missedCut(fn)=1 ({3}), essentialLost(fp)=2 ({6,7}).
		const truth = [truthSpan(raw, 3, 5)];
		const sc = scoreCutProposals({
			rawWords: raw,
			truthCutSpans: truth,
			proposedSpans: [{ startSec: raw[4].start, endSec: raw[7].end }],
		});
		expect(sc.essentialWordsLost).toBe(2);
		expect(sc.missedCutWords).toBe(1);
		// kept-F1 = 2*bothKeep / (2*bothKeep + fn + fp) = 10 / 13.
		expect(sc.matchRate).toBeCloseTo(10 / 13, 6);
		// No noise excluded → adjusted equals raw.
		expect(sc.matchRateAdjusted).toBeCloseTo(10 / 13, 6);
		// FP zeroed (essential-lost → kept-correct): 2*(5+2)/(2*7 + 1 + 0) = 14/15.
		expect(sc.matchRateFpZeroed).toBeCloseTo(14 / 15, 6);
		// FN zeroed (missed-cut → cut-correct): 2*5/(2*5 + 0 + 2) = 10/12.
		expect(sc.matchRateFnZeroed).toBeCloseTo(10 / 12, 6);
	});

	test("perfect proposal scores 1.0 raw and adjusted", () => {
		const pRaw = words("intro line here um wait no the real content follows");
		const truth = [truthSpan(pRaw, 3, 5)];
		const sc = scoreCutProposals({
			rawWords: pRaw,
			truthCutSpans: truth,
			proposedSpans: [{ startSec: pRaw[3].start, endSec: pRaw[5].end }],
		});
		expect(sc.matchRate).toBe(1);
		expect(sc.matchRateAdjusted).toBe(1);
		expect(sc.matchRateFpZeroed).toBe(1);
		expect(sc.matchRateFnZeroed).toBe(1);
	});

	test("noise-adjusted excludes substitution/moved words; raw does not", () => {
		// Truth cut = {3,4}. Word 6 (golf) is a kept substitution word. Proposal
		// correctly cuts {3,4} but wrongly cuts word 6 → one essential-lost.
		const truth = [truthSpan(raw, 3, 4)];
		const noiseSpans = [truthSpan(raw, 6, 6)];
		const sc = scoreCutProposals({
			rawWords: raw,
			truthCutSpans: truth,
			proposedSpans: [
				{ startSec: raw[3].start, endSec: raw[4].end },
				{ startSec: raw[6].start, endSec: raw[6].end },
			],
			noiseSpans,
		});
		// Raw still penalizes the wrongly-cut noise word.
		expect(sc.essentialWordsLost).toBe(1);
		expect(sc.matchRate).toBeCloseTo(14 / 15, 6); // 2*7/(2*7 + 0 + 1)
		// Adjusted drops word 6 from the matrix → the only error vanishes.
		expect(sc.matchRateAdjusted).toBe(1);
		expect(sc.matchRateAdjusted).toBeGreaterThan(sc.matchRate);
	});

	test("zero proposals yields a defined match rate (no NaN)", () => {
		const pRaw = words("intro line here um wait no the real content follows");
		const truth = [truthSpan(pRaw, 3, 5)]; // 3 truth-cut words survive
		const sc = scoreCutProposals({
			rawWords: pRaw,
			truthCutSpans: truth,
			proposedSpans: [],
		});
		expect(Number.isNaN(sc.matchRate)).toBe(false);
		// bothKeep=7, missedCut(fn)=3, essentialLost(fp)=0 → 14 / 17.
		expect(sc.matchRate).toBeCloseTo(14 / 17, 6);
	});

	test("all-cut proposals yields a defined match rate (no NaN)", () => {
		const pRaw = words("intro line here um wait no the real content follows");
		const truth = [truthSpan(pRaw, 3, 5)];
		const sc = scoreCutProposals({
			rawWords: pRaw,
			truthCutSpans: truth,
			proposedSpans: [{ startSec: pRaw[0].start, endSec: pRaw[9].end }],
		});
		expect(Number.isNaN(sc.matchRate)).toBe(false);
		// bothKeep=0, essentialLost=7 → 2*0/(0+0+7) = 0.
		expect(sc.matchRate).toBe(0);
	});

	test("empty matrix guards to 1.0, never NaN", () => {
		const sc = scoreCutProposals({
			rawWords: [],
			truthCutSpans: [],
			proposedSpans: [],
		});
		expect(sc.matchRate).toBe(1);
		expect(sc.matchRateAdjusted).toBe(1);
		expect(sc.matchRateFpZeroed).toBe(1);
		expect(sc.matchRateFnZeroed).toBe(1);
	});

	test("formatScorecard prints the kept-output match line", () => {
		const truth = [truthSpan(raw, 3, 5)];
		const sc = scoreCutProposals({
			rawWords: raw,
			truthCutSpans: truth,
			proposedSpans: [{ startSec: raw[4].start, endSec: raw[7].end }],
		});
		const text = formatScorecard("fixture-a", sc);
		expect(text).toContain("kept-output match");
		expect(text).toContain("raw /");
		expect(text).toContain("span-discipline");
	});
});

describe("dual proposal sets (auto vs offered, R6/KTD4)", () => {
	const raw = words("intro line here um wait no the real content follows");
	const truth = [truthSpan(raw, 3, 5)];
	const ops: DirectorOp[] = [
		{ id: "a", op: "cut", startSec: 1, endSec: 2, reason: "filler", confidence: 0.9, category: "filler" },
		{ id: "b", op: "cut", startSec: 3, endSec: 4, reason: "repeat", confidence: 0.6, category: "redundancy", defaultAccept: false },
		{ id: "k", op: "keep", startSec: 0, endSec: 0.5, reason: "keep", confidence: 0.9 },
		{ id: "r", op: "reorder", startSec: 5, endSec: 6, reason: "move", confidence: 0.9 },
	];

	test("offered = all cut rows; auto drops the opt-in (defaultAccept false) rows", () => {
		const offered = toProposedCutSpans(ops, "offered");
		const auto = toProposedCutSpans(ops, "auto");
		expect(offered).toHaveLength(2); // a + b, keep/reorder excluded
		expect(auto).toHaveLength(1); // a only (b is opt-in)
		// auto ⊆ offered.
		for (const a of auto) {
			expect(offered.some((o) => o.startSec === a.startSec && o.endSec === a.endSec)).toBe(true);
		}
	});

	test("per-source counts follow op provenance", () => {
		expect(proposalsBySource(ops, "offered")).toEqual({ filler: 1, redundancy: 1 });
		expect(proposalsBySource(ops, "auto")).toEqual({ filler: 1 });
	});

	test("scoreDual: auto is never worse-recall-per-word than offered's superset", () => {
		const dual = scoreDual({
			rawWords: raw,
			truthCutSpans: truth,
			operations: ops.map((o) => ({ ...o, startSec: raw[3].start, endSec: raw[5].end })),
		});
		// Both engage the truth span; offered's larger set can only match >= auto.
		expect(dual.offered.counts.proposedCutWords).toBeGreaterThanOrEqual(
			dual.auto.counts.proposedCutWords,
		);
	});
});

describe("stub-adapter end-to-end (fixture → proposals → dual scorecards)", () => {
	function mkWords(text: string): TranscriptionWord[] {
		return text
			.split(/\s+/)
			.filter(Boolean)
			.map((w, i) => ({ text: w, start: i * 0.3, end: i * 0.3 + 0.28 }));
	}

	test("dual scorecards computed off the real pipeline; auto ⊆ offered", async () => {
		const w = mkWords("so um lets deploy the the project and verify the logs now");
		const segments = [
			{ text: "so um lets deploy the the project", start: w[0].start, end: w[6].end },
			{ text: "and verify the logs now", start: w[7].start, end: w[11].end },
		];
		const totalSec = w[w.length - 1].end;
		const { operations } = await buildDirectorProposals({
			words: w,
			segments,
			features: segments.map((s) => ({
				startSec: s.start,
				endSec: s.end,
				energy: 0.1,
				loudnessRelative: 0.8,
				wpm: 150,
				wordCount: s.text.split(/\s+/).length,
				fillerCandidate: false,
			})),
			envelope: new Array(Math.ceil(totalSec / 0.05)).fill(0.05),
			gaps: [],
			clipSpans: [{ startSec: 0, endSec: totalSec }],
			fps: 30,
			elements: [{ id: "el1", mediaId: "a1", startTime: 0, duration: Math.round(totalSec * 120_000), trimStart: 0 }],
			assets: [{ id: "a1", name: "clip.mp4", durationSec: totalSec }],
			frames: [],
			taste: undefined,
			totalSec,
			config: { vadEnabled: false, visionEnabled: false },
			llm: {
				async plan() {
					return { plan: { operations: [] } };
				},
				async redundancy() {
					return { plan: { groups: [] } };
				},
				async context() {
					return { plan: { flags: [] } };
				},
			},
		});
		const dual = scoreDual({
			rawWords: w,
			truthCutSpans: [truthSpan(w, 1, 1)], // Dan cut "um"
			operations,
		});
		// auto is a subset of offered → its proposed-word count can't exceed it.
		expect(dual.auto.counts.proposedCutWords).toBeLessThanOrEqual(
			dual.offered.counts.proposedCutWords,
		);
		// The always-on filler cleanup caught "um" in the auto (default-accepted) set.
		expect(dual.auto.counts.proposedCutWords).toBeGreaterThan(0);
	});
});
