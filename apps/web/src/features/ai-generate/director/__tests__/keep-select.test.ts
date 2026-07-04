import { describe, expect, test } from "bun:test";
import {
	buildHighlightKeeps,
	mergeSpans,
	selectKeepSpans,
	type KeepSelectSegment,
} from "../keep-select";

/** Build contiguous segments from a list of durations (seconds). */
function segs(durations: number[]): KeepSelectSegment[] {
	const out: KeepSelectSegment[] = [];
	let t = 0;
	for (const d of durations) {
		out.push({ start: t, end: t + d });
		t += d;
	}
	return out;
}

function totalKept(spans: { startSec: number; endSec: number }[]): number {
	return spans.reduce((acc, s) => acc + (s.endSec - s.startSec), 0);
}

describe("selectKeepSpans — threshold mode", () => {
	test("keeps above-threshold segments and merges adjacent ones into spans", () => {
		const spans = selectKeepSpans({
			segments: segs([2, 2, 2, 2, 2]),
			importance: [0.2, 0.8, 0.9, 0.1, 0.7],
		});
		// indices 1,2 are adjacent → one span [2,6]; index 4 → [8,10].
		expect(spans).toEqual([
			{ startSec: 2, endSec: 6 },
			{ startSec: 8, endSec: 10 },
		]);
	});

	test("empty input → empty output", () => {
		expect(selectKeepSpans({ segments: [], importance: [] })).toEqual([]);
	});
});

describe("selectKeepSpans — budget mode", () => {
	test("selected total lands near the budget", () => {
		const spans = selectKeepSpans({
			segments: segs([3, 3, 3, 3, 3]),
			importance: [0.9, 0.8, 0.7, 0.6, 0.5],
			budgetSec: 6,
		});
		expect(totalKept(spans)).toBe(6);
		expect(spans).toEqual([{ startSec: 0, endSec: 6 }]); // contiguous run, not scattered
	});

	test("budget underflow keeps exactly the single highest-importance span (never empty)", () => {
		const spans = selectKeepSpans({
			segments: segs([5, 5, 5, 5, 5]),
			importance: [0.5, 0.9, 0.3, 0.7, 0.1],
			budgetSec: 0.001,
		});
		expect(spans).toHaveLength(1);
		expect(spans[0]).toEqual({ startSec: 5, endSec: 10 }); // index 1 (top score)
	});

	test("budget ≥ total keeps everything (one span, complement empty)", () => {
		const spans = selectKeepSpans({
			segments: segs([3, 3, 3, 3, 3]),
			importance: [0.9, 0.1, 0.5, 0.2, 0.8],
			budgetSec: 100,
		});
		expect(spans).toEqual([{ startSec: 0, endSec: 15 }]);
	});

	test("contiguity bias: grows an adjacent run rather than starting a scattered one", () => {
		const spans = selectKeepSpans({
			segments: segs([3, 3, 3, 3, 3]),
			importance: [0.9, 0.85, 0.1, 0.1, 0.88], // index 4 scores high but is far
			budgetSec: 6,
		});
		// Seed at 0 grows into its neighbor 1; the far high-score index 4 is NOT picked.
		expect(spans).toEqual([{ startSec: 0, endSec: 6 }]);
	});

	test("max-jump-cut bound caps the number of separate runs", () => {
		const spans = selectKeepSpans({
			segments: segs([1, 1, 1, 1, 1, 1, 1, 1, 1]),
			importance: [0.9, 0.05, 0.05, 0.05, 0.9, 0.05, 0.05, 0.05, 0.9],
			budgetSec: 8,
			options: { maxRuns: 2, minSpanSec: 1 },
		});
		expect(spans.length).toBeLessThanOrEqual(2);
		// The third high-score island (index 8, start 8) is dropped by the cap.
		expect(spans.some((s) => s.startSec === 8)).toBe(false);
	});

	test("budget-mode runs meet the min-span floor (no sub-floor slivers)", () => {
		const spans = selectKeepSpans({
			segments: segs([1, 1, 1, 1, 1, 1]),
			importance: [0.9, 0.4, 0.85, 0.4, 0.8, 0.4],
			budgetSec: 4,
			options: { minSpanSec: 2 },
		});
		for (const s of spans) {
			expect(s.endSec - s.startSec).toBeGreaterThanOrEqual(2);
		}
	});

	test("spans are returned in timeline order", () => {
		const spans = selectKeepSpans({
			segments: segs([2, 2, 2, 2, 2]),
			importance: [0.95, 0.1, 0.9, 0.1, 0.92],
			budgetSec: 6,
			options: { minSpanSec: 1, maxRuns: 5, extendThreshold: 0.5 },
		});
		const starts = spans.map((s) => s.startSec);
		expect([...starts].sort((a, b) => a - b)).toEqual(starts);
	});
});

describe("mergeSpans", () => {
	test("sorts and merges overlapping/adjacent spans", () => {
		expect(
			mergeSpans([
				{ startSec: 10, endSec: 12 },
				{ startSec: 0, endSec: 5 },
				{ startSec: 3, endSec: 8 },
			]),
		).toEqual([
			{ startSec: 0, endSec: 8 },
			{ startSec: 10, endSec: 12 },
		]);
	});

	test("drops zero/negative-length spans", () => {
		expect(mergeSpans([{ startSec: 5, endSec: 5 }])).toEqual([]);
	});
});

describe("buildHighlightKeeps", () => {
	const segments = segs([3, 3, 3, 3, 3]); // total 15

	test("with a budget, uses the deterministic contiguity-aware selection", () => {
		const { keeps, preview } = buildHighlightKeeps({
			segments,
			importance: [0.9, 0.8, 0.7, 0.6, 0.5],
			totalSec: 15,
			budgetSec: 6,
		});
		expect(keeps).toEqual([{ startSec: 0, endSec: 6 }]);
		expect(preview).toEqual({ keptCount: 1, totalCount: 5, keptSec: 6, totalSec: 15 });
	});

	test("without a budget, LLM keep spans are primary (unioned with the emphasis floor)", () => {
		const { keeps } = buildHighlightKeeps({
			segments,
			importance: [0.2, 0.2, 0.2, 0.2, 0.2], // all below the keep floor → no deterministic floor
			totalSec: 15,
			llmKeepSpans: [{ startSec: 6, endSec: 9 }], // the LLM's load-bearing pick
		});
		expect(keeps).toEqual([{ startSec: 6, endSec: 9 }]);
	});

	test("without a budget and no LLM spans, falls back to the emphasis floor", () => {
		const { keeps } = buildHighlightKeeps({
			segments,
			importance: [0.9, 0.2, 0.8, 0.2, 0.2], // segs 0,2 above the 0.5 floor
			totalSec: 15,
		});
		expect(keeps).toEqual([
			{ startSec: 0, endSec: 3 },
			{ startSec: 6, endSec: 9 },
		]);
	});
});
