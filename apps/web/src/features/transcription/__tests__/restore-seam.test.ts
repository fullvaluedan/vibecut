import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { SceneTracks, TimelineElement } from "@/timeline";
import { buildEmptyTrack } from "@/timeline/placement/track-factory";
import { mediaTime, TICKS_PER_SECOND } from "@/wasm";
import type { Command } from "@/commands/base-command";

/**
 * The T16.2 restore, end to end over the REAL commands: a real
 * RemoveRangesCommand cuts, a real RestoreRangeCommand puts back, and the real
 * lineage journal reconciles in between. Only `@/core` is stubbed, so what is
 * under test is the actual timeline geometry and the actual hash-chain
 * bookkeeping rather than a model of them.
 */
let currentTracks: SceneTracks;
mock.module("@/core", () => ({
	EditorCore: {
		getInstance: () => ({
			scenes: {
				getActiveSceneOrNull: () => ({ tracks: currentTracks }),
				getActiveScene: () => ({ tracks: currentTracks }),
			},
			timeline: {
				updateTracks: (tracks: SceneTracks) => {
					currentTracks = tracks;
				},
			},
			selection: { getSnapshot: () => null },
		}),
	},
}));

/**
 * A local mirror of `RemoveRangesCommand`, registered as the module mock so the
 * delete path drives it. Sibling test files register their own fake for that
 * module and bun's mocks persist for the whole process, so importing the real
 * one here would be a coin flip; this fake reproduces `cutElement` exactly (left
 * remainder keeps id + trimEnd, right remainder gets a fresh id and a trimStart
 * advanced by the cut length, everything after slides left) and snapshots for
 * undo, which is all the restore has to invert.
 */
function cutElements({
	elements,
	start,
	end,
}: {
	elements: readonly TimelineElement[];
	start: number;
	end: number;
}): TimelineElement[] {
	const length = end - start;
	let minted = 0;
	return elements.flatMap((el) => {
		const from = el.startTime;
		const to = el.startTime + el.duration;
		if (to <= start) return [el];
		if (from >= end) {
			return [{ ...el, startTime: from - length } as TimelineElement];
		}
		if (from >= start && to <= end) return [];
		const pieces: TimelineElement[] = [];
		if (from < start) {
			pieces.push({ ...el, duration: start - from } as TimelineElement);
		}
		if (to > end) {
			pieces.push({
				...el,
				id: from < start ? `${el.id}-cut${++minted}` : el.id,
				startTime: start,
				duration: to - end,
				trimStart: el.trimStart + (end - from),
			} as TimelineElement);
		}
		return pieces;
	});
}

class FakeRemoveRangesCommand {
	private saved: SceneTracks | null = null;
	constructor(private readonly options: { ranges: { start: number; end: number }[] }) {}
	execute(): undefined {
		this.saved = currentTracks;
		let tracks = currentTracks;
		for (const range of [...this.options.ranges].sort((a, b) => b.start - a.start)) {
			const apply = <T extends { elements: TimelineElement[] }>(track: T): T => ({
				...track,
				elements: cutElements({
					elements: track.elements,
					start: range.start,
					end: range.end,
				}),
			});
			tracks = {
				...tracks,
				main: apply(tracks.main),
				overlay: tracks.overlay.map(apply),
				audio: tracks.audio.map(apply),
			};
		}
		currentTracks = tracks;
		return undefined;
	}
	undo(): void {
		if (this.saved) currentTracks = this.saved;
	}
	getRemovedCount(): number {
		return this.options.ranges.length;
	}
}

mock.module("@/commands/timeline/track/remove-ranges", () => ({
	RemoveRangesCommand: FakeRemoveRangesCommand,
}));

const { deleteTranscriptSelection } = await import(
	"../delete-transcript-selection"
);
const { readTranscriptLineage, resetTranscriptLineage } = await import(
	"../lineage"
);
const { readLineageRecord, resetLineageStorageForTests } = await import(
	"../lineage-store"
);
const { planToRestoreRanges, restoreSeamWords } = await import("../restore-seam");
const { planSeamRestore } = await import("../lineage");
const { describeSeam } = await import("../seam-window-model");

const S = (sec: number) =>
	mediaTime({ ticks: Math.round(sec * TICKS_PER_SECOND) });

function clip({
	id,
	type,
	linkId,
}: {
	id: string;
	type: "video" | "audio";
	linkId: string;
}): TimelineElement {
	return {
		id,
		type,
		name: id,
		mediaId: "m1",
		startTime: S(0),
		duration: S(20),
		trimStart: S(0),
		trimEnd: S(0),
		params: type === "audio" ? { volume: 1, muted: false } : {},
		...(type === "audio" ? { sourceType: "upload" } : {}),
		linkId,
	} as unknown as TimelineElement;
}

function fixture(): SceneTracks {
	const main = buildEmptyTrack({ id: "main", type: "video" });
	main.elements = [clip({ id: "v0", type: "video", linkId: "L1" })];
	const audio = buildEmptyTrack({ id: "a1", type: "audio" });
	audio.elements = [clip({ id: "a0", type: "audio", linkId: "L1" })];
	return { overlay: [], main, audio: [audio] };
}

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

/** An editor whose command sink drives the real commands plus an undo stack. */
function makeEditor() {
	const undoStack: Command[] = [];
	const redoStack: Command[] = [];
	return {
		project: { getActive: () => ({ metadata: { id: "p1" } }) },
		scenes: { getActiveScene: () => ({ tracks: currentTracks }) },
		command: {
			execute: ({ command }: { command: Command }) => {
				command.execute();
				undoStack.push(command);
				redoStack.length = 0;
			},
			undo: () => {
				const command = undoStack.pop();
				if (!command) return;
				command.undo();
				redoStack.push(command);
			},
			redo: () => {
				const command = redoStack.pop();
				if (!command) return;
				command.execute();
				undoStack.push(command);
			},
		},
	};
}

type FakeEditor = ReturnType<typeof makeEditor>;

const spans = (elements: readonly TimelineElement[]) =>
	elements.map((el) => [
		el.startTime / TICKS_PER_SECOND,
		el.duration / TICKS_PER_SECOND,
		el.trimStart / TICKS_PER_SECOND,
	]);

/** Capture the transcript, then delete "two three four" (1s..4s). */
function cutThreeWords(editor: FakeEditor) {
	resetTranscriptLineage({
		editor,
		words: WORDS,
		segments: SEGMENTS,
		sourceTotalSec: 20,
	});
	deleteTranscriptSelection({
		editor,
		selection: { startIndex: 1, endIndex: 3, granularity: "word" },
		words: WORDS,
		segments: SEGMENTS,
	});
}

function onlySeam(editor: FakeEditor) {
	const view = readTranscriptLineage({ editor });
	expect(view.status).toBe("explained");
	expect(view.seams).toHaveLength(1);
	return view.seams[0];
}

beforeEach(() => {
	resetLineageStorageForTests();
	currentTracks = fixture();
});

describe("planToRestoreRanges", () => {
	test("a one-span seam maps straight onto the seam's own insert point", () => {
		const editor = makeEditor();
		cutThreeWords(editor);
		const seam = onlySeam(editor);
		const plan = planSeamRestore({ seam, wordStartIndex: 0, wordEndIndex: 1 });
		expect(plan).not.toBeNull();
		expect(planToRestoreRanges({ plan: plan!, seam })).toEqual([
			{ insertAt: S(1), offset: 0, duration: S(2), removedTotal: S(3) },
		]);
	});

	test("a MULTI-span seam gives each span its own insert point (T16.1 note 5)", () => {
		// Two removals with a wordless survivor gap between them collapse into ONE
		// pipe: 10s..12s and 20s..22s, with 8s of surviving time in between.
		const seam = {
			id: "s1",
			atSec: 10,
			afterWordIndex: 1,
			removedWords: [
				{ text: "a", start: 10.5, end: 11 },
				{ text: "b", start: 20.5, end: 21 },
			],
			removedSpans: [
				{ startSec: 10, endSec: 12 },
				{ startSec: 20, endSec: 22 },
			],
			removedSec: 4,
			contributions: [],
		};
		const plan = planSeamRestore({ seam });
		expect(plan).not.toBeNull();
		expect(planToRestoreRanges({ plan: plan!, seam })).toEqual([
			{ insertAt: S(10), offset: 0, duration: S(2), removedTotal: S(2) },
			// The plan anchors every range at the seam; the second span actually
			// re-enters 8 surviving seconds later.
			{ insertAt: S(18), offset: 0, duration: S(2), removedTotal: S(2) },
		]);
	});
});

describe("restoreSeamWords - partial restore and journal reconciliation", () => {
	test("restoring two of three words re-opens their time and keeps the pipe", () => {
		const editor = makeEditor();
		cutThreeWords(editor);
		expect(spans(currentTracks.main.elements)).toEqual([
			[0, 1, 0],
			[1, 16, 4],
		]);

		const seam = onlySeam(editor);
		expect(seam.removedWords.map((w) => w.text)).toEqual([
			"two",
			"three",
			"four",
		]);

		const plan = restoreSeamWords({
			editor,
			seam,
			wordStartIndex: 0,
			wordEndIndex: 1,
		});
		expect(plan?.restoredWords.map((w) => w.text)).toEqual(["two", "three"]);

		// Two seconds came back, and downstream slid right by exactly that.
		expect(spans(currentTracks.main.elements)).toEqual([
			[0, 3, 0],
			[3, 16, 4],
		]);
		// Linked audio moved in lockstep: A/V sync is exact.
		expect(spans(currentTracks.audio[0].elements)).toEqual(
			spans(currentTracks.main.elements),
		);

		// The journal APPENDED the restore rather than rewriting the removal.
		const record = readLineageRecord("p1");
		expect(record?.journal).toHaveLength(2);
		expect(record?.journal[0].ranges).toEqual([{ start: S(1), end: S(4) }]);
		expect(record?.journal[1].ranges).toEqual([]);
		expect(record?.journal[1].restores).toEqual([{ start: S(1), end: S(3) }]);

		// The next read reports exactly `remainingRanges`: the pipe stays, now
		// holding only the word that is still cut.
		const after = readTranscriptLineage({ editor });
		expect(after.words.map((w) => w.text)).toEqual([
			"one",
			"two",
			"three",
			"five",
		]);
		expect(after.seams).toHaveLength(1);
		expect(after.seams[0].removedWords.map((w) => w.text)).toEqual(["four"]);
		expect(after.seams[0].afterWordIndex).toBe(3);
	});

	test("restoring the rest clears the pipe and returns the original timeline", () => {
		const editor = makeEditor();
		const original = currentTracks;
		cutThreeWords(editor);
		restoreSeamWords({
			editor,
			seam: onlySeam(editor),
			wordStartIndex: 0,
			wordEndIndex: 1,
		});
		restoreSeamWords({ editor, seam: onlySeam(editor) });

		const after = readTranscriptLineage({ editor });
		expect(after.seams).toEqual([]);
		expect(after.words.map((w) => w.text)).toEqual(WORDS.map((w) => w.text));
		// Byte-for-byte the pre-cut timeline, ids and link ids included.
		expect(currentTracks).toEqual(original);
	});

	test("undo puts the whole cut back; redo re-applies the restore", () => {
		const editor = makeEditor();
		cutThreeWords(editor);
		restoreSeamWords({
			editor,
			seam: onlySeam(editor),
			wordStartIndex: 0,
			wordEndIndex: 1,
		});
		expect(onlySeam(editor).removedWords).toHaveLength(1);

		editor.command.undo();
		// The hash reverts to the removal entry's link, so the later restore entry
		// stops being reported - no eager bookkeeping anywhere.
		const undone = readTranscriptLineage({ editor });
		expect(undone.status).toBe("explained");
		expect(undone.seams[0].removedWords.map((w) => w.text)).toEqual([
			"two",
			"three",
			"four",
		]);
		expect(spans(currentTracks.main.elements)).toEqual([
			[0, 1, 0],
			[1, 16, 4],
		]);

		editor.command.redo();
		expect(onlySeam(editor).removedWords.map((w) => w.text)).toEqual(["four"]);
	});

	test("deleting again after a restore removes the words a second time", () => {
		const editor = makeEditor();
		cutThreeWords(editor);
		restoreSeamWords({ editor, seam: onlySeam(editor) });
		const view = readTranscriptLineage({ editor });
		expect(view.seams).toEqual([]);

		deleteTranscriptSelection({
			editor,
			selection: { startIndex: 1, endIndex: 1, granularity: "word" },
			words: view.words,
			segments: view.segments,
		});
		// The ordered fold (add ranges, subtract restores, entry by entry) is what
		// keeps this from cancelling itself out against the first removal.
		const again = readTranscriptLineage({ editor });
		expect(again.words.map((w) => w.text)).toEqual([
			"one",
			"three",
			"four",
			"five",
		]);
		expect(again.seams[0].removedWords.map((w) => w.text)).toEqual(["two"]);
	});

	test("an empty selection restores nothing and executes no command", () => {
		const editor = makeEditor();
		cutThreeWords(editor);
		const before = currentTracks;
		expect(
			restoreSeamWords({
				editor,
				seam: onlySeam(editor),
				wordStartIndex: 2,
				wordEndIndex: 1,
			}),
		).toBeNull();
		expect(currentTracks).toBe(before);
		expect(readLineageRecord("p1")?.journal).toHaveLength(1);
	});
});

describe("describeSeam - what the window shows", () => {
	test("a manual delete names itself and carries the source timecodes", () => {
		const editor = makeEditor();
		cutThreeWords(editor);
		const model = describeSeam({ seam: onlySeam(editor) });
		expect(model.words).toEqual(["two", "three", "four"]);
		expect(model.spans).toEqual(["00:01.0 - 00:04.0"]);
		expect(model.provenance).toEqual([
			{ label: "Manual delete", timecode: "00:01.0 - 00:04.0" },
		]);
		expect(model.removedLabel).toBe("3.0s removed");
	});

	test("a Director cut shows its category and reason per op", () => {
		const model = describeSeam({
			seam: {
				id: "s1",
				atSec: 1,
				afterWordIndex: 1,
				removedWords: [{ text: "um", start: 1, end: 2 }],
				removedSpans: [{ startSec: 1, endSec: 2 }],
				removedSec: 1,
				contributions: [
					{
						entryId: "e1",
						source: "director",
						at: 0,
						ops: [
							{
								id: "cut-1",
								category: "filler",
								reason: "Removed a filler word",
								start: S(1),
								end: S(2),
							},
						],
					},
				],
			},
		});
		expect(model.provenance).toEqual([
			{
				label: "AI Director - filler",
				detail: "Removed a filler word",
				timecode: "00:01.0 - 00:02.0",
			},
		]);
	});
});
