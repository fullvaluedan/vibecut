import { describe, expect, test } from "bun:test";
import {
	formatTranscriptCsv,
	formatTranscriptSrt,
	formatTranscriptTxt,
} from "../export-transcript";

describe("formatTranscriptTxt", () => {
	test("includeTimecodes on: one [mm:ss.s-mm:ss.s] line per segment", () => {
		const text = formatTranscriptTxt({
			segments: [
				{ start: 0, end: 3.5, text: "hello there" },
				{ start: 65.3, end: 70.1, text: "past a minute" },
			],
			includeTimecodes: true,
		});
		expect(text.split("\n")).toEqual([
			"[00:00.0-00:03.5] hello there",
			"[01:05.3-01:10.1] past a minute",
		]);
	});

	test("includeTimecodes off: plain text, one line per segment", () => {
		const text = formatTranscriptTxt({
			segments: [
				{ start: 0, end: 3.5, text: "hello there" },
				{ start: 3.5, end: 8, text: "second line" },
			],
			includeTimecodes: false,
		});
		expect(text).toBe("hello there\nsecond line");
	});

	test("trims segment text", () => {
		expect(
			formatTranscriptTxt({
				segments: [{ start: 0, end: 1, text: "  hi  " }],
				includeTimecodes: false,
			}),
		).toBe("hi");
	});

	test("empty transcript yields an empty string, timecodes on or off", () => {
		expect(
			formatTranscriptTxt({ segments: [], includeTimecodes: true }),
		).toBe("");
		expect(
			formatTranscriptTxt({ segments: [], includeTimecodes: false }),
		).toBe("");
	});
});

describe("formatTranscriptCsv", () => {
	test("no-speaker transcript: header is just start,end,text", () => {
		const csv = formatTranscriptCsv({
			segments: [{ start: 0, end: 1.5, text: "hi" }],
		});
		expect(csv.split("\r\n")[0]).toBe("start,end,text");
	});

	test("empty transcript yields just the header row", () => {
		expect(formatTranscriptCsv({ segments: [] })).toBe("start,end,text");
	});

	test("timecode rounding: fixed 3 decimals, floating-point noise rounded away", () => {
		const csv = formatTranscriptCsv({
			segments: [{ start: 65.34999996, end: 70.1, text: "x" }],
		});
		const row = csv.split("\r\n")[1];
		expect(row).toBe("65.350,70.100,x");
	});

	test("special characters: a comma in the text is quoted", () => {
		const csv = formatTranscriptCsv({
			segments: [{ start: 0, end: 1, text: "hello, world" }],
		});
		expect(csv.split("\r\n")[1]).toBe('0.000,1.000,"hello, world"');
	});

	test("special characters: a double quote in the text is escaped and quoted", () => {
		const csv = formatTranscriptCsv({
			segments: [{ start: 0, end: 1, text: 'she said "hi"' }],
		});
		expect(csv.split("\r\n")[1]).toBe(
			'0.000,1.000,"she said ""hi"""',
		);
	});

	test("multi-line text is quoted so the embedded newline stays inside the field", () => {
		const csv = formatTranscriptCsv({
			segments: [{ start: 0, end: 1, text: "line one\nline two" }],
		});
		// The whole CSV has 2 logical rows (header + data) even though the data
		// row's quoted field contains a literal newline.
		expect(csv).toBe('start,end,text\r\n0.000,1.000,"line one\nline two"');
	});

	test("text without special characters is not quoted", () => {
		const csv = formatTranscriptCsv({
			segments: [{ start: 0, end: 1, text: "plain text" }],
		});
		expect(csv.split("\r\n")[1]).toBe("0.000,1.000,plain text");
	});
});

describe("formatTranscriptSrt", () => {
	test("reuses the shared srt.ts writer (segment -> cue mapping)", () => {
		const srt = formatTranscriptSrt({
			segments: [{ start: 0, end: 2.5, text: "hello" }],
		});
		expect(srt).toBe("1\n00:00:00,000 --> 00:00:02,500\nhello\n");
	});

	test("empty transcript yields an empty string", () => {
		expect(formatTranscriptSrt({ segments: [] })).toBe("");
	});

	test("skips a zero-duration segment (start === end)", () => {
		const srt = formatTranscriptSrt({
			segments: [
				{ start: 0, end: 0, text: "glitch" },
				{ start: 1, end: 2, text: "real" },
			],
		});
		expect(srt).toBe("1\n00:00:01,000 --> 00:00:02,000\nreal\n");
	});
});
