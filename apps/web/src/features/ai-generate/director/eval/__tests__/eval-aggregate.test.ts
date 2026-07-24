import { describe, expect, test } from "bun:test";
import {
	formatAggregateTable,
	HEADLINE_METRICS,
	headlineStats,
	stats,
} from "../aggregate";
import type { DualScorecard, Scorecard } from "../score";

/** Minimal valid Scorecard, overridable per test. */
function scorecard(over: Partial<Scorecard> = {}): Scorecard {
	return {
		cutRecall: 1,
		cutPrecision: 1,
		essentialWordsLost: 0,
		missedCutWords: 0,
		matchRate: 1,
		matchRateAdjusted: 1,
		matchRateFpZeroed: 1,
		matchRateFnZeroed: 1,
		counts: { rawWords: 10, truthCutWords: 2, proposedCutWords: 2, truePositives: 2 },
		missedSpans: [],
		falseCutSpans: [],
		meanBoundaryErrorSec: null,
		...over,
	};
}

function dual(over: {
	auto?: Partial<Scorecard>;
	offered?: Partial<Scorecard>;
}): DualScorecard {
	return {
		auto: scorecard(over.auto),
		offered: scorecard(over.offered),
		autoBySource: {},
		offeredBySource: {},
	};
}

describe("stats", () => {
	test("empty sample reports all-zero, never throws", () => {
		expect(stats([])).toEqual({ mean: 0, std: 0, min: 0, max: 0 });
	});

	test("single value: mean/min/max equal the value, std is 0", () => {
		expect(stats([5])).toEqual({ mean: 5, std: 0, min: 5, max: 5 });
	});

	test("mean/min/max/std over a known sample", () => {
		// [2, 4, 4, 4, 5, 5, 7, 9] → mean 5, population std 2 (textbook example).
		const s = stats([2, 4, 4, 4, 5, 5, 7, 9]);
		expect(s.mean).toBeCloseTo(5, 10);
		expect(s.std).toBeCloseTo(2, 10);
		expect(s.min).toBe(2);
		expect(s.max).toBe(9);
	});

	test("constant sample has zero std", () => {
		const s = stats([3, 3, 3, 3]);
		expect(s.std).toBe(0);
		expect(s.mean).toBe(3);
	});
});

describe("headlineStats", () => {
	test("covers all six headline metrics", () => {
		const runs = [dual({}), dual({})];
		const table = headlineStats(runs);
		expect(Object.keys(table).sort()).toEqual([...HEADLINE_METRICS].sort());
	});

	test("reads offered match/recall/precision from the OFFERED scorecard", () => {
		const runs = [
			dual({
				offered: {
					matchRate: 0.6,
					matchRateAdjusted: 0.8,
					cutRecall: 0.9,
					cutPrecision: 0.85,
				},
				auto: { matchRate: 0.1, cutRecall: 0.1 }, // must NOT leak into offered metrics
			}),
		];
		const table = headlineStats(runs);
		expect(table["offered match raw"].mean).toBeCloseTo(0.6, 10);
		expect(table["offered match adj"].mean).toBeCloseTo(0.8, 10);
		expect(table["offered cut recall"].mean).toBeCloseTo(0.9, 10);
		expect(table["offered cut precision"].mean).toBeCloseTo(0.85, 10);
	});

	test("tracks auto and offered essential-words-lost independently", () => {
		const runs = [
			dual({ auto: { essentialWordsLost: 3 }, offered: { essentialWordsLost: 40 } }),
			dual({ auto: { essentialWordsLost: 5 }, offered: { essentialWordsLost: 60 } }),
		];
		const table = headlineStats(runs);
		expect(table["auto essential lost"].mean).toBeCloseTo(4, 10);
		expect(table["offered essential lost"].mean).toBeCloseTo(50, 10);
		expect(table["auto essential lost"].min).toBe(3);
		expect(table["auto essential lost"].max).toBe(5);
	});

	test("empty run batch reports zeroed stats for every metric", () => {
		const table = headlineStats([]);
		for (const metric of HEADLINE_METRICS) {
			expect(table[metric]).toEqual({ mean: 0, std: 0, min: 0, max: 0 });
		}
	});
});

describe("formatAggregateTable", () => {
	test("renders a title, run count, and one row per headline metric", () => {
		const runs = [
			dual({ offered: { matchRate: 0.6, matchRateAdjusted: 0.7 } }),
			dual({ offered: { matchRate: 0.62, matchRateAdjusted: 0.72 } }),
			dual({ offered: { matchRate: 0.64, matchRateAdjusted: 0.74 } }),
		];
		const out = formatAggregateTable("hermes", runs);
		expect(out).toContain("-- hermes (3 runs) --");
		for (const metric of HEADLINE_METRICS) {
			expect(out).toContain(metric);
		}
		// Percent metrics render with a % sign, count metrics don't.
		expect(out).toMatch(/offered match raw\s+62\.0%/);
		expect(out).toMatch(/auto essential lost\s+0\.0(?!%)/);
	});

	test("singular run count grammar", () => {
		const out = formatAggregateTable("solo", [dual({})]);
		expect(out).toContain("-- solo (1 run) --");
	});
});
