/**
 * G6 reopen (T16.1/T16.2). The Export menu serializes SEGMENTS only
 * (export-transcript.ts: txt/srt/csv all read `segments`), while the panel renders
 * the lineage view's WORDS. So any segment the lineage view drops or mis-times is
 * silently missing from the exported file even though the panel looks right.
 *
 * These tests pin the segment side of `viewFromRecord` to the same word journal the
 * word side already follows: a segment survives while ANY of its words survive, its
 * bounds shrink to the surviving extent, and only a segment with nothing left is
 * dropped. The word-less capture path (`wordsUnavailable`) gets the same treatment
 * from the journal ranges directly, since it has no words to fold.
 *
 * Pure: `viewFromRecord` takes an explicit journal prefix, so nothing here touches
 * storage, hashing or the editor.
 */

import { describe, expect, test } from "bun:test";
import { viewFromRecord } from "../lineage";
import {
	formatTranscriptCsv,
	formatTranscriptSrt,
	formatTranscriptTxt,
} from "../export-transcript";
import {
	TRANSCRIPT_LINEAGE_VERSION,
	type LineageJournalEntry,
	type LineageSourceRange,
	type TranscriptLineageRecord,
} from "../lineage-types";

const TPS = 120_000;
const ticks = (sec: number): number => Math.round(sec * TPS);

/** One word per second, grouped into three sentences. */
const WORDS = [
	{ text: "one", start: 0, end: 1 },
	{ text: "two", start: 1, end: 2 },
	{ text: "three", start: 2, end: 3 },
	{ text: "four", start: 3, end: 4 },
	{ text: "five", start: 4, end: 5 },
	{ text: "six", start: 5, end: 6 },
	{ text: "seven", start: 6, end: 7 },
	{ text: "eight", start: 7, end: 8 },
	{ text: "nine", start: 8, end: 9 },
	{ text: "ten", start: 9, end: 10 },
];
const SEGMENTS = [
	{ text: "one two three four five", start: 0, end: 5 },
	{ text: "six seven eight", start: 5, end: 8 },
	{ text: "nine ten", start: 8, end: 10 },
];

function makeRecord(
	overrides: Partial<TranscriptLineageRecord> = {},
): TranscriptLineageRecord {
	return {
		version: TRANSCRIPT_LINEAGE_VERSION,
		projectId: "p1",
		captureHash: "h0",
		words: WORDS.map((w) => ({ ...w })),
		segments: SEGMENTS.map((s) => ({ ...s })),
		sourceTotalSec: 10,
		journal: [],
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

let entrySeq = 0;

function removalEntry(...ranges: LineageSourceRange[]): LineageJournalEntry {
	const n = ++entrySeq;
	return {
		id: `e${n}`,
		source: "manual-transcript",
		ranges,
		at: n,
		hashBefore: `h${n - 1}`,
		hashAfter: `h${n}`,
	};
}

function restoreEntry(...restores: LineageSourceRange[]): LineageJournalEntry {
	const n = ++entrySeq;
	return {
		id: `r${n}`,
		source: "manual-transcript",
		ranges: [],
		restores,
		at: n,
		hashBefore: `h${n - 1}`,
		hashAfter: `h${n}`,
	};
}

/** The three exports of a journal prefix, so every case checks all of them. */
function exportsOf(entries: readonly LineageJournalEntry[], record = makeRecord()) {
	const view = viewFromRecord({ record, entries });
	const segments = view.segments;
	return {
		view,
		segments,
		txt: formatTranscriptTxt({ segments, includeTimecodes: true }),
		csv: formatTranscriptCsv({ segments }),
		srt: formatTranscriptSrt({ segments }),
	};
}

describe("lineage view segments - a removal strictly inside one segment", () => {
	// Delete "two three four" (1s..4s): three words strictly inside segment 1, the
	// round-16 verifier's repro. Survivors: "one" (0..1) and "five" (4..5), which
	// lands at 1..2 on the current timeline once the 3s hole collapses.
	const entries = [removalEntry({ start: ticks(1), end: ticks(4) })];

	test("segment 1 survives with its remaining words", () => {
		const { segments } = exportsOf(entries);
		expect(segments.map((s) => s.text)).toEqual([
			"one five",
			"six seven eight",
			"nine ten",
		]);
	});

	test("the surviving segment carries adjusted timecodes", () => {
		const { segments } = exportsOf(entries);
		expect(segments).toEqual([
			{ text: "one five", start: 0, end: 2 },
			{ text: "six seven eight", start: 2, end: 5 },
			{ text: "nine ten", start: 5, end: 7 },
		]);
	});

	test("the view's words and segments agree on what survived", () => {
		const { view, segments } = exportsOf(entries);
		expect(view.words.map((w) => w.text)).toEqual([
			"one",
			"five",
			"six",
			"seven",
			"eight",
			"nine",
			"ten",
		]);
		expect(segments.map((s) => s.text).join(" ").split(" ")).toEqual(
			view.words.map((w) => w.text),
		);
	});

	test("txt export keeps the segment and its adjusted timecodes", () => {
		const { txt } = exportsOf(entries);
		expect(txt.split("\n")).toEqual([
			"[00:00.0-00:02.0] one five",
			"[00:02.0-00:05.0] six seven eight",
			"[00:05.0-00:07.0] nine ten",
		]);
	});

	test("csv export keeps the segment row", () => {
		const { csv } = exportsOf(entries);
		expect(csv.split("\r\n")).toEqual([
			"start,end,text",
			"0.000,2.000,one five",
			"2.000,5.000,six seven eight",
			"5.000,7.000,nine ten",
		]);
	});

	test("srt export keeps the cue and numbers it first", () => {
		const { srt } = exportsOf(entries);
		expect(srt).toContain("one five");
		expect(srt.split("\n")[0]).toBe("1");
		expect(srt).toContain("00:00:00,000 --> 00:00:02,000");
	});
});

describe("lineage view segments - fully removed and straddling removals", () => {
	test("a segment entirely inside a removal is dropped", () => {
		const { segments } = exportsOf([
			removalEntry({ start: ticks(5), end: ticks(8) }),
		]);
		expect(segments.map((s) => s.text)).toEqual([
			"one two three four five",
			"nine ten",
		]);
	});

	test("a removal spanning a segment boundary shrinks both sides", () => {
		// 4.25s..5.75s takes "five" (the tail of segment 1) and "six" (the head of
		// segment 2); 1.5s collapses out of the timeline.
		const { segments } = exportsOf([
			removalEntry({ start: ticks(4.25), end: ticks(5.75) }),
		]);
		expect(segments).toEqual([
			{ text: "one two three four", start: 0, end: 4 },
			{ text: "seven eight", start: 4.5, end: 6.5 },
			{ text: "nine ten", start: 6.5, end: 8.5 },
		]);
	});

	test("two removals in different segments both shrink their own segment", () => {
		const { segments } = exportsOf([
			removalEntry(
				{ start: ticks(1), end: ticks(3) },
				{ start: ticks(6), end: ticks(8) },
			),
		]);
		expect(segments).toEqual([
			{ text: "one four five", start: 0, end: 3 },
			{ text: "six", start: 3, end: 4 },
			{ text: "nine ten", start: 4, end: 6 },
		]);
	});

	test("an untouched capture exports every segment unchanged", () => {
		const { segments, txt } = exportsOf([]);
		expect(segments).toEqual(SEGMENTS);
		expect(txt.split("\n")).toHaveLength(3);
	});
});

describe("lineage view segments - words-unavailable capture", () => {
	const record = makeRecord({ words: [], wordsUnavailable: true });

	test("a partially cut segment keeps its surviving portion", () => {
		const { segments } = exportsOf(
			[removalEntry({ start: ticks(1), end: ticks(4) })],
			record,
		);
		// No words to fold, so the text stays whole and only the bounds shrink to the
		// part of the segment the journal left behind (0..1 plus 4..5 -> 0..2).
		expect(segments).toEqual([
			{ text: "one two three four five", start: 0, end: 2 },
			{ text: "six seven eight", start: 2, end: 5 },
			{ text: "nine ten", start: 5, end: 7 },
		]);
	});

	test("a segment entirely inside a removal is still dropped", () => {
		const { segments } = exportsOf(
			[removalEntry({ start: ticks(5), end: ticks(8) })],
			record,
		);
		expect(segments.map((s) => s.text)).toEqual([
			"one two three four five",
			"nine ten",
		]);
	});
});

describe("lineage view segments - delete then restore round trip", () => {
	test("restoring everything exports byte-identical to the untouched capture", () => {
		const before = exportsOf([]);
		const removal = { start: ticks(1), end: ticks(4) };
		const cut = exportsOf([removalEntry(removal)]);
		expect(cut.txt).not.toBe(before.txt);

		const restored = exportsOf([removalEntry(removal), restoreEntry(removal)]);
		expect(restored.segments).toEqual(before.segments);
		expect(restored.txt).toBe(before.txt);
		expect(restored.csv).toBe(before.csv);
		expect(restored.srt).toBe(before.srt);
	});

	test("a partial restore exports the words that came back", () => {
		const removal = { start: ticks(1), end: ticks(4) };
		const { segments } = exportsOf([
			removalEntry(removal),
			restoreEntry({ start: ticks(2), end: ticks(4) }),
		]);
		expect(segments[0]).toEqual({
			text: "one three four five",
			start: 0,
			end: 4,
		});
	});
});
