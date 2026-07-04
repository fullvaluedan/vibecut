import { describe, expect, test } from "bun:test";
import {
	coalesceRemovalRanges,
	subtractRemovalRanges,
} from "../coalesce-removal-ranges";
import type { WordTiming } from "../cut-utils";

// 120k ticks/sec, 30fps → 15-frame floor = 60_000 ticks (0.5s), 1 frame = 4_000 ticks.
const TPS = 120_000;
const FLOOR = 60_000;
const frames = (n: number) => n * (TPS / 30);

// A word fully inside range1 [0, 1s), NEVER in the inter-cut gap - present so the
// word-guard is ACTIVE (an empty word list disables merging entirely).
const anchor: WordTiming[] = [{ text: "hello", start: 0.1, end: 0.9 }];

describe("coalesceRemovalRanges", () => {
	test("8-frame gap with only noise: merged into one range", () => {
		const out = coalesceRemovalRanges({
			ranges: [
				{ start: 0, end: TPS },
				{ start: TPS + frames(8), end: TPS + frames(8) + 40_000 },
			],
			words: anchor,
			floorTicks: FLOOR,
			ticksPerSecond: TPS,
		});
		expect(out).toEqual([{ start: 0, end: TPS + frames(8) + 40_000 }]);
	});

	test("8-frame gap containing the complete word \"free\": NOT merged", () => {
		const words: WordTiming[] = [
			...anchor,
			// Fully inside the gap [1.0s, 1.2667s].
			{ text: "free", start: 1.05, end: 1.2 },
		];
		const out = coalesceRemovalRanges({
			ranges: [
				{ start: 0, end: TPS },
				{ start: TPS + frames(8), end: TPS + frames(8) + 40_000 },
			],
			words,
			floorTicks: FLOOR,
			ticksPerSecond: TPS,
		});
		expect(out).toHaveLength(2);
	});

	test("a gap overlapping a protected span is NEVER merged (review F5)", () => {
		// Same 8-frame noise gap as the merge case, but the user rejected the review
		// row covering it (or a keeper protects it): the word-guard alone cannot save
		// a filler/word-free span, the protected-span check must.
		const gapStart = TPS;
		const gapEnd = TPS + frames(8);
		const out = coalesceRemovalRanges({
			ranges: [
				{ start: 0, end: TPS },
				{ start: gapEnd, end: gapEnd + 40_000 },
			],
			words: anchor,
			floorTicks: FLOOR,
			ticksPerSecond: TPS,
			protectedSpansSec: [{ startSec: gapStart / TPS, endSec: gapEnd / TPS }],
		});
		expect(out).toHaveLength(2);
	});

	test("a protected span elsewhere does not stop an unrelated merge", () => {
		const out = coalesceRemovalRanges({
			ranges: [
				{ start: 0, end: TPS },
				{ start: TPS + frames(8), end: TPS + frames(8) + 40_000 },
			],
			words: anchor,
			floorTicks: FLOOR,
			ticksPerSecond: TPS,
			protectedSpansSec: [{ startSec: 100, endSec: 101 }],
		});
		expect(out).toHaveLength(1);
	});

	test("20-frame gap (over floor): NOT merged", () => {
		const out = coalesceRemovalRanges({
			ranges: [
				{ start: 0, end: TPS },
				{ start: TPS + frames(20), end: TPS + frames(20) + 40_000 },
			],
			words: anchor,
			floorTicks: FLOOR,
			ticksPerSecond: TPS,
		});
		expect(out).toHaveLength(2);
	});

	test("chain of 5 cuts each 5 frames apart: all collapse to one (transitive)", () => {
		const ranges = [
			{ start: 0, end: 40_000 },
			{ start: 60_000, end: 100_000 },
			{ start: 120_000, end: 160_000 },
			{ start: 180_000, end: 220_000 },
			{ start: 240_000, end: 280_000 },
		];
		// gaps of 20_000 ticks (5 frames) < FLOOR, none containing a content word.
		const out = coalesceRemovalRanges({
			ranges,
			words: [{ text: "x", start: 0, end: 0.01 }], // inside range 0, not in a gap
			floorTicks: FLOOR,
			ticksPerSecond: TPS,
		});
		expect(out).toEqual([{ start: 0, end: 280_000 }]);
	});

	test("no words provided: nothing merges (fail-open to keeping footage)", () => {
		const ranges = [
			{ start: 0, end: TPS },
			{ start: TPS + frames(8), end: TPS + frames(8) + 40_000 },
		];
		expect(
			coalesceRemovalRanges({ ranges, words: [], floorTicks: FLOOR, ticksPerSecond: TPS }),
		).toHaveLength(2);
		expect(
			coalesceRemovalRanges({ ranges, floorTicks: FLOOR, ticksPerSecond: TPS }),
		).toHaveLength(2);
	});

	test("a filler \"um\" alone in the gap does not count as content: merged", () => {
		const words: WordTiming[] = [
			...anchor,
			{ text: "um", start: 1.05, end: 1.15 }, // inside the gap, but filler
		];
		const out = coalesceRemovalRanges({
			ranges: [
				{ start: 0, end: TPS },
				{ start: TPS + frames(8), end: TPS + frames(8) + 40_000 },
			],
			words,
			floorTicks: FLOOR,
			ticksPerSecond: TPS,
		});
		expect(out).toHaveLength(1);
	});

	test("a word straddling a cut edge (not fully inside the gap) does not block a merge", () => {
		const words: WordTiming[] = [
			// Starts inside range1, ends in the gap - only partly inside → not content-in-gap.
			{ text: "straddle", start: 0.95, end: 1.05 },
		];
		const out = coalesceRemovalRanges({
			ranges: [
				{ start: 0, end: TPS },
				{ start: TPS + frames(8), end: TPS + frames(8) + 40_000 },
			],
			words,
			floorTicks: FLOOR,
			ticksPerSecond: TPS,
		});
		expect(out).toHaveLength(1);
	});

	test("overlapping / touching ranges always merge (no gap to guard)", () => {
		const out = coalesceRemovalRanges({
			ranges: [
				{ start: 0, end: 100_000 },
				{ start: 80_000, end: 150_000 },
			],
			words: [], // guard off, but overlaps merge regardless
			floorTicks: FLOOR,
			ticksPerSecond: TPS,
		});
		expect(out).toEqual([{ start: 0, end: 150_000 }]);
	});

	test("degenerate (non-positive width) ranges are dropped", () => {
		const out = coalesceRemovalRanges({
			ranges: [
				{ start: 5, end: 5 },
				{ start: 10, end: 8 },
				{ start: 0, end: TPS },
			],
			words: anchor,
			floorTicks: FLOOR,
			ticksPerSecond: TPS,
		});
		expect(out).toEqual([{ start: 0, end: TPS }]);
	});

	test("idempotent: coalescing twice equals once", () => {
		const ranges = [
			{ start: 0, end: TPS },
			{ start: TPS + frames(8), end: TPS + frames(8) + 40_000 },
			{ start: TPS + frames(8) + 40_000 + frames(6), end: TPS + frames(8) + 120_000 },
		];
		const once = coalesceRemovalRanges({ ranges, words: anchor, floorTicks: FLOOR, ticksPerSecond: TPS });
		const twice = coalesceRemovalRanges({ ranges: once, words: anchor, floorTicks: FLOOR, ticksPerSecond: TPS });
		expect(twice).toEqual(once);
	});

	test("INVARIANT: a dense cut plan leaves zero sub-floor content-free gaps between removals", () => {
		// Alternating gaps: tight 4-frame gaps (must be swallowed) and wide 30-frame gaps
		// (must survive) - the mixed sliver-generating case. Content-free throughout.
		const ranges: { start: number; end: number }[] = [];
		let cursor = 0;
		for (let i = 0; i < 12; i++) {
			ranges.push({ start: cursor, end: cursor + frames(4) });
			cursor += frames(4) + (i % 2 === 0 ? frames(4) : frames(30));
		}
		const out = coalesceRemovalRanges({
			ranges,
			words: [{ text: "intro", start: 0, end: 0.02 }], // no content in any inter-cut gap
			floorTicks: FLOOR,
			ticksPerSecond: TPS,
		});
		// The tight gaps collapsed (fewer ranges out than in) ...
		expect(out.length).toBeLessThan(ranges.length);
		// ... and no range survives behind a sub-floor gap.
		for (let i = 1; i < out.length; i++) {
			const gap = out[i].start - out[i - 1].end;
			expect(gap).toBeGreaterThanOrEqual(FLOOR);
		}
	});
});

// Review X6: rejected rows are carved out of the final ranges so reject stays
// authoritative even when an accepted WIDER op directly covers them (TPS=120_000).
describe("subtractRemovalRanges", () => {
	test("carves a rejected span out of the middle of an accepted range", () => {
		// Accepted [0,10s]; user rejected [3,4s] -> two ranges around it.
		const out = subtractRemovalRanges({
			ranges: [{ start: 0, end: 10 * TPS }],
			spansSec: [{ startSec: 3, endSec: 4 }],
			ticksPerSecond: TPS,
		});
		expect(out).toEqual([
			{ start: 0, end: 3 * TPS },
			{ start: 4 * TPS, end: 10 * TPS },
		]);
	});

	test("a rejected span at a range edge trims, does not split", () => {
		const out = subtractRemovalRanges({
			ranges: [{ start: 0, end: 10 * TPS }],
			spansSec: [{ startSec: 0, endSec: 2 }],
			ticksPerSecond: TPS,
		});
		expect(out).toEqual([{ start: 2 * TPS, end: 10 * TPS }]);
	});

	test("a rejected span covering a whole range drops it entirely", () => {
		const out = subtractRemovalRanges({
			ranges: [{ start: 5 * TPS, end: 8 * TPS }],
			spansSec: [{ startSec: 4, endSec: 9 }],
			ticksPerSecond: TPS,
		});
		expect(out).toEqual([]);
	});

	test("multiple rejected spans in one range carve multiple holes", () => {
		const out = subtractRemovalRanges({
			ranges: [{ start: 0, end: 10 * TPS }],
			spansSec: [
				{ startSec: 2, endSec: 3 },
				{ startSec: 6, endSec: 7 },
			],
			ticksPerSecond: TPS,
		});
		expect(out).toEqual([
			{ start: 0, end: 2 * TPS },
			{ start: 3 * TPS, end: 6 * TPS },
			{ start: 7 * TPS, end: 10 * TPS },
		]);
	});

	test("no rejected spans returns the ranges unchanged", () => {
		const ranges = [{ start: 0, end: TPS }];
		expect(subtractRemovalRanges({ ranges, spansSec: [], ticksPerSecond: TPS })).toEqual(ranges);
	});

	test("a rejected span outside every range is a no-op", () => {
		const ranges = [{ start: 0, end: 2 * TPS }];
		expect(
			subtractRemovalRanges({
				ranges,
				spansSec: [{ startSec: 50, endSec: 51 }],
				ticksPerSecond: TPS,
			}),
		).toEqual(ranges);
	});
});
