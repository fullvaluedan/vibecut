import { describe, expect, test } from "bun:test";
import type { ElementType, SceneTracks } from "@/timeline";
import type { PlacementTimeSpan } from "@/timeline/placement";
import { preferMainTrackIndex } from "../prefer-main-track";

// `preferMainTrackIndex` only reads `tracks.overlay.length`,
// `tracks.main.elements`, and span start/duration as numbers. MediaTime is a
// branded number whose constructor lives in `@/wasm` (which fails to init under
// bun), so fixtures are built as plain objects and cast at the boundary.
type El = { startTime: number; duration: number };

function mkTrack({
	id,
	type,
	elements,
}: {
	id: string;
	type: string;
	elements: El[];
}) {
	return { id, type, name: id, elements };
}

function mkScene(opts: {
	overlay?: El[][];
	main?: El[];
	audio?: El[][];
}): SceneTracks {
	const scene: unknown = {
		overlay: (opts.overlay ?? []).map((elements, i) =>
			mkTrack({ id: `overlay-${i}`, type: "video", elements }),
		),
		main: mkTrack({ id: "video-main", type: "video", elements: opts.main ?? [] }),
		audio: (opts.audio ?? []).map((elements, i) =>
			mkTrack({ id: `audio-${i}`, type: "audio", elements }),
		),
	};
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- branded-MediaTime fixture (see note above); the real constructor lives in @/wasm, unusable under bun
	return scene as SceneTracks;
}

function spans({
	startTime,
	duration,
}: {
	startTime: number;
	duration: number;
}): PlacementTimeSpan[] {
	const list: unknown = [{ startTime, duration }];
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- branded-MediaTime fixture (see note above); the real constructor lives in @/wasm, unusable under bun
	return list as PlacementTimeSpan[];
}

describe("preferMainTrackIndex", () => {
	test("redirects a video drop from a free overlay lane to main (V1)", () => {
		const tracks = mkScene({ overlay: [[]] }); // mainIndex = 1
		expect(
			preferMainTrackIndex({
				tracks,
				elementType: "video",
				hoveredTrackIndex: 0,
				timeSpans: spans({ startTime: 3, duration: 2 }),
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
				timeSpans: spans({ startTime: 0, duration: 5 }),
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
				timeSpans: spans({ startTime: 3, duration: 2 }),
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
				timeSpans: spans({ startTime: 5, duration: 2 }),
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
				timeSpans: spans({ startTime: 0, duration: 1 }),
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
				timeSpans: spans({ startTime: 0, duration: 2 }),
			}),
		).toBe(1);
	});

	test("leaves graphic and text overlay drops untouched", () => {
		const tracks = mkScene({ overlay: [[]] });
		const overlayTypes: ElementType[] = ["graphic", "text"];
		for (const elementType of overlayTypes) {
			expect(
				preferMainTrackIndex({
					tracks,
					elementType,
					hoveredTrackIndex: 0,
					timeSpans: spans({ startTime: 0, duration: 2 }),
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
				timeSpans: spans({ startTime: 0, duration: 2 }),
			}),
		).toBe(0);
	});
});
