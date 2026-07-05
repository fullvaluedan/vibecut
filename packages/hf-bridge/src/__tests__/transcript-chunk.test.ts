import { describe, expect, test } from "bun:test";
import {
	chunkTranscriptLines,
	dedupeByKey,
	transcriptExceedsBudget,
} from "../transcript-chunk";

const line = (i: number, chars = 10) => ({ lineId: `L${i}`, text: "x".repeat(chars) });

describe("chunkTranscriptLines (scenario 3)", () => {
	test("a transcript within budget is one window", () => {
		const lines = [line(0), line(1)];
		expect(chunkTranscriptLines({ lines, maxChars: 100, overlapLines: 1 })).toEqual([
			lines,
		]);
	});

	test("at the chunk boundary, consecutive windows share the configured overlap", () => {
		// Four 10-char lines, budget 20 => two lines per window, overlap 1.
		const lines = [line(0), line(1), line(2), line(3)];
		const windows = chunkTranscriptLines({ lines, maxChars: 20, overlapLines: 1 });
		const ids = windows.map((w) => w.map((l) => l.lineId));
		expect(ids).toEqual([
			["L0", "L1"],
			["L1", "L2"],
			["L2", "L3"],
		]);
		// Every adjacent pair shares exactly `overlapLines` line(s).
		for (let i = 1; i < windows.length; i++) {
			const prev = new Set(windows[i - 1].map((l) => l.lineId));
			const shared = windows[i].filter((l) => prev.has(l.lineId));
			expect(shared).toHaveLength(1);
		}
	});

	test("a single over-budget line still gets its own window (never dropped)", () => {
		const lines = [line(0, 50), line(1, 5)];
		const windows = chunkTranscriptLines({ lines, maxChars: 20, overlapLines: 1 });
		expect(windows[0].map((l) => l.lineId)).toContain("L0");
		expect(windows.flat().map((l) => l.lineId)).toContain("L1");
	});

	test("overlap 0 produces disjoint windows", () => {
		const lines = [line(0), line(1), line(2), line(3)];
		const windows = chunkTranscriptLines({ lines, maxChars: 20, overlapLines: 0 });
		expect(windows.map((w) => w.map((l) => l.lineId))).toEqual([
			["L0", "L1"],
			["L2", "L3"],
		]);
	});

	test("empty input yields no windows", () => {
		expect(chunkTranscriptLines({ lines: [], maxChars: 20, overlapLines: 1 })).toEqual([]);
	});
});

describe("dedupeByKey — an op reported in two overlapping windows collapses to one", () => {
	test("keeps the first occurrence of each key, in order", () => {
		// Same op (L1..L2) surfaced by window [L0,L1,L2] and window [L1,L2,L3].
		const ops = [
			{ startLineId: "L0", endLineId: "L0", from: "w0" },
			{ startLineId: "L1", endLineId: "L2", from: "w0" },
			{ startLineId: "L1", endLineId: "L2", from: "w1" }, // duplicate across the overlap
			{ startLineId: "L3", endLineId: "L3", from: "w1" },
		];
		const deduped = dedupeByKey(ops, (o) => `${o.startLineId}:${o.endLineId}`);
		expect(deduped.map((o) => `${o.startLineId}:${o.endLineId}`)).toEqual([
			"L0:L0",
			"L1:L2",
			"L3:L3",
		]);
		// The FIRST occurrence (from the earlier window) is the one kept.
		expect(deduped.find((o) => o.startLineId === "L1")?.from).toBe("w0");
	});
});

describe("transcriptExceedsBudget", () => {
	test("true only when total line text exceeds the budget", () => {
		const lines = [line(0, 10), line(1, 10), line(2, 10)];
		expect(transcriptExceedsBudget({ lines, maxChars: 25 })).toBe(true);
		expect(transcriptExceedsBudget({ lines, maxChars: 100 })).toBe(false);
	});
});
