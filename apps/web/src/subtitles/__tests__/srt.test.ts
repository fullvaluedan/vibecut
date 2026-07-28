import { describe, expect, test } from "bun:test";
import { parseSrt, writeSrt } from "../srt";
import type { SubtitleCue } from "../types";

describe("writeSrt", () => {
	test("writes a single cue in standard SRT block form", () => {
		const text = writeSrt({
			cues: [{ text: "hello there", startTime: 0, duration: 3.5 }],
		});
		expect(text).toBe("1\n00:00:00,000 --> 00:00:03,500\nhello there\n");
	});

	test("writes multiple cues, numbered in order and separated by a blank line", () => {
		const text = writeSrt({
			cues: [
				{ text: "first", startTime: 0, duration: 2 },
				{ text: "second", startTime: 2, duration: 1.25 },
			],
		});
		expect(text).toBe(
			"1\n00:00:00,000 --> 00:00:02,000\nfirst\n\n2\n00:00:02,000 --> 00:00:03,250\nsecond\n",
		);
	});

	test("rolls minutes and hours over correctly", () => {
		const text = writeSrt({
			cues: [{ text: "late", startTime: 3665.4, duration: 1 }],
		});
		expect(text).toContain("01:01:05,400 --> 01:01:06,400");
	});

	test("trims cue text", () => {
		const text = writeSrt({
			cues: [{ text: "  padded  ", startTime: 0, duration: 1 }],
		});
		expect(text).toBe("1\n00:00:00,000 --> 00:00:01,000\npadded\n");
	});

	test("skips zero-duration and empty-text cues", () => {
		const text = writeSrt({
			cues: [
				{ text: "kept", startTime: 0, duration: 1 },
				{ text: "zero duration", startTime: 1, duration: 0 },
				{ text: "   ", startTime: 2, duration: 1 },
			],
		});
		expect(text).toBe("1\n00:00:00,000 --> 00:00:01,000\nkept\n");
	});

	test("empty cue list yields an empty string", () => {
		expect(writeSrt({ cues: [] })).toBe("");
	});

	test("round trip: parseSrt(writeSrt(cues)) recovers matching text and timing to the millisecond", () => {
		const cues: SubtitleCue[] = [
			{ text: "one two three", startTime: 0, duration: 2.5 },
			{ text: "four five", startTime: 2.5, duration: 1.75 },
			{ text: "past a minute", startTime: 65.3, duration: 4.8 },
		];
		const result = parseSrt({ input: writeSrt({ cues }) });
		expect(result.skippedCueCount).toBe(0);
		expect(result.captions.map((c) => c.text)).toEqual(
			cues.map((c) => c.text),
		);
		// Millisecond-precision comparison: writeSrt/parseSrt both round-trip through
		// a "HH:MM:SS,mmm" string, so exact float equality on the raw seconds is not
		// guaranteed (floating point subtraction noise on the recovered duration).
		cues.forEach((cue, index) => {
			const parsed = result.captions[index];
			expect(parsed.startTime).toBeCloseTo(cue.startTime, 3);
			expect(parsed.startTime + parsed.duration).toBeCloseTo(
				cue.startTime + cue.duration,
				3,
			);
		});
	});
});
