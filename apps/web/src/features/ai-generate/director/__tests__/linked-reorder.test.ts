import { describe, expect, test } from "bun:test";
import { expandMovesToLinkedPartners } from "../linked-reorder";
import type { PlannedElementMove } from "@/timeline/group-move";
import type {
	AudioElement,
	AudioTrack,
	SceneTracks,
	VideoElement,
	VideoTrack,
} from "@/timeline";
import { mediaTime, ZERO_MEDIA_TIME } from "@/wasm";

const SECOND = 120_000;

function vid({
	id,
	startTime,
	linkId,
}: {
	id: string;
	startTime: number;
	linkId?: string;
}): VideoElement {
	return {
		id,
		type: "video",
		name: id,
		startTime: mediaTime({ ticks: startTime }),
		duration: mediaTime({ ticks: 5 * SECOND }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		mediaId: `media-${id}`,
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
	startTime,
	linkId,
}: {
	id: string;
	startTime: number;
	linkId?: string;
}): AudioElement {
	return {
		id,
		type: "audio",
		name: id,
		startTime: mediaTime({ ticks: startTime }),
		duration: mediaTime({ ticks: 5 * SECOND }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		sourceType: "upload",
		mediaId: `media-${id}`,
		linkId,
		params: {},
	} as unknown as AudioElement;
}

function buildTracks({
	main,
	audio = [],
}: {
	main: VideoElement[];
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
	const audioTrack: AudioTrack = {
		id: "audio-0",
		type: "audio",
		name: "A1",
		muted: false,
		elements: audio,
	} as unknown as AudioTrack;
	return { overlay: [], main: mainTrack, audio: [audioTrack] };
}

function move({
	elementId,
	newStartTime,
	trackId = "main",
}: {
	elementId: string;
	newStartTime: number;
	trackId?: string;
}): PlannedElementMove {
	return {
		sourceTrackId: trackId,
		targetTrackId: trackId,
		elementId,
		newStartTime: mediaTime({ ticks: newStartTime }),
	};
}

describe("expandMovesToLinkedPartners (Director reorder, linked-safe)", () => {
	test("a moved linked video drags its separated audio by the same delta", () => {
		// Out-of-order recording: v2 sits before v1; the reorder swaps them.
		const tracks = buildTracks({
			main: [
				vid({ id: "v2", startTime: 0, linkId: "L2" }),
				vid({ id: "v1", startTime: 5 * SECOND, linkId: "L1" }),
			],
			audio: [
				aud({ id: "a2", startTime: 0, linkId: "L2" }),
				aud({ id: "a1", startTime: 5 * SECOND, linkId: "L1" }),
			],
		});
		const expanded = expandMovesToLinkedPartners({
			tracks,
			moves: [
				move({ elementId: "v1", newStartTime: 0 }),
				move({ elementId: "v2", newStartTime: 5 * SECOND }),
			],
		});
		expect(expanded).toHaveLength(4);
		const byId = new Map(expanded.map((m) => [m.elementId, m]));
		expect(byId.get("a1")?.newStartTime).toBe(0);
		expect(byId.get("a1")?.targetTrackId).toBe("audio-0");
		expect(byId.get("a2")?.newStartTime).toBe(5 * SECOND);
	});

	test("an unlinked video adds no partner moves", () => {
		const tracks = buildTracks({
			main: [vid({ id: "v", startTime: 5 * SECOND })],
		});
		const moves = [move({ elementId: "v", newStartTime: 0 })];
		expect(expandMovesToLinkedPartners({ tracks, moves })).toEqual(moves);
	});

	test("a partner that already has its own move is never moved twice", () => {
		const tracks = buildTracks({
			main: [
				vid({ id: "v1", startTime: 0, linkId: "L" }),
				vid({ id: "v2", startTime: 5 * SECOND, linkId: "L" }),
			],
		});
		// Both link partners (video-video, timeline overlap not required between
		// non-overlapping siblings, so use identical spans is not possible on one
		// track; the dedupe is exercised via both being planned moves).
		const moves = [
			move({ elementId: "v1", newStartTime: 5 * SECOND }),
			move({ elementId: "v2", newStartTime: 0 }),
		];
		const expanded = expandMovesToLinkedPartners({ tracks, moves });
		expect(expanded).toHaveLength(2);
	});

	test("a zero-delta move adds nothing", () => {
		const tracks = buildTracks({
			main: [vid({ id: "v", startTime: 0, linkId: "L" })],
			audio: [aud({ id: "a", startTime: 0, linkId: "L" })],
		});
		const moves = [move({ elementId: "v", newStartTime: 0 })];
		expect(expandMovesToLinkedPartners({ tracks, moves })).toEqual(moves);
	});
});
