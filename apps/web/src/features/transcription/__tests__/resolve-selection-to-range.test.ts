/* eslint-disable opencut/prefer-object-params -- positional args keep this test's selection helper terse. */
import { describe, expect, test } from "bun:test";
import {
	resolveSelectionToTimeRange,
	type TranscriptSelection,
} from "../resolve-selection-to-range";
import type {
	TranscriptSegmentLite,
	TranscriptWordLite,
} from "../transcript-cache";

const words: TranscriptWordLite[] = Array.from({ length: 20 }, (_, i) => ({
	start: i,
	end: i + 0.9,
	text: `w${i}`,
}));

const segments: TranscriptSegmentLite[] = [
	{ start: 0, end: 3.5, text: "first" },
	{ start: 3.5, end: 8, text: "second" },
	{ start: 8, end: 12, text: "third" },
];

function sel(
	startIndex: number,
	endIndex: number,
	granularity: TranscriptSelection["granularity"] = "word",
): TranscriptSelection {
	return { startIndex, endIndex, granularity };
}

describe("resolveSelectionToTimeRange", () => {
	test("word range [5, 12] resolves to words[5].start .. words[12].end", () => {
		expect(
			resolveSelectionToTimeRange({ selection: sel(5, 12), words, segments }),
		).toEqual({ startSec: words[5].start, endSec: words[12].end });
	});

	test("segment range resolves using segment boundaries", () => {
		expect(
			resolveSelectionToTimeRange({
				selection: sel(0, 1, "segment"),
				words,
				segments,
			}),
		).toEqual({ startSec: segments[0].start, endSec: segments[1].end });
	});

	test("single-word selection resolves to that word's own span", () => {
		expect(
			resolveSelectionToTimeRange({ selection: sel(7, 7), words, segments }),
		).toEqual({ startSec: words[7].start, endSec: words[7].end });
	});

	test("endIndex < startIndex returns null", () => {
		expect(
			resolveSelectionToTimeRange({ selection: sel(8, 3), words, segments }),
		).toBeNull();
	});

	test("out-of-bounds indices return null", () => {
		expect(
			resolveSelectionToTimeRange({ selection: sel(-1, 2), words, segments }),
		).toBeNull();
		expect(
			resolveSelectionToTimeRange({ selection: sel(5, 99), words, segments }),
		).toBeNull();
	});

	test("word granularity with empty words returns null", () => {
		expect(
			resolveSelectionToTimeRange({
				selection: sel(0, 0),
				words: [],
				segments,
			}),
		).toBeNull();
	});
});
