import { beforeEach, describe, expect, mock, test } from "bun:test";
import type {
	AudioElement,
	AudioTrack,
	SceneTracks,
	VideoElement,
	VideoTrack,
} from "@/timeline";
import { mediaTime, ZERO_MEDIA_TIME } from "@/wasm";

/**
 * G6 fix (round 18 reopen), step 4 of the mission: freeze frame's own ripple
 * (RippleShiftAtCommand, now linked-partner-aware - see ripple-shift-at.ts)
 * must not be shifted a SECOND time by the magnetic-main-track gap-close pass
 * in `core/managers/commands.ts` (`applyMagnetIfEnabled`). That pass compares
 * the WHOLE command's before/after main track and only shifts what it finds
 * still gapped - see `timeline/magnet.ts` `computeMagnetGapShifts`'s
 * "settled" rule. Since the freeze batch already leaves the main track
 * gap-free (split + insert + ripple), the diff should always net to zero
 * extra shifts, magnet ON or OFF.
 *
 * This exercises the REAL `CommandManager` and the REAL `BatchCommand` (only
 * `EditorCore.getInstance()` is stubbed, the same singleton every leaf
 * command under the batch reads/writes through), unlike
 * freeze-frame-batch.test.ts's `TestBatchCommand` stand-in - this is the
 * actual `editor.command.execute({ command: batch })` path production code
 * runs (see freeze-frame.ts).
 */

let currentTracks: SceneTracks;
mock.module("@/core", () => ({
	EditorCore: {
		getInstance: () => ({
			scenes: {
				getActiveScene: () => ({ tracks: currentTracks }),
				getActiveSceneOrNull: () => ({ tracks: currentTracks }),
			},
			timeline: {
				updateTracks: (tracks: SceneTracks) => {
					currentTracks = tracks;
				},
			},
			media: { getAssets: () => [] },
			project: { getActiveOrNull: () => null },
		}),
	},
}));

const { CommandManager } = await import("@/core/managers/commands");
const { buildFreezeFrameBatch } = await import("@/features/editing/freeze-frame");

function vid({
	id,
	startTime,
	duration,
	linkId,
}: {
	id: string;
	startTime: number;
	duration: number;
	linkId?: string;
}): VideoElement {
	return {
		id,
		type: "video",
		name: id,
		startTime: mediaTime({ ticks: startTime }),
		duration: mediaTime({ ticks: duration }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		mediaId: "source-media",
		...(linkId ? { linkId } : {}),
		params: {
			"transform.positionX": 0,
			"transform.positionY": 0,
			"transform.scaleX": 1,
			"transform.scaleY": 1,
			"transform.rotate": 0,
			opacity: 1,
		},
	};
}

function aud({
	id,
	startTime,
	duration,
	linkId,
}: {
	id: string;
	startTime: number;
	duration: number;
	linkId?: string;
}): AudioElement {
	return {
		id,
		type: "audio",
		name: id,
		sourceType: "upload",
		startTime: mediaTime({ ticks: startTime }),
		duration: mediaTime({ ticks: duration }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		mediaId: "source-media-audio",
		...(linkId ? { linkId } : {}),
		params: {},
	};
}

/** A frozen clip with linked audio, a downstream unlinked clip, and an
 * unlinked music bed spanning the whole timeline - the layout the magnet's
 * "settled" rule and the linked-partner ripple both have to get right. */
function buildProject(): SceneTracks {
	const main: VideoTrack = {
		id: "main",
		type: "video",
		name: "V1",
		muted: false,
		hidden: false,
		elements: [
			vid({ id: "clip", startTime: 0, duration: 1000, linkId: "link-1" }),
			vid({ id: "next", startTime: 1000, duration: 500 }),
		],
	};
	const voice: AudioTrack = {
		id: "a1",
		type: "audio",
		name: "A1",
		muted: false,
		elements: [
			aud({ id: "clip-au", startTime: 0, duration: 1000, linkId: "link-1" }),
		],
	};
	const music: AudioTrack = {
		id: "a2",
		type: "audio",
		name: "A2",
		muted: false,
		elements: [aud({ id: "bed", startTime: 0, duration: 1500 })],
	};
	return { overlay: [], main, audio: [voice, music] };
}

function startTimes(tracks: SceneTracks): Record<string, number> {
	const result: Record<string, number> = {};
	for (const track of [...tracks.overlay, tracks.main, ...tracks.audio]) {
		for (const element of track.elements) {
			result[`${track.id}:${element.id}`] = element.startTime as number;
		}
	}
	return result;
}

function elementCounts(tracks: SceneTracks): Record<string, number> {
	const result: Record<string, number> = {};
	for (const track of [...tracks.overlay, tracks.main, ...tracks.audio]) {
		result[track.id] = track.elements.length;
	}
	return result;
}

/** Per-track (startTime, duration) pairs, sorted, WITHOUT the element id -
 * the split/insert commands mint fresh random ids each run, so a magnet-ON
 * vs magnet-OFF geometry comparison has to ignore id and compare shape. */
function trackShapes(
	tracks: SceneTracks,
): Record<string, { startTime: number; duration: number }[]> {
	const result: Record<string, { startTime: number; duration: number }[]> = {};
	for (const track of [...tracks.overlay, tracks.main, ...tracks.audio]) {
		result[track.id] = track.elements
			.map((el) => ({
				startTime: el.startTime as number,
				duration: el.duration as number,
			}))
			.sort((a, b) => a.startTime - b.startTime);
	}
	return result;
}

function newManager() {
	const stubEditor = {
		scenes: { getActiveSceneOrNull: () => ({ tracks: currentTracks }) },
		timeline: {
			updateTracks: (tracks: SceneTracks) => {
				currentTracks = tracks;
			},
		},
		selection: {
			getSnapshot: () => ({
				selectedElements: [],
				selectedKeyframes: [],
				keyframeSelectionAnchor: null,
				selectedMaskPoints: null,
			}),
			applySelectionPatch: () => ({
				selectedElements: [],
				selectedKeyframes: [],
				keyframeSelectionAnchor: null,
				selectedMaskPoints: null,
			}),
			restoreSnapshot: () => {},
			// biome-ignore lint/suspicious/noExplicitAny: test stub, CommandManager's EditorCore type is much wider than this fixture needs
		} as any,
		// biome-ignore lint/suspicious/noExplicitAny: test stub
	} as any;
	return new CommandManager(stubEditor);
}

describe("freeze frame + magnetic main track integration", () => {
	beforeEach(() => {
		currentTracks = buildProject();
	});

	test("magnet ON lands exactly where magnet OFF lands: no double-shift", () => {
		const off = newManager();
		off.isMagnetEnabled = false;
		const { batch: offBatch } = buildFreezeFrameBatch({
			trackId: "main",
			elementId: "clip",
			splitTime: mediaTime({ ticks: 400 }),
			stillAssetId: "still-asset",
			tracks: currentTracks,
		});
		off.execute({ command: offBatch });
		const offResult = startTimes(currentTracks);
		const offCounts = elementCounts(currentTracks);
		const offShapes = trackShapes(currentTracks);

		currentTracks = buildProject();
		const on = newManager();
		on.isMagnetEnabled = true;
		const { batch: onBatch } = buildFreezeFrameBatch({
			trackId: "main",
			elementId: "clip",
			splitTime: mediaTime({ ticks: 400 }),
			stillAssetId: "still-asset",
			tracks: currentTracks,
		});
		on.execute({ command: onBatch });
		const onResult = startTimes(currentTracks);
		const onCounts = elementCounts(currentTracks);
		const onShapes = trackShapes(currentTracks);

		// Sanity: the freeze actually moved things (this isn't vacuously true).
		// "clip-au" keeps its id as the LEFT half (stays at 0); the split's
		// fresh-id RIGHT half is what rides the ripple.
		expect(offResult["main:next"]).toBeGreaterThan(1000);
		expect(offResult["a1:clip-au"]).toBe(0);
		expect(offCounts.a1).toBe(2);

		// The split/insert commands mint fresh random ids per run, so compare
		// GEOMETRY (per-track sorted start/duration pairs) rather than raw id
		// keys: if the magnet gap-close pass ran a second, redundant shift on
		// top of the batch's own ripple, the ON geometry would drift right of
		// the OFF geometry on main and/or a1.
		expect(onShapes).toEqual(offShapes);
		expect(onCounts).toEqual(offCounts);

		// The unlinked music bed never moves in EITHER mode.
		expect(offResult["a2:bed"]).toBe(0);
		expect(onResult["a2:bed"]).toBe(0);
	});

	test("magnet ON: one undo reverts the freeze (and any magnet shift) in a single step", () => {
		const before = startTimes(currentTracks);
		const beforeCounts = elementCounts(currentTracks);
		const manager = newManager();
		manager.isMagnetEnabled = true;

		const { batch } = buildFreezeFrameBatch({
			trackId: "main",
			elementId: "clip",
			splitTime: mediaTime({ ticks: 400 }),
			stillAssetId: "still-asset",
			tracks: currentTracks,
		});
		manager.execute({ command: batch });
		expect(startTimes(currentTracks)).not.toEqual(before);

		manager.undo();
		expect(startTimes(currentTracks)).toEqual(before);
		expect(elementCounts(currentTracks)).toEqual(beforeCounts);
	});
});
