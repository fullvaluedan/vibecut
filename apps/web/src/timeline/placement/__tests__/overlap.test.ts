import { describe, expect, test } from "bun:test";
import type { VideoElement, VideoTrack } from "@/timeline";
import { canPlaceTimeSpansOnTrack } from "@/timeline/placement/overlap";
import { mediaTime, ZERO_MEDIA_TIME } from "@/wasm";

function buildVideoElement({
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

function span({ startTime, duration }: { startTime: number; duration: number }) {
	return {
		startTime: mediaTime({ ticks: startTime }),
		duration: mediaTime({ ticks: duration }),
	};
}

describe("canPlaceTimeSpansOnTrack excludeElementIds", () => {
	// Two clips [a: 0..5][b: 5..10] shifted right by 3 -> [a: 3..8][b: 8..13].
	// The shifted anchor `a` still overlaps `b`'s OLD position; `b` shifted still
	// overlaps its own old position. Only excluding the whole moving set lets the
	// group shift pass.
	const track: { elements: VideoTrack["elements"] } = {
		elements: [
			buildVideoElement({ id: "a", startTime: 0, duration: 5 }),
			buildVideoElement({ id: "b", startTime: 5, duration: 5 }),
		],
	};

	test("false when only the anchor is excluded (the reported no-op)", () => {
		expect(
			canPlaceTimeSpansOnTrack({
				track,
				timeSpans: [span({ startTime: 3, duration: 5 })],
				excludeElementIds: new Set(["a"]),
			}),
		).toBe(false);
	});

	test("true when the whole moving set is excluded", () => {
		expect(
			canPlaceTimeSpansOnTrack({
				track,
				timeSpans: [span({ startTime: 3, duration: 5 })],
				excludeElementIds: new Set(["a", "b"]),
			}),
		).toBe(true);
	});

	test("single-clip exclude (one-element set) matches prior behavior", () => {
		const singleTrack: { elements: VideoTrack["elements"] } = {
			elements: [buildVideoElement({ id: "a", startTime: 0, duration: 5 })],
		};
		expect(
			canPlaceTimeSpansOnTrack({
				track: singleTrack,
				timeSpans: [span({ startTime: 3, duration: 5 })],
				excludeElementIds: new Set(["a"]),
			}),
		).toBe(true);
	});

	test("a non-moving clip genuinely in the way still blocks", () => {
		const withStationary: { elements: VideoTrack["elements"] } = {
			elements: [
				buildVideoElement({ id: "a", startTime: 0, duration: 5 }),
				buildVideoElement({ id: "b", startTime: 5, duration: 5 }),
				buildVideoElement({ id: "stationary", startTime: 12, duration: 5 }),
			],
		};
		// Group [a,b] shifted so b lands 8..13 overlapping the stationary clip.
		expect(
			canPlaceTimeSpansOnTrack({
				track: withStationary,
				timeSpans: [span({ startTime: 8, duration: 8 })],
				excludeElementIds: new Set(["a", "b"]),
			}),
		).toBe(false);
	});

	test("no exclude set behaves as before (per-span excludeElementId still honored)", () => {
		expect(
			canPlaceTimeSpansOnTrack({
				track,
				timeSpans: [
					{
						startTime: mediaTime({ ticks: 3 }),
						duration: mediaTime({ ticks: 5 }),
						excludeElementId: "a",
					},
				],
			}),
		).toBe(false);
	});
});
