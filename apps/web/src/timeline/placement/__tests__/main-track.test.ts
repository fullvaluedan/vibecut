import { describe, expect, test } from "bun:test";
import { enforceMainTrackStart } from "@/timeline/placement/main-track";
import type { SceneTracks, VideoElement, VideoTrack } from "@/timeline";
import { mediaTime, ZERO_MEDIA_TIME } from "@/wasm";

// TICKS_PER_SECOND is 120_000 under the test wasm mock.
const SECOND = 120_000;

function videoElement({
	id,
	startTime,
	duration,
}: {
	id: string;
	startTime: number;
	duration: number;
}): VideoElement {
	return {
		id,
		type: "video",
		name: id,
		startTime: mediaTime({ ticks: startTime }),
		duration: mediaTime({ ticks: duration }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		mediaId: `media-${id}`,
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

function buildTracks(mainElements: VideoElement[]): SceneTracks {
	const main: VideoTrack = {
		id: "main-track",
		type: "video",
		name: "Main",
		muted: false,
		hidden: false,
		elements: mainElements,
	};
	return { overlay: [], main, audio: [] };
}

function enforce({
	tracks,
	requested,
	targetTrackId = "main-track",
}: {
	tracks: SceneTracks;
	requested: number;
	targetTrackId?: string;
}) {
	return enforceMainTrackStart({
		tracks,
		targetTrackId,
		requestedStartTime: mediaTime({ ticks: requested }),
	});
}

describe("enforceMainTrackStart head gravity (Dan's fork)", () => {
	test("first import on an empty main track lands at 0 for a near-0 request", () => {
		const tracks = buildTracks([]);
		expect(enforce({ tracks, requested: 0 })).toBe(0);
		expect(enforce({ tracks, requested: 1 * SECOND })).toBe(0);
	});

	test("a placement on an empty main track beyond 2s lands where requested", () => {
		const tracks = buildTracks([]);
		expect(enforce({ tracks, requested: 30 * SECOND })).toBe(30 * SECOND);
	});

	test("a head-bound placement under 2s snaps to 0", () => {
		const tracks = buildTracks([
			videoElement({ id: "a", startTime: 5 * SECOND, duration: SECOND }),
		]);
		expect(enforce({ tracks, requested: 1 * SECOND })).toBe(0);
	});

	test("a head-bound placement beyond 2s lands where requested", () => {
		const tracks = buildTracks([
			videoElement({ id: "a", startTime: 10 * SECOND, duration: SECOND }),
		]);
		expect(enforce({ tracks, requested: 5 * SECOND })).toBe(5 * SECOND);
	});

	test("a sub-2s placement that is not head-bound keeps its requested start", () => {
		const tracks = buildTracks([
			videoElement({ id: "head", startTime: 0, duration: SECOND }),
		]);
		expect(enforce({ tracks, requested: 1.5 * SECOND })).toBe(1.5 * SECOND);
	});

	test("a non-main track is never adjusted", () => {
		const tracks = buildTracks([]);
		expect(
			enforce({ tracks, requested: 1 * SECOND, targetTrackId: "other-track" }),
		).toBe(1 * SECOND);
	});
});
