import { describe, expect, test } from "bun:test";
import { formatTranscriptText } from "../format-transcript-text";

describe("formatTranscriptText", () => {
	test("produces one [mm:ss.s–mm:ss.s] line per segment, in order", () => {
		const text = formatTranscriptText({
			segments: [
				{ start: 0, end: 3.5, text: "hello there" },
				{ start: 3.5, end: 8, text: "second line" },
				{ start: 65.3, end: 70.1, text: "past a minute" },
			],
		});
		expect(text.split("\n")).toEqual([
			"[00:00.0–00:03.5] hello there",
			"[00:03.5–00:08.0] second line",
			"[01:05.3–01:10.1] past a minute",
		]);
	});

	test("trims segment text", () => {
		expect(
			formatTranscriptText({ segments: [{ start: 0, end: 1, text: "  hi  " }] }),
		).toBe("[00:00.0–00:01.0] hi");
	});

	test("empty transcript yields an empty string", () => {
		expect(formatTranscriptText({ segments: [] })).toBe("");
	});

	test("deterministic: same input yields byte-identical output (Copy == Export)", () => {
		const segments = [{ start: 1, end: 2, text: "a" }];
		expect(formatTranscriptText({ segments })).toBe(
			formatTranscriptText({ segments }),
		);
	});
});
