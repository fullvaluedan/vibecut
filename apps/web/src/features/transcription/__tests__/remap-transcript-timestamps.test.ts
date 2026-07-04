import { describe, expect, test } from "bun:test";
import { remapTranscriptTimestamps } from "../remap-transcript-timestamps";

const items = [
	{ start: 0, end: 1, text: "a" },
	{ start: 1, end: 2, text: "b" }, // the deleted span [1, 3)
	{ start: 2, end: 3, text: "c" },
	{ start: 3, end: 4, text: "d" }, // starts at deletedEnd -> shifts
	{ start: 5, end: 6, text: "e" },
];

describe("remapTranscriptTimestamps", () => {
	test("shifts items at or after deletedEndSec left by removedDurationSec", () => {
		const out = remapTranscriptTimestamps({
			items,
			deletedEndSec: 3,
			removedDurationSec: 2,
		});
		// Before / inside the deleted range: unchanged.
		expect(out[0]).toEqual({ start: 0, end: 1, text: "a" });
		expect(out[1]).toEqual({ start: 1, end: 2, text: "b" });
		expect(out[2]).toEqual({ start: 2, end: 3, text: "c" });
		// At-or-after deletedEnd: shifted by 2.
		expect(out[3]).toEqual({ start: 1, end: 2, text: "d" });
		expect(out[4]).toEqual({ start: 3, end: 4, text: "e" });
	});

	test("does not mutate the input array", () => {
		const before = JSON.parse(JSON.stringify(items));
		remapTranscriptTimestamps({ items, deletedEndSec: 3, removedDurationSec: 2 });
		expect(items).toEqual(before);
	});
});
