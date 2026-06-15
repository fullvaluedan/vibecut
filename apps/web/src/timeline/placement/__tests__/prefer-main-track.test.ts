import { describe, expect, test } from "bun:test";
import type { ElementType, SceneTracks } from "@/timeline";
import type { PlacementTimeSpan } from "@/timeline/placement";
import { preferMainTrackIndex } from "../prefer-main-track";

// These helpers build minimal track/span shapes. `preferMainTrackIndex` only
// reads `tracks.overlay.length`, `tracks.main.elements`, and span start/dur, so
// we avoid importing `@/wasm` (which fails to init under bun) by using plain
// numbers cast to the branded MediaTime types.
type El = { startTime: number; duration: number };

function mkTrack(id: string, type: string, elements: El[] = []) {
	return { id, type, name: id, elements } as unknown;
}

function mkScene(opts: {
	overlay?: El[][];
	main?: El[];
	audio?: El[][];
}): SceneTracks {
	return {
		overlay: (opts.overlay ?? []).map((els, i) =>
			mkTrack(`overlay-${i}`, "video", els),
		),
		main: mkTrack("video-main", "video", opts.main ?? []),
		audio: (opts.audio ?? []).map((els, i) =>
			mkTrack(`audio-${i}`, "audio", els),
		),
	} as unknown as SceneTracks;
}

function span(startTime: number, duration: number): PlacementTimeSpan[] {
	return [{ startTime, duration } as unknown as PlacementTimeSpan];
}

describe("preferMainTrackIndex", () => {
	test("redirects a video drop from a free overlay lane to main (V1)", () => {
		const tracks = mkScene({ overlay: [[]] }); // mainIndex = 1
		expect(
			preferMainTrackIndex({
				tracks,
				elementType: "video",
				hoveredTrackIndex: 0,
				timeSpans: span(3, 2),
			}),
		).toBe(1);
	});

	test("redirects an image drop to main too", () => {
		const tracks = mkScene({ overlay: [[]] });
		expect(
			preferMainTrackIndex({
				tracks,
				elementType: "image",
				hoveredTrackIndex: 0,
				timeSpans: span(0, 5),
			}),
		).toBe(1);
	});

	test("keeps the overlay lane when main is occupied at the drop time", () => {
		// main has a clip [0,10); the dropped span [3,5) overlaps it.
		const tracks = mkScene({ overlay: [[]], main: [{ startTime: 0, duration: 10 }] });
		expect(
			preferMainTrackIndex({
				tracks,
				elementType: "video",
				hoveredTrackIndex: 0,
				timeSpans: span(3, 2),
			}),
		).toBe(0);
	});

	test("redirects to main when the dropped span clears the existing main clip", () => {
		// main clip [0,3); dropped span [5,2) does not overlap → V1 fits.
		const tracks = mkScene({ overlay: [[]], main: [{ startTime: 0, duration: 3 }] });
		expect(
			preferMainTrackIndex({
				tracks,
				elementType: "video",
				hoveredTrackIndex: 0,
				timeSpans: span(5, 2),
			}),
		).toBe(1);
	});

	test("leaves an audio drop on the hovered audio lane", () => {
		const tracks = mkScene({ overlay: [[]], audio: [[]] }); // audio at index 2
		expect(
			preferMainTrackIndex({
				tracks,
				elementType: "audio",
				hoveredTrackIndex: 2,
				timeSpans: span(0, 1),
			}),
		).toBe(2);
	});

	test("leaves a video drop already on the main lane untouched", () => {
		const tracks = mkScene({ overlay: [[]] }); // mainIndex = 1
		expect(
			preferMainTrackIndex({
				tracks,
				elementType: "video",
				hoveredTrackIndex: 1,
				timeSpans: span(0, 2),
			}),
		).toBe(1);
	});

	test("leaves graphic and text overlay drops untouched", () => {
		const tracks = mkScene({ overlay: [[]] });
		for (const elementType of ["graphic", "text"] as ElementType[]) {
			expect(
				preferMainTrackIndex({
					tracks,
					elementType,
					hoveredTrackIndex: 0,
					timeSpans: span(0, 2),
				}),
			).toBe(0);
		}
	});

	test("no overlay: a video drop on the main lane stays put", () => {
		const tracks = mkScene({}); // mainIndex = 0
		expect(
			preferMainTrackIndex({
				tracks,
				elementType: "video",
				hoveredTrackIndex: 0,
				timeSpans: span(0, 2),
			}),
		).toBe(0);
	});
});
