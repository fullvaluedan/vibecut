import { beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * T18.4 polish. `getExportableTranscript` (transcript-cache.ts) is the export
 * path's read helper: hash-matched cache first, else the lineage view's segments
 * when the journal explains every edit since the last real transcription, else
 * null. Without it, ANY edit after a transcription (a cut, a Director apply)
 * moved the cache hash and the export popover's "Also export captions (.srt)"
 * checkbox silently disappeared - even though the lineage (T16.1) already had the
 * correctly remapped post-edit segments, as `lineage-export-segments.test.ts`
 * proved for the panel's own export path.
 *
 * `@/wasm` is left real (it's a thin wrapper over the `opencut-wasm` package,
 * already mocked repo-wide in `test-preload.ts`) because `transcript-cache.ts`
 * pulls in other modules (media/audio, transcription/analysis-model, ...) that
 * need its full export surface - unlike `lineage.test.ts` and
 * `delete-transcript-selection.test.ts`, which stub `@/wasm` down to just
 * `TICKS_PER_SECOND` but never import `transcript-cache.ts` itself. Only
 * `RemoveRangesCommand` is stubbed here - the lineage-explained case is driven
 * through the real `deleteTranscriptSelection`, not a hand-built journal, so the
 * journal's ranges and the survivors below are the product's own remap, not a
 * test assumption.
 */

class FakeRemoveRangesCommand {
	readonly ranges: { start: number; end: number }[];
	constructor(args: { ranges: { start: number; end: number }[] }) {
		this.ranges = args.ranges;
	}
	getRemovedCount(): number {
		return this.ranges.length;
	}
}
mock.module("@/commands/timeline/track/remove-ranges", () => ({
	RemoveRangesCommand: FakeRemoveRangesCommand,
}));

const { getCachedTranscript, getExportableTranscript, computeTimelineAudioHash } =
	await import("../transcript-cache");
const { resetTranscriptLineage, readTranscriptLineage } = await import("../lineage");
const { resetLineageStorageForTests } = await import("../lineage-store");
const { deleteTranscriptSelection } = await import("../delete-transcript-selection");

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

/** A one-track timeline that ripples exactly like RemoveRangesCommand (split the
 * straddler, slide the rest left), so the audio hash moves the way the editor's
 * would - the same shape `lineage.test.ts` uses. */
class FakeTimeline {
	elements: FakeElement[];

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
		let next = this.elements;
		for (const range of [...ranges].sort((a, b) => b.start - a.start)) {
			next = next.flatMap((el) => this.cut(el, range));
		}
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
				startTime: range.start,
				duration: end - range.end,
				trimStart: el.trimStart + (range.end - start),
			});
		}
		return pieces;
	}
}

function makeEditor({
	projectId = "p1",
	durationSec = 20,
}: { projectId?: string; durationSec?: number } = {}) {
	const timeline = new FakeTimeline(durationSec);
	return {
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
				if (command instanceof FakeRemoveRangesCommand) {
					timeline.removeRanges(command.ranges);
				}
			},
		},
	};
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

/** transcript-cache.ts's own cache is real localStorage (no probe/fallback), and
 * lineage-store.ts falls back to an in-memory map only when localStorage throws.
 * bun's test runtime has no `localStorage` at all, so a plain in-memory shim
 * makes BOTH paths round-trip realistically under bun test - and, since it's one
 * shared shim, a single `clear()` isolates every test from the last. */
class MemoryStorage {
	private map = new Map<string, string>();
	getItem(key: string): string | null {
		return this.map.get(key) ?? null;
	}
	setItem(key: string, value: string): void {
		this.map.set(key, value);
	}
	clear(): void {
		this.map.clear();
	}
}
const memoryStorage = new MemoryStorage();
(globalThis as { localStorage?: unknown }).localStorage = memoryStorage;

beforeEach(() => {
	memoryStorage.clear();
	resetLineageStorageForTests();
});

describe("getExportableTranscript", () => {
	test("branch 1: a hash-matched cache entry wins outright", () => {
		const editor = makeEditor();
		const hash = computeTimelineAudioHash(editor as never);
		memoryStorage.setItem(
			"vibecut-transcript-cache",
			JSON.stringify({
				p1: {
					hash,
					segments: [{ start: 0, end: 1, text: "cached" }],
					createdAt: Date.now(),
				},
			}),
		);
		expect(getExportableTranscript(editor as never)).toEqual([
			{ start: 0, end: 1, text: "cached" },
		]);
	});

	test("branch 2: no cache hit, but an explained lineage after a journaled removal serves its segments", () => {
		const editor = makeEditor();
		capture(editor);

		// Delete words "two three" (1s..3s) - the middle of segment 1 ("one two
		// three"), leaving "one" as its surviving word. This is the exact shape
		// the mission calls out: a partially-cut segment keeps surviving words.
		const range = deleteTranscriptSelection({
			editor,
			selection: { startIndex: 1, endIndex: 2, granularity: "word" },
			words: WORDS,
			segments: SEGMENTS,
		});
		expect(range).toEqual({ startSec: 1, endSec: 3 });

		// The hash moved (the delete rippled the timeline), so the hash-gated
		// cache path is a miss - this is exactly the bug T18.4 polish fixes.
		expect(getCachedTranscript(editor as never)).toBeNull();

		const view = readTranscriptLineage({ editor });
		expect(view.status).toBe("explained");

		const exportable = getExportableTranscript(editor as never);
		expect(exportable).toEqual(view.segments);
		// Segment 1 ("one two three") kept only its surviving word "one"; segment 2
		// ("four five") was untouched content-wise and just shifted left.
		expect(exportable).toEqual([
			{ text: "one", start: 0, end: 1 },
			{ text: "four five", start: 1, end: 3 },
		]);
	});

	test("branch 3: neither a cache hit nor an explained lineage returns null", () => {
		const editor = makeEditor({ projectId: "p-none" });
		expect(getCachedTranscript(editor as never)).toBeNull();
		expect(readTranscriptLineage({ editor }).status).toBe("missing");
		expect(getExportableTranscript(editor as never)).toBeNull();
	});

	test("branch 3b: a lineage the journal cannot explain (a non-removal edit) also returns null", () => {
		const editor = makeEditor();
		capture(editor);
		// Mutate the timeline WITHOUT going through the lineage-aware delete path -
		// a trim/move-shaped edit the journal never recorded. The live hash no
		// longer matches captureHash or any journal link.
		const tracks = editor.scenes.getActiveScene().tracks;
		(tracks.main.elements[0] as FakeElement).trimStart += sec(1);
		(tracks.main.elements[0] as FakeElement).duration -= sec(1);

		expect(readTranscriptLineage({ editor }).status).toBe("cannot-explain");
		expect(getCachedTranscript(editor as never)).toBeNull();
		expect(getExportableTranscript(editor as never)).toBeNull();
	});
});
