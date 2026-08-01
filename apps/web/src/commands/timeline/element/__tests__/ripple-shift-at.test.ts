import { describe, expect, mock, test } from "bun:test";
import type { SceneTracks, VideoElement, VideoTrack } from "@/timeline";
import { mediaTime, ZERO_MEDIA_TIME } from "@/wasm";

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
		}),
	},
}));

import { RippleShiftAtCommand } from "@/commands/timeline/element/ripple-shift-at";

function vid({ id, startTime }: { id: string; startTime: number }): VideoElement {
	return {
		id,
		type: "video",
		name: id,
		startTime: mediaTime({ ticks: startTime }),
		duration: mediaTime({ ticks: 100 }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		mediaId: "m",
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

describe("RippleShiftAtCommand", () => {
	test("shifts every element on the track at/after atTime, leaves earlier ones and other tracks alone", () => {
		const original = buildTracks({
			main: [vid({ id: "a", startTime: 0 }), vid({ id: "b", startTime: 100 })],
			overlay: [vid({ id: "c", startTime: 100 })],
		});
		currentTracks = original;

		new RippleShiftAtCommand({
			trackId: "main",
			atTime: mediaTime({ ticks: 100 }),
			shiftDuration: mediaTime({ ticks: 50 }),
		}).execute();

		expect(currentTracks.main.elements[0].startTime).toBe(0);
		expect(currentTracks.main.elements[1].startTime).toBe(150);
		// A different track is untouched even though it has an element at the
		// same boundary time.
		expect(currentTracks.overlay[0].elements[0].startTime).toBe(100);
	});

	test("a boundary element (startTime === atTime) is included (>=, not >)", () => {
		const original = buildTracks({ main: [vid({ id: "a", startTime: 50 })] });
		currentTracks = original;

		new RippleShiftAtCommand({
			trackId: "main",
			atTime: mediaTime({ ticks: 50 }),
			shiftDuration: mediaTime({ ticks: 10 }),
		}).execute();

		expect(currentTracks.main.elements[0].startTime).toBe(60);
	});

	test("no qualifying elements is a no-op", () => {
		const original = buildTracks({ main: [vid({ id: "a", startTime: 0 })] });
		currentTracks = original;

		new RippleShiftAtCommand({
			trackId: "main",
			atTime: mediaTime({ ticks: 1000 }),
			shiftDuration: mediaTime({ ticks: 10 }),
		}).execute();

		expect(currentTracks).toBe(original);
	});

	test("undo restores the exact prior track snapshot", () => {
		const original = buildTracks({ main: [vid({ id: "a", startTime: 50 })] });
		currentTracks = original;

		const command = new RippleShiftAtCommand({
			trackId: "main",
			atTime: mediaTime({ ticks: 50 }),
			shiftDuration: mediaTime({ ticks: 10 }),
		});
		command.execute();
		expect(currentTracks).not.toBe(original);

		command.undo();
		expect(currentTracks).toBe(original);
	});

	test("an unknown trackId is a no-op", () => {
		const original = buildTracks({ main: [vid({ id: "a", startTime: 0 })] });
		currentTracks = original;

		new RippleShiftAtCommand({
			trackId: "does-not-exist",
			atTime: mediaTime({ ticks: 0 }),
			shiftDuration: mediaTime({ ticks: 10 }),
		}).execute();

		expect(currentTracks).toBe(original);
	});
});
