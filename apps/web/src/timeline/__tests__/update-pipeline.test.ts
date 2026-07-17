import { describe, expect, test } from "bun:test";
import type { Transform } from "@/rendering";
import type { SceneTracks, VideoElement } from "@/timeline";
import { applyElementUpdate } from "@/timeline/update-pipeline";
import { mediaTime, ZERO_MEDIA_TIME } from "@/wasm";

function buildTransform(): Transform {
	return {
		scaleX: 1,
		scaleY: 1,
		position: { x: 0, y: 0 },
		rotate: 0,
	};
}

function buildVideoElement(overrides: Partial<VideoElement> = {}): VideoElement {
	return {
		id: "video-1",
		type: "video",
		name: "Video 1",
		startTime: ZERO_MEDIA_TIME,
		duration: mediaTime({ ticks: 10 }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		mediaId: "media-1",
		params: {
			"transform.positionX": 0,
			"transform.positionY": 0,
			"transform.scaleX": 1,
			"transform.scaleY": 1,
			"transform.rotate": 0,
			opacity: 1,
		},
		...overrides,
	};
}

function buildTracks(element: VideoElement): SceneTracks {
	return {
		overlay: [],
		main: {
			id: "main-track",
			type: "video",
			name: "Main",
			muted: false,
			hidden: false,
			elements: [element],
		},
		audio: [],
	};
}

describe("applyElementUpdate", () => {
	test("rounds retimed durations back to integer media time", () => {
		const element = buildVideoElement();
		const tracks = buildTracks(element);

		const updatedElement = applyElementUpdate({
			element,
			patch: {
				retime: { rate: 1.5 },
			},
			context: {
				tracks,
				trackId: tracks.main.id,
			},
		});

		expect(updatedElement.duration).toBe(7);
		expect(Number.isInteger(updatedElement.duration)).toBe(true);
	});
});

// TICKS_PER_SECOND is 120_000 under the test wasm mock.
const SECOND = 120_000;

function buildMainTracks(elements: VideoElement[]): SceneTracks {
	return {
		overlay: [],
		main: {
			id: "main-track",
			type: "video",
			name: "Main",
			muted: false,
			hidden: false,
			elements,
		},
		audio: [],
	};
}

describe("applyElementUpdate startTime enforce (head gravity, Dan's fork)", () => {
	test("a head-bound pure move under 2s snaps to 0", () => {
		const self = buildVideoElement({ id: "self" });
		const other = buildVideoElement({
			id: "other",
			startTime: mediaTime({ ticks: 10 * SECOND }),
		});
		const tracks = buildMainTracks([self, other]);

		const updated = applyElementUpdate({
			element: self,
			patch: { startTime: mediaTime({ ticks: 1 * SECOND }) },
			context: { tracks, trackId: tracks.main.id },
		});
		expect(updated.startTime).toBe(0);
	});

	test("a pure move to 3s keeps its spot (the old absolute pin is gone)", () => {
		const self = buildVideoElement({ id: "self" });
		const tracks = buildMainTracks([self]);

		const updated = applyElementUpdate({
			element: self,
			patch: { startTime: mediaTime({ ticks: 3 * SECOND }) },
			context: { tracks, trackId: tracks.main.id },
		});
		expect(updated.startTime).toBe(3 * SECOND);
	});

	test("a pure move to exactly 2.0s is free (boundary is exclusive)", () => {
		const self = buildVideoElement({ id: "self" });
		const tracks = buildMainTracks([self]);

		const updated = applyElementUpdate({
			element: self,
			patch: { startTime: mediaTime({ ticks: 2 * SECOND }) },
			context: { tracks, trackId: tracks.main.id },
		});
		expect(updated.startTime).toBe(2 * SECOND);
	});

	test("a sub-2s move that is not head-bound keeps its requested start", () => {
		// Another clip already owns the head (starts at 0), so gravity yields: a
		// programmatic shift landing a downstream clip at 1.5s must not pile it
		// onto the occupied head.
		const head = buildVideoElement({ id: "head" });
		const self = buildVideoElement({
			id: "self",
			startTime: mediaTime({ ticks: 10 * SECOND }),
		});
		const tracks = buildMainTracks([head, self]);

		const updated = applyElementUpdate({
			element: self,
			patch: { startTime: mediaTime({ ticks: 1.5 * SECOND }) },
			context: { tracks, trackId: tracks.main.id },
		});
		expect(updated.startTime).toBe(1.5 * SECOND);
	});

	test("a resize keeps its requested start even under 2s (no gravity)", () => {
		const self = buildVideoElement({ id: "self" });
		const tracks = buildMainTracks([self]);

		const updated = applyElementUpdate({
			element: self,
			patch: {
				startTime: mediaTime({ ticks: 1 * SECOND }),
				duration: mediaTime({ ticks: 5 }),
				trimStart: mediaTime({ ticks: 5 }),
			},
			context: { tracks, trackId: tracks.main.id },
		});
		expect(updated.startTime).toBe(1 * SECOND);
	});

	test("a negative start clamps to 0 on any track", () => {
		const self = buildVideoElement({ id: "self" });
		const tracks = buildMainTracks([self]);

		const updated = applyElementUpdate({
			element: self,
			patch: { startTime: mediaTime({ ticks: -SECOND }) },
			context: { tracks, trackId: tracks.main.id },
		});
		expect(updated.startTime).toBe(0);
	});
});
