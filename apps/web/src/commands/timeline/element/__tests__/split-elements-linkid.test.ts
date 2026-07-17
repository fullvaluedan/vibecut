import { describe, expect, mock, test } from "bun:test";
import type {
	AudioElement,
	AudioTrack,
	SceneTracks,
	VideoElement,
	VideoTrack,
} from "@/timeline";
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

import { SplitElementsCommand } from "@/commands/timeline/element/split-elements";

const FRAME = 4_000;

function vid({
	id,
	linkId,
}: {
	id: string;
	linkId?: string;
}): VideoElement {
	return {
		id,
		type: "video",
		name: id,
		startTime: ZERO_MEDIA_TIME,
		duration: mediaTime({ ticks: 40 * FRAME }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		mediaId: "m",
		linkId,
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
	linkId,
}: {
	id: string;
	linkId?: string;
}): AudioElement {
	return {
		id,
		type: "audio",
		name: id,
		startTime: ZERO_MEDIA_TIME,
		duration: mediaTime({ ticks: 40 * FRAME }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		sourceType: "upload",
		mediaId: "m",
		linkId,
		params: {},
	} as unknown as AudioElement;
}

function buildTracks({
	video,
	audio,
}: {
	video: VideoElement[];
	audio: AudioElement[];
}): SceneTracks {
	const main: VideoTrack = {
		id: "main",
		type: "video",
		name: "V1",
		muted: false,
		hidden: false,
		elements: video,
	};
	const audioTrack: AudioTrack = {
		id: "audio-0",
		type: "audio",
		name: "A1",
		muted: false,
		elements: audio,
	} as unknown as AudioTrack;
	return { overlay: [], main, audio: [audioTrack] };
}

describe("SplitElementsCommand fresh linkIds (LIVE-TEST item 10 hardening)", () => {
	test("right-side halves of a linked pair share ONE fresh linkId; left halves keep the original", () => {
		currentTracks = buildTracks({
			video: [vid({ id: "v", linkId: "L" })],
			audio: [aud({ id: "a", linkId: "L" })],
		});
		const command = new SplitElementsCommand({
			elements: [
				{ trackId: "main", elementId: "v" },
				{ trackId: "audio-0", elementId: "a" },
			],
			splitTime: mediaTime({ ticks: 20 * FRAME }),
		});
		command.execute();

		const [vLeft, vRight] = currentTracks.main.elements;
		const [aLeft, aRight] = currentTracks.audio[0].elements;
		expect(vLeft.linkId).toBe("L");
		expect(aLeft.linkId).toBe("L");
		// The right halves stay ganged with each other on a NEW id.
		expect(vRight.linkId).toBeDefined();
		expect(vRight.linkId).not.toBe("L");
		expect(aRight.linkId).toBe(vRight.linkId);
	});

	test("an unlinked element's right half stays unlinked", () => {
		currentTracks = buildTracks({
			video: [vid({ id: "v" })],
			audio: [],
		});
		const command = new SplitElementsCommand({
			elements: [{ trackId: "main", elementId: "v" }],
			splitTime: mediaTime({ ticks: 20 * FRAME }),
		});
		command.execute();

		const [, vRight] = currentTracks.main.elements;
		expect(vRight.linkId).toBeUndefined();
	});

	test("two DIFFERENT link groups split together each get their own fresh id", () => {
		currentTracks = buildTracks({
			video: [vid({ id: "v1", linkId: "L1" })],
			audio: [aud({ id: "a2", linkId: "L2" })],
		});
		const command = new SplitElementsCommand({
			elements: [
				{ trackId: "main", elementId: "v1" },
				{ trackId: "audio-0", elementId: "a2" },
			],
			splitTime: mediaTime({ ticks: 20 * FRAME }),
		});
		command.execute();

		const [, vRight] = currentTracks.main.elements;
		const [, aRight] = currentTracks.audio[0].elements;
		expect(vRight.linkId).toBeDefined();
		expect(aRight.linkId).toBeDefined();
		expect(vRight.linkId).not.toBe(aRight.linkId);
		expect(vRight.linkId).not.toBe("L1");
		expect(aRight.linkId).not.toBe("L2");
	});

	test("undo restores the original single-linkId shape", () => {
		const original = buildTracks({
			video: [vid({ id: "v", linkId: "L" })],
			audio: [aud({ id: "a", linkId: "L" })],
		});
		currentTracks = original;
		const command = new SplitElementsCommand({
			elements: [
				{ trackId: "main", elementId: "v" },
				{ trackId: "audio-0", elementId: "a" },
			],
			splitTime: mediaTime({ ticks: 20 * FRAME }),
		});
		command.execute();
		command.undo();
		expect(currentTracks).toBe(original);
	});
});
