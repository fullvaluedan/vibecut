import { describe, expect, test } from "bun:test";
import { findActiveTranscriptIndex } from "../find-active-transcript-index";

const items = [
	{ start: 0, end: 1 },
	{ start: 1, end: 2.5 },
	{ start: 3, end: 4 }, // a gap between 2.5 and 3
	{ start: 4, end: 6 },
];

describe("findActiveTranscriptIndex", () => {
	test("finds the item containing the time (start inclusive)", () => {
		expect(findActiveTranscriptIndex({ items, timeSec: 0 })).toBe(0);
		expect(findActiveTranscriptIndex({ items, timeSec: 1 })).toBe(1);
		expect(findActiveTranscriptIndex({ items, timeSec: 5.9 })).toBe(3);
	});

	test("end is exclusive: at a contiguous boundary, the time belongs to the NEXT item", () => {
		// items[0].end === items[1].start === 1
		expect(findActiveTranscriptIndex({ items, timeSec: 1 })).toBe(1);
	});

	test("returns null inside a gap between items (items[1].end=2.5, items[2].start=3)", () => {
		expect(findActiveTranscriptIndex({ items, timeSec: 2.5 })).toBeNull();
		expect(findActiveTranscriptIndex({ items, timeSec: 2.9 })).toBeNull();
	});

	test("returns null before the first item or after the last", () => {
		expect(findActiveTranscriptIndex({ items, timeSec: -1 })).toBeNull();
		expect(findActiveTranscriptIndex({ items, timeSec: 100 })).toBeNull();
	});

	test("empty items yields null", () => {
		expect(findActiveTranscriptIndex({ items: [], timeSec: 0 })).toBeNull();
	});
});
