import { describe, expect, mock, test } from "bun:test";
import type { SceneTracks, VideoElement, VideoTrack } from "@/timeline";
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
}: {
	id: string;
	startTime: number;
	duration?: number;
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

function buildTracks({
	main,
	overlay = [],
}: {
	main: VideoElement[];
	overlay?: VideoElement[];
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
	return { overlay: [overlayTrack], main: mainTrack, audio: [] };
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
});
