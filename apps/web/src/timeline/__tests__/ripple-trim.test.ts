import { describe, expect, test } from "bun:test";
import type { FrameRate } from "opencut-wasm";
import {
	computeRippleShrinkFloor,
	computeRippleTrimShifts,
	liftShiftingNeighborBounds,
} from "@/timeline/ripple-trim";
import { computeLinkedResize } from "@/timeline/group-resize";
import type { GroupResizeMember } from "@/timeline/group-resize";
import type {
	AudioElement,
	AudioTrack,
	SceneTracks,
	VideoElement,
	VideoTrack,
} from "@/timeline";
import { mediaTime, ZERO_MEDIA_TIME } from "@/wasm";

// 30fps under the test wasm mock: 1 frame = 4_000 ticks.
const FPS: FrameRate = { numerator: 30, denominator: 1 };
const FRAME = 4_000;

function vid({
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

function aud({
	id,
	startTime,
	duration,
}: {
	id: string;
	startTime: number;
	duration: number;
}): AudioElement {
	return {
		id,
		type: "audio",
		name: id,
		startTime: mediaTime({ ticks: startTime }),
		duration: mediaTime({ ticks: duration }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		sourceType: "upload",
		mediaId: `media-${id}`,
		params: {},
	} as unknown as AudioElement;
}

function buildTracks({
	main,
	audio = [],
}: {
	main: VideoElement[];
	audio?: AudioElement[][];
}): SceneTracks {
	const mainTrack: VideoTrack = {
		id: "main",
		type: "video",
		name: "V1",
		muted: false,
		hidden: false,
		elements: main,
	};
	const audioTracks = audio.map(
		(elements, index) =>
			({
				id: `audio-${index}`,
				type: "audio",
				name: `A${index + 1}`,
				muted: false,
				elements,
			}) as unknown as AudioTrack,
	);
	return { overlay: [], main: mainTrack, audio: audioTracks };
}

describe("computeRippleTrimShifts (cross-track, Dan's fork)", () => {
	// Grabbed clip v [0, 20) on main; downstream on BOTH tracks; a straddler on
	// the audio track spans the pivot.
	const tracks = buildTracks({
		main: [
			vid({ id: "v", startTime: 0, duration: 20 * FRAME }),
			vid({ id: "v2", startTime: 20 * FRAME, duration: 10 * FRAME }),
			vid({ id: "v3", startTime: 40 * FRAME, duration: 10 * FRAME }),
		],
		audio: [
			[
				aud({ id: "bed", startTime: 10 * FRAME, duration: 20 * FRAME }), // straddles 20
				aud({ id: "a2", startTime: 35 * FRAME, duration: 10 * FRAME }),
			],
		],
	});
	const exclude = new Set(["v"]);

	test("an extend shifts every downstream element on ALL tracks right by the delta", () => {
		const shifts = computeRippleTrimShifts({
			tracks,
			pivotTime: mediaTime({ ticks: 20 * FRAME }),
			deltaTime: mediaTime({ ticks: 5 * FRAME }),
			excludeElementIds: exclude,
		});
		expect(shifts).toEqual([
			{ trackId: "main", elementId: "v2", newStartTime: 25 * FRAME },
			{ trackId: "main", elementId: "v3", newStartTime: 45 * FRAME },
			{ trackId: "audio-0", elementId: "a2", newStartTime: 40 * FRAME },
		]);
	});

	test("a shrink shifts them left; a straddler never moves", () => {
		const shifts = computeRippleTrimShifts({
			tracks,
			pivotTime: mediaTime({ ticks: 20 * FRAME }),
			deltaTime: mediaTime({ ticks: -3 * FRAME }),
			excludeElementIds: exclude,
		});
		expect(shifts.map((shift) => shift.elementId)).toEqual(["v2", "v3", "a2"]);
		expect(shifts[0].newStartTime).toBe(17 * FRAME);
		expect(shifts.some((shift) => shift.elementId === "bed")).toBe(false);
	});

	test("resized members are excluded; zero delta shifts nothing", () => {
		const withMemberDownstream = computeRippleTrimShifts({
			tracks,
			pivotTime: mediaTime({ ticks: 20 * FRAME }),
			deltaTime: mediaTime({ ticks: FRAME }),
			excludeElementIds: new Set(["v", "v2", "a2"]),
		});
		expect(withMemberDownstream.map((shift) => shift.elementId)).toEqual(["v3"]);
		expect(
			computeRippleTrimShifts({
				tracks,
				pivotTime: mediaTime({ ticks: 20 * FRAME }),
				deltaTime: ZERO_MEDIA_TIME,
				excludeElementIds: exclude,
			}),
		).toEqual([]);
	});
});

describe("computeRippleShrinkFloor", () => {
	test("no downstream elements = unbounded (null)", () => {
		const tracks = buildTracks({
			main: [vid({ id: "v", startTime: 0, duration: 20 * FRAME })],
		});
		expect(
			computeRippleShrinkFloor({
				tracks,
				pivotTime: mediaTime({ ticks: 20 * FRAME }),
				excludeElementIds: new Set(["v"]),
			}),
		).toBeNull();
	});

	test("a straddler with downstream on its track floors the shrink at the gap", () => {
		// Audio bed [10, 30) straddles the pivot 20; a2 starts at 35: 5 frames of
		// headroom, so the shrink floors at -5 frames.
		const tracks = buildTracks({
			main: [
				vid({ id: "v", startTime: 0, duration: 20 * FRAME }),
				vid({ id: "v2", startTime: 20 * FRAME, duration: 10 * FRAME }),
			],
			audio: [
				[
					aud({ id: "bed", startTime: 10 * FRAME, duration: 20 * FRAME }),
					aud({ id: "a2", startTime: 35 * FRAME, duration: 10 * FRAME }),
				],
			],
		});
		expect(
			computeRippleShrinkFloor({
				tracks,
				pivotTime: mediaTime({ ticks: 20 * FRAME }),
				excludeElementIds: new Set(["v"]),
			}),
		).toBe(-5 * FRAME);
	});

	test("a butted straddler blocks the shrink entirely (floor 0)", () => {
		const tracks = buildTracks({
			main: [vid({ id: "v", startTime: 0, duration: 20 * FRAME })],
			audio: [
				[
					aud({ id: "bed", startTime: 10 * FRAME, duration: 20 * FRAME }),
					aud({ id: "a2", startTime: 30 * FRAME, duration: 10 * FRAME }),
				],
			],
		});
		expect(
			computeRippleShrinkFloor({
				tracks,
				pivotTime: mediaTime({ ticks: 20 * FRAME }),
				excludeElementIds: new Set(["v"]),
			}),
		).toBe(0);
	});

	test("the grabbed track's own neighbor chain never binds (members excluded)", () => {
		// v2 butts v at the pivot: it shifts in step with v's new end, so the
		// only constrained track must be none here.
		const tracks = buildTracks({
			main: [
				vid({ id: "v", startTime: 0, duration: 20 * FRAME }),
				vid({ id: "v2", startTime: 20 * FRAME, duration: 10 * FRAME }),
			],
		});
		expect(
			computeRippleShrinkFloor({
				tracks,
				pivotTime: mediaTime({ ticks: 20 * FRAME }),
				excludeElementIds: new Set(["v"]),
			}),
		).toBeNull();
	});
});

describe("liftShiftingNeighborBounds", () => {
	const base: GroupResizeMember = {
		trackId: "main",
		elementId: "v",
		startTime: mediaTime({ ticks: 0 }),
		duration: mediaTime({ ticks: 20 * FRAME }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		sourceDuration: undefined,
		retime: undefined,
		leftNeighborBound: null,
		rightNeighborBound: null,
	};

	test("a neighbor at/after the pivot shifts with the ripple: bound lifted", () => {
		const [lifted] = liftShiftingNeighborBounds({
			members: [
				{ ...base, rightNeighborBound: mediaTime({ ticks: 20 * FRAME }) },
			],
			pivotTime: mediaTime({ ticks: 20 * FRAME }),
		});
		expect(lifted.rightNeighborBound).toBeNull();
	});

	test("a neighbor parked before the pivot stays put and still binds", () => {
		// A shorter linked partner (ends at 15) with a clip at 15: that clip does
		// NOT shift (starts before the pivot 20), so the partner must stay
		// clamped or it would extend onto it.
		const partner: GroupResizeMember = {
			...base,
			elementId: "a",
			trackId: "audio-0",
			duration: mediaTime({ ticks: 15 * FRAME }),
			rightNeighborBound: mediaTime({ ticks: 15 * FRAME }),
		};
		const [kept] = liftShiftingNeighborBounds({
			members: [partner],
			pivotTime: mediaTime({ ticks: 20 * FRAME }),
		});
		expect(kept.rightNeighborBound).toBe(15 * FRAME);
	});
});

describe("computeLinkedResize with rippleTrim", () => {
	const member = (
		overrides: Partial<GroupResizeMember> & { elementId: string },
	): GroupResizeMember => ({
		trackId: "main",
		startTime: mediaTime({ ticks: 0 }),
		duration: mediaTime({ ticks: 20 * FRAME }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		sourceDuration: undefined,
		retime: undefined,
		leftNeighborBound: null,
		rightNeighborBound: null,
		...overrides,
	});

	test("an extend past a lifted neighbor is bounded by source extent only", () => {
		// 25 frames of source, 20 shown: +5 frames max even though the drag asks
		// for +10 (the old neighbor ceiling is gone; the source ceiling stays).
		const result = computeLinkedResize({
			members: [
				member({
					elementId: "v",
					sourceDuration: mediaTime({ ticks: 25 * FRAME }),
					trimEnd: mediaTime({ ticks: 5 * FRAME }),
				}),
			],
			side: "right",
			deltaTime: mediaTime({ ticks: 10 * FRAME }),
			fps: FPS,
			rippleTrim: { shrinkFloorDelta: null },
		});
		expect(result.deltaTime).toBe(5 * FRAME);
	});

	test("the shrink floor clamps a ripple shrink", () => {
		const result = computeLinkedResize({
			members: [member({ elementId: "v" })],
			side: "right",
			deltaTime: mediaTime({ ticks: -10 * FRAME }),
			fps: FPS,
			rippleTrim: { shrinkFloorDelta: mediaTime({ ticks: -4 * FRAME }) },
		});
		expect(result.deltaTime).toBe(-4 * FRAME);
	});

	test("without rippleTrim the shrink is bounded by minimum duration as before", () => {
		const result = computeLinkedResize({
			members: [member({ elementId: "v" })],
			side: "right",
			deltaTime: mediaTime({ ticks: -30 * FRAME }),
			fps: FPS,
		});
		// duration 20 frames, minimum 1 frame: max shrink -19 frames.
		expect(result.deltaTime).toBe(-19 * FRAME);
	});
});
