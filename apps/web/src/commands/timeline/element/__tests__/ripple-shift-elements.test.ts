import { describe, expect, mock, test } from "bun:test";
import type { SceneTracks, VideoElement, VideoTrack } from "@/timeline";
import { mediaTime, ZERO_MEDIA_TIME } from "@/wasm";

// A minimal EditorCore stand-in: the command only reads the active scene's
// tracks and writes the updated tracks back.
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

import { RippleShiftElementsCommand } from "@/commands/timeline/element/ripple-shift-elements";

const FRAME = 4_000;

function vid({
	id,
	startTime,
}: {
	id: string;
	startTime: number;
}): VideoElement {
	return {
		id,
		type: "video",
		name: id,
		startTime: mediaTime({ ticks: startTime }),
		duration: mediaTime({ ticks: 10 * FRAME }),
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

function buildTracks(elements: VideoElement[]): SceneTracks {
	const main: VideoTrack = {
		id: "main",
		type: "video",
		name: "V1",
		muted: false,
		hidden: false,
		elements,
	};
	return { overlay: [], main, audio: [] };
}

describe("RippleShiftElementsCommand", () => {
	test("applies the precomputed shifts directly (no head-gravity snap) and undoes", () => {
		const original = buildTracks([
			vid({ id: "a", startTime: 0 }),
			vid({ id: "b", startTime: 20 * FRAME }),
		]);
		currentTracks = original;
		const command = new RippleShiftElementsCommand({
			shifts: [
				// A shift landing under 2s must stick exactly where computed; the
				// update pipeline's main-track gravity must NOT run for system shifts.
				{ trackId: "main", elementId: "b", newStartTime: mediaTime({ ticks: 15 * FRAME }) },
			],
		});
		command.execute();
		expect(currentTracks.main.elements[1].startTime).toBe(15 * FRAME);
		expect(currentTracks.main.elements[0].startTime).toBe(0);

		command.undo();
		expect(currentTracks).toBe(original);
	});

	test("an empty shift list is a no-op", () => {
		const original = buildTracks([vid({ id: "a", startTime: 0 })]);
		currentTracks = original;
		new RippleShiftElementsCommand({ shifts: [] }).execute();
		expect(currentTracks).toBe(original);
	});
});
