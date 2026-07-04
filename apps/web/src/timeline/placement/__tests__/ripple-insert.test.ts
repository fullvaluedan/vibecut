import { describe, expect, test } from "bun:test";
import type { TimelineElement, VideoElement } from "@/timeline";
import { computeRippleInsertShifts } from "@/timeline/placement/ripple-insert";
import { mediaTime, ZERO_MEDIA_TIME } from "@/wasm";

function clip({
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

// [a: 0..10][b: 10..20][c: 20..30]
const threeClips: TimelineElement[] = [
	clip({ id: "a", startTime: 0, duration: 10 }),
	clip({ id: "b", startTime: 10, duration: 10 }),
	clip({ id: "c", startTime: 20, duration: 10 }),
];

describe("computeRippleInsertShifts", () => {
	test("insert between clip 1 and 2 shifts clips 2 and 3, clip 1 unchanged", () => {
		const shifts = computeRippleInsertShifts({
			elements: threeClips,
			insertStart: mediaTime({ ticks: 10 }),
			shiftDuration: mediaTime({ ticks: 5 }),
		});
		expect(shifts).toEqual([
			{ id: "b", startTime: mediaTime({ ticks: 15 }) },
			{ id: "c", startTime: mediaTime({ ticks: 25 }) },
		]);
	});

	test("insert before all clips shifts all", () => {
		const shifts = computeRippleInsertShifts({
			elements: threeClips,
			insertStart: ZERO_MEDIA_TIME,
			shiftDuration: mediaTime({ ticks: 4 }),
		});
		expect(shifts.map((s) => s.id)).toEqual(["a", "b", "c"]);
		expect(shifts.map((s) => s.startTime)).toEqual([
			mediaTime({ ticks: 4 }),
			mediaTime({ ticks: 14 }),
			mediaTime({ ticks: 24 }),
		]);
	});

	test("insert after all clips shifts nothing (plain append)", () => {
		const shifts = computeRippleInsertShifts({
			elements: threeClips,
			insertStart: mediaTime({ ticks: 30 }),
			shiftDuration: mediaTime({ ticks: 5 }),
		});
		expect(shifts).toEqual([]);
	});

	test("insert exactly on a clip's start shifts that clip and all after (>= boundary)", () => {
		const shifts = computeRippleInsertShifts({
			elements: threeClips,
			insertStart: mediaTime({ ticks: 20 }),
			shiftDuration: mediaTime({ ticks: 5 }),
		});
		expect(shifts).toEqual([{ id: "c", startTime: mediaTime({ ticks: 25 }) }]);
	});

	test("empty track yields no shifts", () => {
		expect(
			computeRippleInsertShifts({
				elements: [],
				insertStart: ZERO_MEDIA_TIME,
				shiftDuration: mediaTime({ ticks: 5 }),
			}),
		).toEqual([]);
	});

	test("only elements at/after the insert point shift; earlier ones untouched", () => {
		// The controller sets insertStart at a clip boundary. An insert point that
		// falls between b's start (10) and its end pushes only elements whose START
		// is >= the point; b (start 10 < 12) stays put, c (start 20 >= 12) shifts.
		// Lossless: nothing is trimmed.
		const shifts = computeRippleInsertShifts({
			elements: threeClips,
			insertStart: mediaTime({ ticks: 12 }),
			shiftDuration: mediaTime({ ticks: 5 }),
		});
		expect(shifts).toEqual([{ id: "c", startTime: mediaTime({ ticks: 25 }) }]);
	});

	test("a zero shift is a no-op", () => {
		expect(
			computeRippleInsertShifts({
				elements: threeClips,
				insertStart: ZERO_MEDIA_TIME,
				shiftDuration: ZERO_MEDIA_TIME,
			}),
		).toEqual([]);
	});
});
