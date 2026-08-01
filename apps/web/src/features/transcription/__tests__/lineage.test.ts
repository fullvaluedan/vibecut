import { beforeEach, describe, expect, mock, test } from "bun:test";

// The manual-delete path imports `@/wasm` + RemoveRangesCommand at module top;
// stub both so it imports under bun (same pattern as
// delete-transcript-selection.test.ts). The fake command only carries its ranges -
// the FakeTimeline below is what actually mutates, so the audio hash moves exactly
// as it would in the editor.
mock.module("@/wasm", () => ({
	TICKS_PER_SECOND: 120_000,
	mediaTime: ({ ticks }: { ticks: number }) => ticks,
}));

class FakeRemoveRangesCommand {
	readonly ranges: { start: number; end: number }[];
	constructor(args: { ranges: { start: number; end: number }[] }) {
		this.ranges = args.ranges;
	}
	getRemovedCount(): number {
		return this.ranges.length;
	}
}
class FakeMoveElementCommand {
	constructor(readonly args: { moves: unknown[] }) {}
}
class FakeBatchCommand {
	constructor(readonly commands: unknown[]) {}
}
class FakeConsolidateAdjacentClipsCommand {}

mock.module("@/commands/timeline/track/remove-ranges", () => ({
	RemoveRangesCommand: FakeRemoveRangesCommand,
}));
mock.module("@/commands/timeline/element/move-elements", () => ({
	MoveElementCommand: FakeMoveElementCommand,
}));
mock.module("@/commands/timeline/track/consolidate-adjacent-clips", () => ({
	ConsolidateAdjacentClipsCommand: FakeConsolidateAdjacentClipsCommand,
}));
mock.module("@/commands/batch-command", () => ({ BatchCommand: FakeBatchCommand }));

const {
	beginLineageRemoval,
	getLineageFastPathTranscript,
	mergeSourceRanges,
	planSeamRestore,
	readTranscriptLineage,
	resetTranscriptLineage,
	safeLineageHash,
} = await import("../lineage");
const {
	appendJournalEntry,
	readLineageRecord,
	resetLineageStorageForTests,
	resolveActiveJournal,
	writeLineageRecord,
} = await import("../lineage-store");
const { TRANSCRIPT_LINEAGE_VERSION } = await import("../lineage-types");
const { computeAudioHash } = await import("../audio-hash");
const { deleteTranscriptSelection } = await import("../delete-transcript-selection");
const { remapTranscriptTimestamps } = await import("../remap-transcript-timestamps");
const { applyDirectorPlan } = await import(
	"@/features/ai-generate/director/apply-plan"
);

import type { TranscriptLineageRecord } from "../lineage-types";

const TPS = 120_000;
const sec = (n: number): number => Math.round(n * TPS);

interface FakeElement {
	id: string;
	type: string;
	mediaId: string;
	startTime: number;
	duration: number;
	trimStart: number;
	trimEnd: number;
}

/**
 * A one-track timeline that ripples exactly like RemoveRangesCommand (split the
 * straddler, slide the rest left) so the audio hash moves the way the editor's
 * would, plus an undo stack of whole-track snapshots.
 */
class FakeTimeline {
	elements: FakeElement[];
	private history: FakeElement[][] = [];
	private redoStack: FakeElement[][] = [];
	private nextId = 100;

	constructor(durationSec: number) {
		this.elements = [
			{
				id: "e0",
				type: "video",
				mediaId: "m1",
				startTime: 0,
				duration: sec(durationSec),
				trimStart: 0,
				trimEnd: 0,
			},
		];
	}

	removeRanges(ranges: readonly { start: number; end: number }[]): void {
		this.history.push(this.elements);
		this.redoStack = [];
		let next = this.elements;
		for (const range of [...ranges].sort((a, b) => b.start - a.start)) {
			next = next.flatMap((el) => this.cut(el, range));
		}
		this.elements = next;
	}

	/** A non-removal edit: trim the head of the first clip in place (no ripple). */
	trimHead(ticks: number): void {
		this.history.push(this.elements);
		this.redoStack = [];
		this.elements = this.elements.map((el, i) =>
			i === 0
				? {
						...el,
						trimStart: el.trimStart + ticks,
						duration: el.duration - ticks,
					}
				: el,
		);
	}

	undo(): void {
		const prev = this.history.pop();
		if (!prev) return;
		this.redoStack.push(this.elements);
		this.elements = prev;
	}

	redo(): void {
		const next = this.redoStack.pop();
		if (!next) return;
		this.history.push(this.elements);
		this.elements = next;
	}

	private cut(
		el: FakeElement,
		range: { start: number; end: number },
	): FakeElement[] {
		const start = el.startTime;
		const end = el.startTime + el.duration;
		const cutLen = range.end - range.start;
		if (end <= range.start) return [el];
		if (start >= range.end) return [{ ...el, startTime: start - cutLen }];
		if (start >= range.start && end <= range.end) return [];
		const pieces: FakeElement[] = [];
		if (start < range.start) {
			pieces.push({ ...el, duration: range.start - start });
		}
		if (end > range.end) {
			pieces.push({
				...el,
				id: start < range.start ? `e${this.nextId++}` : el.id,
				startTime: range.start,
				duration: end - range.end,
				trimStart: el.trimStart + (range.end - start),
			});
		}
		return pieces;
	}
}

/** The editor slice every hook under test reads, over a FakeTimeline. */
function makeEditor({
	projectId = "p1",
	durationSec = 20,
}: { projectId?: string; durationSec?: number } = {}) {
	const timeline = new FakeTimeline(durationSec);
	const editor = {
		timeline,
		project: { getActive: () => ({ metadata: { id: projectId } }) },
		scenes: {
			getActiveScene: () => ({
				tracks: {
					main: { id: "main", elements: timeline.elements },
					overlay: [] as { id: string; elements: FakeElement[] }[],
					audio: [] as { id: string; elements: FakeElement[] }[],
				},
			}),
		},
		command: {
			execute: ({ command }: { command: unknown }) => {
				const parts =
					command instanceof FakeBatchCommand ? command.commands : [command];
				const ranges = parts
					.filter(
						(c): c is FakeRemoveRangesCommand =>
							c instanceof FakeRemoveRangesCommand,
					)
					.flatMap((c) => c.ranges);
				if (ranges.length > 0) timeline.removeRanges(ranges);
			},
		},
	};
	return editor;
}

type FakeEditor = ReturnType<typeof makeEditor>;

const WORDS = [
	{ text: "one", start: 0, end: 1 },
	{ text: "two", start: 1, end: 2 },
	{ text: "three", start: 2, end: 3 },
	{ text: "four", start: 3, end: 4 },
	{ text: "five", start: 4, end: 5 },
];
const SEGMENTS = [
	{ text: "one two three", start: 0, end: 3 },
	{ text: "four five", start: 3, end: 5 },
];

function capture(editor: FakeEditor): void {
	resetTranscriptLineage({
		editor,
		words: WORDS,
		segments: SEGMENTS,
		sourceTotalSec: 20,
	});
}

beforeEach(() => {
	resetLineageStorageForTests();
});

describe("lineage - manual transcript delete round-trip", () => {
	test("a journaled delete explains the timeline and remaps the survivors", () => {
		const editor = makeEditor();
		capture(editor);

		// Delete words "two three" (1s..3s).
		const range = deleteTranscriptSelection({
			editor,
			selection: { startIndex: 1, endIndex: 2, granularity: "word" },
			words: WORDS,
			segments: SEGMENTS,
		});
		expect(range).toEqual({ startSec: 1, endSec: 3 });

		const view = readTranscriptLineage({ editor });
		expect(view.status).toBe("explained");
		expect(view.activeEntries).toHaveLength(1);
		expect(view.activeEntries[0].source).toBe("manual-transcript");
		expect(view.activeEntries[0].ranges).toEqual([{ start: sec(1), end: sec(3) }]);

		// Survivors, in CURRENT timeline coordinates.
		expect(view.words.map((w) => w.text)).toEqual(["one", "four", "five"]);

		// They must match what the panel's local preview remap produced before T16.1
		// (which kept the deleted words in place, struck through, and shifted only
		// what came after the cut).
		const legacySurvivors = remapTranscriptTimestamps({
			items: WORDS,
			deletedEndSec: 3,
			removedDurationSec: 2,
		}).filter((w) => w.text !== "two" && w.text !== "three");
		expect(view.words).toEqual(
			legacySurvivors.map((w) => ({ text: w.text, start: w.start, end: w.end })),
		);
	});

	test("the seam carries the removed words and its manual provenance", () => {
		const editor = makeEditor();
		capture(editor);
		deleteTranscriptSelection({
			editor,
			selection: { startIndex: 1, endIndex: 2, granularity: "word" },
			words: WORDS,
			segments: SEGMENTS,
		});

		const view = readTranscriptLineage({ editor });
		expect(view.seams).toHaveLength(1);
		const seam = view.seams[0];
		expect(seam.removedWords.map((w) => w.text)).toEqual(["two", "three"]);
		// The pipe sits immediately before "four", at 1s on the current timeline.
		expect(seam.afterWordIndex).toBe(1);
		expect(view.words[seam.afterWordIndex].text).toBe("four");
		expect(seam.atSec).toBeCloseTo(1, 6);
		expect(seam.removedSec).toBeCloseTo(2, 6);
		expect(seam.contributions).toHaveLength(1);
		expect(seam.contributions[0].source).toBe("manual-transcript");
		expect(seam.contributions[0].ops).toEqual([]);
	});

	test("two deletes compose: the second is journaled in SOURCE coordinates", () => {
		const editor = makeEditor();
		capture(editor);
		deleteTranscriptSelection({
			editor,
			selection: { startIndex: 1, endIndex: 1, granularity: "word" },
			words: WORDS,
			segments: SEGMENTS,
		});
		const afterFirst = readTranscriptLineage({ editor });
		expect(afterFirst.words.map((w) => w.text)).toEqual([
			"one",
			"three",
			"four",
			"five",
		]);

		// Delete "four" using the REMAPPED words the panel is now showing (3s..4s in
		// source is 2s..3s now).
		deleteTranscriptSelection({
			editor,
			selection: { startIndex: 2, endIndex: 2, granularity: "word" },
			words: afterFirst.words,
			segments: afterFirst.segments,
		});

		const record = readLineageRecord("p1");
		expect(record?.journal).toHaveLength(2);
		// Journaled back in SOURCE ticks, not the assembled 2s..3s it was clicked at.
		expect(record?.journal[1].ranges).toEqual([{ start: sec(3), end: sec(4) }]);

		const view = readTranscriptLineage({ editor });
		expect(view.words.map((w) => w.text)).toEqual(["one", "three", "five"]);
		expect(view.seams.map((s) => s.removedWords.map((w) => w.text))).toEqual([
			["two"],
			["four"],
		]);
	});
});

describe("lineage - Director apply", () => {
	test("seams carry the op category and reason", () => {
		const editor = makeEditor();
		capture(editor);

		applyDirectorPlan({
			editor,
			ops: [
				{
					id: "cut-1",
					op: "cut",
					startSec: 1,
					endSec: 2,
					category: "filler",
					reason: "Removed a filler word",
					confidence: 0.9,
				},
				{
					id: "cut-2",
					op: "cut",
					startSec: 3,
					endSec: 4,
					category: "repeat",
					reason: "Removed a repeated phrase",
					confidence: 0.8,
				},
			],
			words: WORDS,
		});

		const view = readTranscriptLineage({ editor });
		expect(view.status).toBe("explained");
		expect(view.words.map((w) => w.text)).toEqual(["one", "three", "five"]);
		expect(view.seams).toHaveLength(2);

		const [first, second] = view.seams;
		expect(first.removedWords.map((w) => w.text)).toEqual(["two"]);
		expect(first.contributions[0].source).toBe("director");
		expect(first.contributions[0].ops.map((o) => o.category)).toEqual(["filler"]);
		expect(first.contributions[0].ops[0].reason).toBe("Removed a filler word");

		expect(second.removedWords.map((w) => w.text)).toEqual(["four"]);
		expect(second.contributions[0].ops.map((o) => o.id)).toEqual(["cut-2"]);
		expect(second.contributions[0].ops[0].reason).toBe(
			"Removed a repeated phrase",
		);
	});

	test("an apply with no lineage stored is a silent no-op", () => {
		const editor = makeEditor();
		const result = applyDirectorPlan({
			editor,
			ops: [
				{
					id: "cut-1",
					op: "cut",
					startSec: 1,
					endSec: 2,
					reason: "x",
					confidence: 1,
				},
			],
			words: WORDS,
		});
		expect(result.cuts).toBe(1);
		expect(readLineageRecord("p1")).toBeNull();
		expect(readTranscriptLineage({ editor }).status).toBe("missing");
	});
});

describe("lineage - undo reconciliation", () => {
	test("undo drops the seam, redo brings it back, with no eager bookkeeping", () => {
		const editor = makeEditor();
		capture(editor);
		deleteTranscriptSelection({
			editor,
			selection: { startIndex: 1, endIndex: 2, granularity: "word" },
			words: WORDS,
			segments: SEGMENTS,
		});
		expect(readTranscriptLineage({ editor }).seams).toHaveLength(1);

		editor.timeline.undo();
		const afterUndo = readTranscriptLineage({ editor });
		expect(afterUndo.status).toBe("explained");
		expect(afterUndo.seams).toHaveLength(0);
		expect(afterUndo.words.map((w) => w.text)).toEqual(WORDS.map((w) => w.text));
		// The journal itself is untouched: reconciliation is a read-time hash match.
		expect(readLineageRecord("p1")?.journal).toHaveLength(1);

		editor.timeline.redo();
		expect(readTranscriptLineage({ editor }).seams).toHaveLength(1);
	});

	test("undo then a different delete truncates the stale entry", () => {
		const editor = makeEditor();
		capture(editor);
		deleteTranscriptSelection({
			editor,
			selection: { startIndex: 1, endIndex: 1, granularity: "word" },
			words: WORDS,
			segments: SEGMENTS,
		});
		editor.timeline.undo();

		deleteTranscriptSelection({
			editor,
			selection: { startIndex: 4, endIndex: 4, granularity: "word" },
			words: WORDS,
			segments: SEGMENTS,
		});

		const record = readLineageRecord("p1");
		expect(record?.journal).toHaveLength(1);
		expect(record?.journal[0].ranges).toEqual([{ start: sec(4), end: sec(5) }]);
		const view = readTranscriptLineage({ editor });
		expect(view.words.map((w) => w.text)).toEqual([
			"one",
			"two",
			"three",
			"four",
		]);
	});
});

describe("lineage - cannot explain", () => {
	test("a trim edit is not explainable and the fast path refuses", () => {
		const editor = makeEditor();
		capture(editor);
		editor.timeline.trimHead(sec(0.5));

		const view = readTranscriptLineage({ editor });
		expect(view.status).toBe("cannot-explain");
		expect(view.words).toEqual([]);
		expect(view.seams).toEqual([]);
		expect(getLineageFastPathTranscript({ editor })).toBeNull();

		// The real re-transcription then resets the lineage to the fresh capture.
		resetTranscriptLineage({
			editor,
			words: [{ text: "fresh", start: 0, end: 1 }],
			segments: [{ text: "fresh", start: 0, end: 1 }],
			sourceTotalSec: 19.5,
		});
		const reset = readTranscriptLineage({ editor });
		expect(reset.status).toBe("explained");
		expect(reset.words.map((w) => w.text)).toEqual(["fresh"]);
		expect(readLineageRecord("p1")?.journal).toEqual([]);
	});

	test("a removal made against an unexplainable timeline is not journaled", () => {
		const editor = makeEditor();
		capture(editor);
		editor.timeline.trimHead(sec(0.5));
		deleteTranscriptSelection({
			editor,
			selection: { startIndex: 0, endIndex: 0, granularity: "word" },
			words: WORDS,
			segments: SEGMENTS,
		});
		expect(readLineageRecord("p1")?.journal).toEqual([]);
	});
});

describe("lineage - fast-path refresh", () => {
	test("an explained timeline serves the remapped transcript without transcribing", () => {
		const editor = makeEditor();
		capture(editor);
		deleteTranscriptSelection({
			editor,
			selection: { startIndex: 1, endIndex: 2, granularity: "word" },
			words: WORDS,
			segments: SEGMENTS,
		});

		const fast = getLineageFastPathTranscript({ editor, wantWords: true });
		expect(fast).not.toBeNull();
		expect(fast?.words?.map((w) => w.text)).toEqual(["one", "four", "five"]);
		// The whole first segment's midpoint (1.5s) fell inside the cut, so it goes.
		expect(fast?.segments.map((s) => s.text)).toEqual(["four five"]);
	});

	test("a word-level request refuses a words-less capture", () => {
		const editor = makeEditor();
		resetTranscriptLineage({
			editor,
			words: [],
			segments: SEGMENTS,
			sourceTotalSec: 20,
		});
		expect(getLineageFastPathTranscript({ editor, wantWords: true })).toBeNull();
		expect(getLineageFastPathTranscript({ editor })).not.toBeNull();
	});

	test("a words-unavailable capture still satisfies a word-level request", () => {
		const editor = makeEditor();
		resetTranscriptLineage({
			editor,
			words: [],
			segments: SEGMENTS,
			sourceTotalSec: 20,
			wordsUnavailable: true,
		});
		const fast = getLineageFastPathTranscript({ editor, wantWords: true });
		expect(fast?.wordsUnavailable).toBe(true);
		expect(fast?.words).toBeUndefined();
	});
});

describe("lineage - restore range math", () => {
	function seamOf(editor: FakeEditor) {
		const view = readTranscriptLineage({ editor });
		expect(view.seams).toHaveLength(1);
		return view.seams[0];
	}

	test("restoring the whole seam returns the exact removal span", () => {
		const editor = makeEditor();
		capture(editor);
		deleteTranscriptSelection({
			editor,
			selection: { startIndex: 1, endIndex: 3, granularity: "word" },
			words: WORDS,
			segments: SEGMENTS,
		});
		const seam = seamOf(editor);
		const plan = planSeamRestore({ seam });
		expect(plan?.sourceRanges).toEqual([
			{ start: sec(1), end: sec(4), insertAtTicks: sec(1) },
		]);
		expect(plan?.restoredSec).toBeCloseTo(3, 6);
		expect(plan?.remainingRanges).toEqual([]);
		expect(plan?.remainingWords).toEqual([]);
		expect(plan?.insertAtTicks).toBe(sec(1));
	});

	test("restoring the leading subset leaves the trailing remainder", () => {
		const editor = makeEditor();
		capture(editor);
		deleteTranscriptSelection({
			editor,
			selection: { startIndex: 1, endIndex: 3, granularity: "word" },
			words: WORDS,
			segments: SEGMENTS,
		});
		const seam = seamOf(editor);
		// Restore "two three" only (indices 0..1 of the seam's removed words).
		const plan = planSeamRestore({ seam, wordStartIndex: 0, wordEndIndex: 1 });
		expect(plan?.sourceRanges).toEqual([
			{ start: sec(1), end: sec(3), insertAtTicks: sec(1) },
		]);
		expect(plan?.restoredWords.map((w) => w.text)).toEqual(["two", "three"]);
		expect(plan?.remainingRanges).toEqual([{ start: sec(3), end: sec(4) }]);
		expect(plan?.remainingWords.map((w) => w.text)).toEqual(["four"]);
	});

	test("an interior subset is word-tight and splits the remainder in two", () => {
		const editor = makeEditor();
		capture(editor);
		deleteTranscriptSelection({
			editor,
			selection: { startIndex: 1, endIndex: 3, granularity: "word" },
			words: WORDS,
			segments: SEGMENTS,
		});
		const seam = seamOf(editor);
		const plan = planSeamRestore({ seam, wordStartIndex: 1, wordEndIndex: 1 });
		expect(plan?.sourceRanges).toEqual([
			{ start: sec(2), end: sec(3), insertAtTicks: sec(1) },
		]);
		expect(plan?.remainingRanges).toEqual([
			{ start: sec(1), end: sec(2) },
			{ start: sec(3), end: sec(4) },
		]);
		expect(plan?.remainingWords.map((w) => w.text)).toEqual(["two", "four"]);
	});

	test("an empty selection returns null", () => {
		const editor = makeEditor();
		capture(editor);
		deleteTranscriptSelection({
			editor,
			selection: { startIndex: 1, endIndex: 1, granularity: "word" },
			words: WORDS,
			segments: SEGMENTS,
		});
		const seam = seamOf(editor);
		expect(
			planSeamRestore({ seam, wordStartIndex: 2, wordEndIndex: 1 }),
		).toBeNull();
	});
});

describe("lineage-store - persistence, versioning, LRU", () => {
	function makeRecord(projectId: string, updatedAt: number): TranscriptLineageRecord {
		return {
			version: TRANSCRIPT_LINEAGE_VERSION,
			projectId,
			captureHash: `h-${projectId}`,
			words: [],
			segments: [],
			sourceTotalSec: 1,
			journal: [],
			createdAt: updatedAt,
			updatedAt,
		};
	}

	test("keeps at most six projects, evicting the least recently updated", () => {
		for (let i = 0; i < 8; i++) {
			writeLineageRecord(makeRecord(`p${i}`, 1000 + i));
		}
		expect(readLineageRecord("p0")).toBeNull();
		expect(readLineageRecord("p1")).toBeNull();
		expect(readLineageRecord("p2")).not.toBeNull();
		expect(readLineageRecord("p7")).not.toBeNull();
	});

	test("a record on an older version is discarded, not mis-read", () => {
		const stale = { ...makeRecord("p1", 1), version: TRANSCRIPT_LINEAGE_VERSION - 1 };
		writeLineageRecord(stale as TranscriptLineageRecord);
		expect(readLineageRecord("p1")).toBeNull();
	});

	test("resolveActiveJournal matches the longest hash prefix", () => {
		const record: TranscriptLineageRecord = {
			...makeRecord("p1", 1),
			captureHash: "h0",
			journal: [
				{
					id: "a",
					source: "manual-transcript",
					ranges: [{ start: 0, end: 1 }],
					at: 1,
					hashBefore: "h0",
					hashAfter: "h1",
				},
				{
					id: "b",
					source: "director",
					ranges: [{ start: 2, end: 3 }],
					at: 2,
					hashBefore: "h1",
					hashAfter: "h2",
				},
			],
		};
		expect(resolveActiveJournal({ record, liveHash: "h0" })).toEqual({
			entries: [],
			explained: true,
		});
		expect(
			resolveActiveJournal({ record, liveHash: "h1" }).entries.map((e) => e.id),
		).toEqual(["a"]);
		expect(
			resolveActiveJournal({ record, liveHash: "h2" }).entries.map((e) => e.id),
		).toEqual(["a", "b"]);
		expect(resolveActiveJournal({ record, liveHash: "hX" }).explained).toBe(false);
	});

	test("appendJournalEntry truncates to the prefix its hashBefore identifies", () => {
		const record: TranscriptLineageRecord = {
			...makeRecord("p1", 1),
			captureHash: "h0",
			journal: [
				{
					id: "a",
					source: "manual-transcript",
					ranges: [{ start: 0, end: 1 }],
					at: 1,
					hashBefore: "h0",
					hashAfter: "h1",
				},
				{
					id: "b",
					source: "director",
					ranges: [{ start: 2, end: 3 }],
					at: 2,
					hashBefore: "h1",
					hashAfter: "h2",
				},
			],
		};
		const updated = appendJournalEntry({
			record,
			entry: {
				id: "c",
				source: "manual-transcript",
				ranges: [{ start: 4, end: 5 }],
				at: 3,
				hashBefore: "h1",
				hashAfter: "h3",
			},
		});
		expect(updated?.journal.map((e) => e.id)).toEqual(["a", "c"]);
		expect(
			appendJournalEntry({
				record,
				entry: {
					id: "d",
					source: "other",
					ranges: [{ start: 6, end: 7 }],
					at: 4,
					hashBefore: "nope",
					hashAfter: "h4",
				},
			}),
		).toBeNull();
	});
});

describe("lineage - helpers", () => {
	test("mergeSourceRanges unions overlapping and touching ranges", () => {
		expect(
			mergeSourceRanges([
				{ start: 30, end: 40 },
				{ start: 0, end: 10 },
				{ start: 10, end: 20 },
				{ start: 15, end: 18 },
				{ start: 40, end: 40 },
			]),
		).toEqual([
			{ start: 0, end: 20 },
			{ start: 30, end: 40 },
		]);
	});

	test("safeLineageHash matches computeAudioHash for the same tracks", () => {
		const editor = makeEditor();
		expect(safeLineageHash(editor)).toBe(
			computeAudioHash({ tracks: editor.scenes.getActiveScene().tracks }),
		);
	});

	test("beginLineageRemoval is a no-op without a stored lineage", () => {
		const editor = makeEditor();
		expect(
			beginLineageRemoval({
				editor,
				source: "other",
				rangesTicks: [{ start: sec(1), end: sec(2) }],
			}),
		).toBeNull();
	});
});
