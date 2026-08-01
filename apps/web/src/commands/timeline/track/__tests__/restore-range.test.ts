import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { SceneTracks, TimelineElement } from "@/timeline";
import { buildEmptyTrack } from "@/timeline/placement/track-factory";
import { mediaTime, TICKS_PER_SECOND } from "@/wasm";

// A minimal EditorCore stand-in, matching add-track.test.ts: both commands only
// read the active scene's tracks and write updated tracks back. `selection` is
// present because both declare a reconciled selection in their CommandResult.
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

const { RestoreRangeCommand } = await import(
	"@/commands/timeline/track/restore-range"
);

const S = (sec: number) =>
	mediaTime({ ticks: Math.round(sec * TICKS_PER_SECOND) });

function clip({
	id,
	type,
	mediaId = "m1",
	startSec,
	durationSec,
	trimStartSec = 0,
	linkId,
}: {
	id: string;
	type: "video" | "audio";
	mediaId?: string;
	startSec: number;
	durationSec: number;
	trimStartSec?: number;
	linkId?: string;
}): TimelineElement {
	return {
		id,
		type,
		name: id,
		mediaId,
		startTime: S(startSec),
		duration: S(durationSec),
		trimStart: S(trimStartSec),
		trimEnd: S(0),
		params: type === "audio" ? { volume: 1, muted: false } : {},
		...(type === "audio" ? { sourceType: "upload" } : {}),
		...(linkId ? { linkId } : {}),
	} as unknown as TimelineElement;
}

/** One 20s video on main with its separated audio on A1, linked. */
function linkedFixture(): SceneTracks {
	const main = buildEmptyTrack({ id: "main", type: "video" });
	main.elements = [
		clip({
			id: "v0",
			type: "video",
			startSec: 0,
			durationSec: 20,
			linkId: "L1",
		}),
	];
	const audio = buildEmptyTrack({ id: "a1", type: "audio" });
	audio.elements = [
		clip({
			id: "a0",
			type: "audio",
			startSec: 0,
			durationSec: 20,
			linkId: "L1",
		}),
	];
	return { overlay: [], main, audio: [audio] };
}

/**
 * A local mirror of `RemoveRangesCommand.cutElement`: the left remainder keeps
 * the element's id (and its trimEnd), the right remainder gets a fresh id and a
 * trimStart advanced by the cut length, and everything after the cut slides
 * left. Written out here rather than calling the real command because several
 * sibling test files register a global `mock.module` fake for it and bun's
 * module mocks persist for the whole process - the geometry this restore has to
 * invert is what matters, and it is pinned right here.
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

function cut({ fromSec, toSec }: { fromSec: number; toSec: number }): void {
	const start = S(fromSec);
	const end = S(toSec);
	const apply = <T extends { elements: TimelineElement[] }>(track: T): T => ({
		...track,
		elements: cutElements({ elements: track.elements, start, end }),
	});
	currentTracks = {
		...currentTracks,
		main: apply(currentTracks.main),
		overlay: currentTracks.overlay.map(apply),
		audio: currentTracks.audio.map(apply),
	};
}

const restore = ({
	atSec,
	offsetSec,
	durationSec,
	removedSec,
}: {
	atSec: number;
	offsetSec: number;
	durationSec: number;
	removedSec: number;
}) =>
	new RestoreRangeCommand({
		ranges: [
			{
				insertAt: S(atSec),
				offset: S(offsetSec),
				duration: S(durationSec),
				removedTotal: S(removedSec),
			},
		],
	});

/** Every element's span, per track, for the geometry assertions. */
const spans = (elements: readonly TimelineElement[]) =>
	elements.map((el) => [
		el.startTime / TICKS_PER_SECOND,
		el.duration / TICKS_PER_SECOND,
		el.trimStart / TICKS_PER_SECOND,
	]);

beforeEach(() => {
	currentTracks = linkedFixture();
});

describe("RestoreRangeCommand round trip", () => {
	test("restoring the whole cut returns the timeline byte-for-byte", () => {
		const original = currentTracks;
		cut({ fromSec: 5, toSec: 8 });
		const afterCut = currentTracks;
		expect(afterCut.main.elements).toHaveLength(2);

		const command = restore({
			atSec: 5,
			offsetSec: 0,
			durationSec: 3,
			removedSec: 3,
		});
		command.execute();

		// Not just the same spans: the same ids, the same link ids, the same
		// element objects field for field as before the cut ever happened.
		expect(currentTracks).toEqual(original);
		expect(command.getRestoredTicks()).toBe(S(3));
	});

	test("undo returns the cut timeline, and re-executing restores again", () => {
		cut({ fromSec: 5, toSec: 8 });
		const afterCut = currentTracks;
		const command = restore({
			atSec: 5,
			offsetSec: 0,
			durationSec: 3,
			removedSec: 3,
		});
		command.execute();
		const afterRestore = currentTracks;

		command.undo();
		expect(currentTracks).toEqual(afterCut);

		command.execute();
		expect(currentTracks).toEqual(afterRestore);
	});
});

describe("RestoreRangeCommand partial restore", () => {
	test("an interior slice re-opens only its own time and keeps source alignment", () => {
		cut({ fromSec: 5, toSec: 8 });
		// Put back the middle second of the three that were cut.
		restore({ atSec: 5, offsetSec: 1, durationSec: 1, removedSec: 3 }).execute();

		expect(spans(currentTracks.main.elements)).toEqual([
			[0, 5, 0],
			// The filler shows source 6s..7s - exactly the slice asked for.
			[5, 1, 6],
			// Downstream slid right by the restored second, source untouched.
			[6, 12, 8],
		]);
	});

	test("linked audio restores in lockstep, keeping A/V sync exact", () => {
		cut({ fromSec: 5, toSec: 8 });
		restore({ atSec: 5, offsetSec: 1, durationSec: 1, removedSec: 3 }).execute();

		expect(spans(currentTracks.audio[0].elements)).toEqual(
			spans(currentTracks.main.elements),
		);
		// The two standalone fillers are ganged with EACH OTHER on a fresh link id,
		// never on the donors' (three clips on one id makes pairing ambiguous).
		const videoFiller = currentTracks.main.elements[1];
		const audioFiller = currentTracks.audio[0].elements[1];
		expect(videoFiller.linkId).toBe(audioFiller.linkId as string);
		expect(videoFiller.linkId).not.toBe("L1");
		expect(currentTracks.main.elements[0].linkId).toBe("L1");
	});

	test("restoring the leading slice merges back into the clip before the cut", () => {
		cut({ fromSec: 5, toSec: 8 });
		restore({ atSec: 5, offsetSec: 0, durationSec: 1, removedSec: 3 }).execute();

		// Source-contiguous with the left clip, so it is absorbed rather than left
		// as a third fragment.
		expect(spans(currentTracks.main.elements)).toEqual([
			[0, 6, 0],
			[6, 12, 8],
		]);
		expect(currentTracks.main.elements[0].id).toBe("v0");
	});

	test("restoring the trailing slice merges back into the clip after the cut", () => {
		cut({ fromSec: 5, toSec: 8 });
		restore({ atSec: 5, offsetSec: 2, durationSec: 1, removedSec: 3 }).execute();

		expect(spans(currentTracks.main.elements)).toEqual([
			[0, 5, 0],
			[5, 13, 7],
		]);
	});
});

describe("RestoreRangeCommand when the media cannot be recovered", () => {
	test("a removed whole clip re-opens the gap without inventing footage", () => {
		const main = buildEmptyTrack({ id: "main", type: "video" });
		main.elements = [
			clip({ id: "v0", type: "video", startSec: 0, durationSec: 5 }),
			clip({
				id: "v1",
				type: "video",
				mediaId: "m2",
				startSec: 5,
				durationSec: 5,
			}),
			clip({
				id: "v2",
				type: "video",
				mediaId: "m3",
				startSec: 10,
				durationSec: 5,
			}),
		];
		currentTracks = { overlay: [], main, audio: [] };

		cut({ fromSec: 5, toSec: 10 });
		expect(spans(currentTracks.main.elements)).toEqual([
			[0, 5, 0],
			[5, 5, 0],
		]);

		restore({ atSec: 5, offsetSec: 0, durationSec: 5, removedSec: 5 }).execute();
		// The neighbours are different media, so the removed clip is unknowable:
		// the gap re-opens (downstream slides right) and nothing is fabricated.
		expect(spans(currentTracks.main.elements)).toEqual([
			[0, 5, 0],
			[10, 5, 0],
		]);
	});
});

describe("RestoreRangeCommand ordering", () => {
	test("two seams restore in one command, later-first, both landing correctly", () => {
		// Cut later-first so the earlier range stays valid, as the real command does.
		cut({ fromSec: 10, toSec: 12 });
		cut({ fromSec: 5, toSec: 6 });
		// After both cuts: 0..5, 5..9 (source 6..10), 9..17 (source 12..20).
		expect(spans(currentTracks.main.elements)).toEqual([
			[0, 5, 0],
			[5, 4, 6],
			[9, 8, 12],
		]);

		new RestoreRangeCommand({
			ranges: [
				{ insertAt: S(5), offset: 0, duration: S(1), removedTotal: S(1) },
				{ insertAt: S(9), offset: 0, duration: S(2), removedTotal: S(2) },
			],
		}).execute();

		// Both gaps re-opened; every fragment merged back into the original clip.
		expect(spans(currentTracks.main.elements)).toEqual([[0, 20, 0]]);
		expect(currentTracks.main.elements[0].id).toBe("v0");
	});
});
