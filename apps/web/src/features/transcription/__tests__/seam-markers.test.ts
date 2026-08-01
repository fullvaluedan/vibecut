import { describe, expect, test } from "bun:test";
import {
	deriveSeamMarkers,
	groupSeamMarkers,
} from "../seam-markers";
import type { LineageSeam } from "../lineage-types";

function seam({
	id,
	atSec,
	afterWordIndex,
}: {
	id: string;
	atSec: number;
	afterWordIndex: number;
}): LineageSeam {
	return {
		id,
		atSec,
		afterWordIndex,
		removedWords: [{ text: "gone", start: atSec, end: atSec + 1 }],
		removedSpans: [{ startSec: atSec, endSec: atSec + 1 }],
		removedSec: 1,
		contributions: [],
	};
}

const words = [
	{ start: 0, end: 1 },
	{ start: 1, end: 2 },
	{ start: 2, end: 3 },
];

describe("deriveSeamMarkers - word level", () => {
	test("a pipe sits before the surviving word the seam precedes", () => {
		expect(
			deriveSeamMarkers({
				seams: [seam({ id: "s1", atSec: 1, afterWordIndex: 1 })],
				items: words,
				granularity: "word",
			}),
		).toEqual([{ seamId: "s1", beforeIndex: 1 }]);
	});

	test("a leading and a trailing cut land at 0 and at items.length", () => {
		expect(
			deriveSeamMarkers({
				seams: [
					seam({ id: "tail", atSec: 3, afterWordIndex: 3 }),
					seam({ id: "head", atSec: 0, afterWordIndex: 0 }),
				],
				items: words,
				granularity: "word",
			}),
		).toEqual([
			{ seamId: "head", beforeIndex: 0 },
			{ seamId: "tail", beforeIndex: 3 },
		]);
	});

	test("an out-of-range index is clamped instead of dropping the pipe", () => {
		expect(
			deriveSeamMarkers({
				seams: [seam({ id: "s1", atSec: 9, afterWordIndex: 99 })],
				items: words,
				granularity: "word",
			}),
		).toEqual([{ seamId: "s1", beforeIndex: 3 }]);
	});
});

describe("deriveSeamMarkers - segment level", () => {
	const segments = [
		{ start: 0, end: 4 },
		{ start: 4, end: 8 },
		{ start: 8, end: 12 },
	];

	test("a seam on a segment boundary draws before that segment", () => {
		expect(
			deriveSeamMarkers({
				seams: [seam({ id: "s1", atSec: 4, afterWordIndex: 0 })],
				items: segments,
				granularity: "segment",
			}),
		).toEqual([{ seamId: "s1", beforeIndex: 1 }]);
	});

	test("a seam inside a segment attaches to the segment that follows it", () => {
		expect(
			deriveSeamMarkers({
				seams: [seam({ id: "s1", atSec: 5.5, afterWordIndex: 0 })],
				items: segments,
				granularity: "segment",
			}),
		).toEqual([{ seamId: "s1", beforeIndex: 2 }]);
	});

	test("a seam past the last segment becomes a trailing pipe", () => {
		expect(
			deriveSeamMarkers({
				seams: [seam({ id: "s1", atSec: 30, afterWordIndex: 0 })],
				items: segments,
				granularity: "segment",
			}),
		).toEqual([{ seamId: "s1", beforeIndex: 3 }]);
	});

	test("the word index is IGNORED at segment level (it counts a different array)", () => {
		expect(
			deriveSeamMarkers({
				seams: [seam({ id: "s1", atSec: 0, afterWordIndex: 2 })],
				items: segments,
				granularity: "segment",
			}),
		).toEqual([{ seamId: "s1", beforeIndex: 0 }]);
	});
});

describe("groupSeamMarkers", () => {
	test("two seams before the same item both get a pipe", () => {
		const grouped = groupSeamMarkers([
			{ seamId: "a", beforeIndex: 1 },
			{ seamId: "b", beforeIndex: 1 },
			{ seamId: "c", beforeIndex: 2 },
		]);
		expect(grouped.get(1)).toEqual(["a", "b"]);
		expect(grouped.get(2)).toEqual(["c"]);
		expect(grouped.get(0)).toBeUndefined();
	});
});
