import { describe, expect, test } from "bun:test";
import { scoreCutProposals, formatScorecard } from "../score";
import type { TruthCutSpan } from "../align";
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
