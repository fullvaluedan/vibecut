import { describe, expect, mock, test } from "bun:test";
import type {
	AudioElement,
	AudioTrack,
	SceneTracks,
	VideoElement,
	VideoTrack,
} from "@/timeline";
import { computeAvSyncOffset } from "@/timeline/av-sync";
import { mediaTime, TICKS_PER_SECOND, ZERO_MEDIA_TIME } from "@/wasm";

let currentTracks: SceneTracks;
mock.module("@/core", () => ({
	EditorCore: {
		getInstance: () => ({
			scenes: { getActiveScene: () => ({ tracks: currentTracks }) },
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

// Some OTHER suites (director/apply-plan etc.) permanently mock
// "@/commands/batch-command" with a stand-in that has no execute/undo, and
// bun's `mock.module` overrides are process-wide, not file-scoped - so a
// full `bun test` run can leak that stand-in into THIS file depending on
// file execution order. Re-mock it here with a faithful (execute-all /
// undo-all-in-reverse) reimplementation so this suite's result never
// depends on what order files happen to run in.
class TestBatchCommand {
	constructor(private commands: { execute: () => unknown; undo: () => void }[]) {}
	execute() {
		for (const command of this.commands) command.execute();
		return undefined;
	}
	undo() {
		for (const command of [...this.commands].reverse()) command.undo();
	}
}
mock.module("@/commands/batch-command", () => ({ BatchCommand: TestBatchCommand }));

const { buildFreezeFrameBatch } = await import("@/features/editing/freeze-frame");

function vid({
	id,
	startTime,
	duration = 100,
	linkId,
}: {
	id: string;
	startTime: number;
	duration?: number;
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
	duration = 100,
	linkId,
}: {
	id: string;
	startTime: number;
	duration?: number;
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

function buildTracks({
	main,
	overlay = [],
	audio = [],
}: {
	main: VideoElement[];
	overlay?: VideoElement[];
	audio?: AudioElement[];
}): SceneTracks {
	const mainTrack: VideoTrack = {
		id: "main",
		type: "video",
		name: "V1",
		muted: false,
		hidden: false,
		elements: main,
	};
	const overlayTrack: VideoTrack = {
		id: "v2",
		type: "video",
		name: "V2",
		muted: false,
		hidden: false,
		elements: overlay,
	};
	const audioTrack: AudioTrack = {
		id: "a1",
		type: "audio",
		name: "A1",
		muted: false,
		elements: audio,
	};
	return { overlay: [overlayTrack], main: mainTrack, audio: [audioTrack] };
}

describe("buildFreezeFrameBatch", () => {
	test("splits at the playhead, inserts a still, and ripples everything after it right", () => {
		const original = buildTracks({
			main: [
				vid({ id: "clip", startTime: 0, duration: 1000 }),
				vid({ id: "next", startTime: 1000, duration: 500 }),
			],
		});
		currentTracks = original;

		const splitTime = mediaTime({ ticks: 400 });
		const { batch, insertCommand } = buildFreezeFrameBatch({
			trackId: "main",
			elementId: "clip",
			splitTime,
			stillAssetId: "still-asset",
			tracks: original,
		});

		batch.execute();

		const elements = currentTracks.main.elements
			.slice()
			.sort((a, b) => a.startTime - b.startTime);

		// left half [0, 400), right half now starts after the still, "next" is
		// pushed right by the still's duration too.
		expect(elements).toHaveLength(4);
		const [left, still, right, next] = elements;
		expect(left.id).toBe("clip");
		expect(left.startTime).toBe(0);
		expect(left.duration).toBe(400);

		expect(still.id).toBe(insertCommand.getElementId());
		expect(still.type).toBe("image");
		expect(still.startTime).toBe(400);

		expect(right.startTime).toBe(400 + still.duration);
		expect(right.duration).toBe(600); // 1000 - 400

		expect(next.startTime).toBe(1000 + still.duration);
	});

	test("the still's duration matches the requested seconds exactly", () => {
		currentTracks = buildTracks({
			main: [vid({ id: "clip", startTime: 0, duration: 1000 })],
		});

		const { batch, insertCommand } = buildFreezeFrameBatch({
			trackId: "main",
			elementId: "clip",
			splitTime: mediaTime({ ticks: 300 }),
			stillAssetId: "still-asset",
			tracks: currentTracks,
			// Default durationSeconds = FREEZE_FRAME_DURATION_SECONDS (3s).
		});
		batch.execute();

		const still = currentTracks.main.elements.find(
			(element) => element.id === insertCommand.getElementId(),
		);
		expect(still).toBeDefined();
		expect(still!.duration).toBe(3 * TICKS_PER_SECOND);
	});

	test("ONE undo reverts split + ripple + insert back to the original single clip", () => {
		const original = buildTracks({
			main: [vid({ id: "clip", startTime: 0, duration: 1000 })],
		});
		currentTracks = original;

		const { batch } = buildFreezeFrameBatch({
			trackId: "main",
			elementId: "clip",
			splitTime: mediaTime({ ticks: 400 }),
			stillAssetId: "still-asset",
			tracks: original,
		});
		batch.execute();
		expect(currentTracks.main.elements.length).toBeGreaterThan(1);

		batch.undo();
		expect(currentTracks).toEqual(original);
		expect(currentTracks.main.elements).toHaveLength(1);
		expect(currentTracks.main.elements[0].id).toBe("clip");
		expect(currentTracks.main.elements[0].duration).toBe(1000);
	});

	test("magnet interaction: a clip butted immediately after the split point shifts, one that starts before it does not", () => {
		currentTracks = buildTracks({
			main: [
				vid({ id: "clip", startTime: 0, duration: 1000 }),
				vid({ id: "butted", startTime: 1000, duration: 200 }),
			],
			overlay: [vid({ id: "unrelated-track", startTime: 1000, duration: 200 })],
		});

		const { batch } = buildFreezeFrameBatch({
			trackId: "main",
			elementId: "clip",
			splitTime: mediaTime({ ticks: 400 }),
			stillAssetId: "still-asset",
			tracks: currentTracks,
		});
		batch.execute();

		const butted = currentTracks.main.elements.find((e) => e.id === "butted");
		expect(butted).toBeDefined();
		expect(butted!.startTime).toBeGreaterThan(1000);

		// A same-time element on a DIFFERENT track is left alone (freeze frame
		// only ripples the track it acts on).
		const unrelated = currentTracks.overlay[0].elements.find(
			(e) => e.id === "unrelated-track",
		);
		expect(unrelated!.startTime).toBe(1000);
	});

	// --- G6 fix (round 18 reopen): freeze frame must ripple the linked audio
	// half in lockstep with the video, split it at the freeze point (silence
	// under the still), and leave any unlinked audio untouched. ---

	test("linked audio is split at the freeze point and its right half rides the same ripple as the video", () => {
		const original = buildTracks({
			main: [vid({ id: "clip", startTime: 0, duration: 1000, linkId: "link-1" })],
			audio: [aud({ id: "clip-au", startTime: 0, duration: 1000, linkId: "link-1" })],
		});
		currentTracks = original;

		const splitTime = mediaTime({ ticks: 400 });
		const { batch } = buildFreezeFrameBatch({
			trackId: "main",
			elementId: "clip",
			splitTime,
			stillAssetId: "still-asset",
			tracks: original,
		});
		batch.execute();

		const videoRight = currentTracks.main.elements
			.filter((el) => el.id !== "clip")
			.find((el) => el.startTime > 400)!;
		expect(videoRight).toBeDefined();
		expect(videoRight.duration).toBe(600); // 1000 - 400

		const audioElements = currentTracks.audio[0].elements;
		// The audio clip is SPLIT, not left whole: a left half staying at 0 and
		// a right half that moved with the still, exactly like the video.
		expect(audioElements).toHaveLength(2);
		const audioLeft = audioElements.find((el) => el.startTime === 0)!;
		const audioRight = audioElements.find((el) => el.startTime !== 0)!;
		expect(audioLeft).toBeDefined();
		expect(audioLeft.duration).toBe(400);
		expect(audioRight).toBeDefined();
		expect(audioRight.duration).toBe(600);

		// Lockstep: the audio's right half lands at EXACTLY the same startTime
		// as the video's right half (splitTime + the still's duration) - this is
		// the desync the G6 reopen bug reported (audio never moved at all).
		expect(audioRight.startTime).toBe(videoRight.startTime);

		// The split right halves are re-linked to each other (fresh shared
		// linkId), which is what let the ripple's linked-partner walk find and
		// shift the audio half in the same pass as the video.
		expect(audioRight.linkId).toBeDefined();
		expect(audioRight.linkId).toBe(videoRight.linkId);
		expect(audioRight.linkId).not.toBe("link-1");

		// Full av-sync check via the shared helper (timeline/av-sync.ts): the
		// pair's frame offset is exactly zero, i.e. genuinely in sync, not just
		// "close" - reuses the same partner-pairing/offset math the desync
		// badge itself runs on.
		const rightSync = computeAvSyncOffset({
			element: videoRight,
			tracks: currentTracks,
			fps: null,
		});
		expect(rightSync).not.toBeNull();
		expect(rightSync!.partner.elementId).toBe(audioRight.id);
		expect(rightSync!.offsetFrames).toBe(0);

		const leftSync = computeAvSyncOffset({
			element: currentTracks.main.elements.find((el) => el.id === "clip")!,
			tracks: currentTracks,
			fps: null,
		});
		expect(leftSync).not.toBeNull();
		expect(leftSync!.partner.elementId).toBe(audioLeft.id);
		expect(leftSync!.offsetFrames).toBe(0);
	});

	test("an unlinked audio clip (music bed) never moves or splits", () => {
		const original = buildTracks({
			main: [vid({ id: "clip", startTime: 0, duration: 1000, linkId: "link-1" })],
			audio: [
				aud({ id: "clip-au", startTime: 0, duration: 1000, linkId: "link-1" }),
				// A music bed spanning the whole timeline, no linkId: not the freeze
				// target's partner, must be left byte-exact.
				aud({ id: "bed", startTime: 0, duration: 2000 }),
			],
		});
		currentTracks = original;

		const { batch } = buildFreezeFrameBatch({
			trackId: "main",
			elementId: "clip",
			splitTime: mediaTime({ ticks: 400 }),
			stillAssetId: "still-asset",
			tracks: original,
		});
		batch.execute();

		const bed = currentTracks.audio[0].elements.find((el) => el.id === "bed");
		expect(bed).toBeDefined();
		expect(bed).toEqual(original.audio[0].elements.find((el) => el.id === "bed"));
	});

	test("an audio clip with NO linkId at all (never separated) never moves", () => {
		const original = buildTracks({
			main: [vid({ id: "clip", startTime: 0, duration: 1000 })], // no linkId
			audio: [aud({ id: "bed", startTime: 0, duration: 2000 })], // no linkId
		});
		currentTracks = original;

		const { batch } = buildFreezeFrameBatch({
			trackId: "main",
			elementId: "clip",
			splitTime: mediaTime({ ticks: 400 }),
			stillAssetId: "still-asset",
			tracks: original,
		});
		batch.execute();

		expect(currentTracks.audio[0].elements).toEqual(original.audio[0].elements);
	});

	test("ONE undo restores both the video and linked-audio tracks byte-exact", () => {
		const original = buildTracks({
			main: [vid({ id: "clip", startTime: 0, duration: 1000, linkId: "link-1" })],
			audio: [aud({ id: "clip-au", startTime: 0, duration: 1000, linkId: "link-1" })],
		});
		currentTracks = original;

		const { batch } = buildFreezeFrameBatch({
			trackId: "main",
			elementId: "clip",
			splitTime: mediaTime({ ticks: 400 }),
			stillAssetId: "still-asset",
			tracks: original,
		});
		batch.execute();
		expect(currentTracks.audio[0].elements).toHaveLength(2);

		batch.undo();
		expect(currentTracks).toEqual(original);
		expect(currentTracks.audio[0].elements).toHaveLength(1);
		expect(currentTracks.audio[0].elements[0].id).toBe("clip-au");
		expect(currentTracks.audio[0].elements[0].duration).toBe(1000);
	});
});
