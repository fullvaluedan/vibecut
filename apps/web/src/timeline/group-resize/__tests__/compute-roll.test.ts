import { describe, expect, mock, test } from "bun:test";
import type {
	SceneTracks,
	VideoElement,
	VideoTrack,
} from "@/timeline";
import type { GroupResizeMember } from "../types";
import type { MediaTime } from "@/wasm";

// `compute-roll` (via the `@/timeline` barrel and `@/wasm`) transitively reaches
// `opencut-wasm`, whose top-level binary init fails under `bun test`. Stub the
// whole `@/wasm` surface with pure JS shims so the import graph resolves without
// the binary. `mediaTime` passes the tick count through and `ZERO_MEDIA_TIME` is
// 0, so the glue's tick math and the EMPTY sentinel stay observable. (`MediaTime`
// is a type-only import, erased at runtime.) The stub MUST be registered before
// any real module that touches `@/wasm` is imported, so the production modules
// below are pulled in via `await import` after this call.
mock.module("@/wasm", () => {
	const identity = ({ ticks }: { ticks: number }) => ticks;
	const passTime = <T extends { time?: number }>(args: T) => args.time ?? 0;
	return {
		TICKS_PER_SECOND: 1_000_000,
		ZERO_MEDIA_TIME: 0,
		mediaTime: identity,
		roundMediaTime: ({ time }: { time: number }) => Math.round(time),
		mediaTimeFromSeconds: ({ seconds }: { seconds: number }) =>
			Math.round(seconds * 1_000_000),
		mediaTimeToSeconds: ({ time }: { time: number }) => time / 1_000_000,
		addMediaTime: ({ a, b }: { a: number; b: number }) => a + b,
		subMediaTime: ({ a, b }: { a: number; b: number }) => a - b,
		maxMediaTime: ({ a, b }: { a: number; b: number }) => Math.max(a, b),
		minMediaTime: ({ a, b }: { a: number; b: number }) => Math.min(a, b),
		clampMediaTime: ({
			time,
			min,
			max,
		}: {
			time: number;
			min: number;
			max: number;
		}) => Math.min(Math.max(time, min), max),
		roundFrameTime: passTime,
		roundFrameTicks: ({ ticks }: { ticks: number }) => ticks,
		snapSeekMediaTime: passTime,
		lastFrameMediaTime: ({ duration }: { duration: number }) => duration,
		parseMediaTimecode: () => null,
	};
});

const { computeGroupRoll } = await import("../compute-roll");

// Mint a branded MediaTime via a type guard (mirroring the duplicate-track test)
// so the plain-tick fixtures need no `as` cast and never import the `@/wasm`
// runtime.
function isMediaTime(value: number): value is MediaTime {
	return Number.isInteger(value);
}
function ticks(n: number): MediaTime {
	if (!isMediaTime(n)) {
		throw new Error(`ticks(): expected an integer, got ${n}`);
	}
	return n;
}

function videoElement({
	id,
	startTime,
	duration,
	trimStart,
	trimEnd,
	sourceDuration,
}: {
	id: string;
	startTime: number;
	duration: number;
	trimStart: number;
	trimEnd: number;
	sourceDuration: number | undefined;
}): VideoElement {
	return {
		id,
		name: `clip ${id}`,
		type: "video",
		mediaId: `media-${id}`,
		startTime: ticks(startTime),
		duration: ticks(duration),
		trimStart: ticks(trimStart),
		trimEnd: ticks(trimEnd),
		...(sourceDuration === undefined
			? {}
			: { sourceDuration: ticks(sourceDuration) }),
		params: { opacity: 1 },
	};
}

function videoTrack({
	id,
	elements,
}: {
	id: string;
	elements: VideoElement[];
}): VideoTrack {
	return {
		id,
		name: "Video 1",
		type: "video",
		hidden: false,
		muted: false,
		elements,
	};
}

function sceneTracks({ main }: { main: VideoTrack }): SceneTracks {
	return {
		main,
		overlay: [],
		audio: [],
	};
}

function member({
	trackId,
	elementId,
}: {
	trackId: string;
	elementId: string;
}): GroupResizeMember {
	// The glue only reads `trackId` / `elementId`; the remaining bounds are
	// required by the type but unused on the roll path.
	return {
		trackId,
		elementId,
		startTime: ticks(0),
		duration: ticks(0),
		trimStart: ticks(0),
		trimEnd: ticks(0),
		leftNeighborBound: null,
		rightNeighborBound: null,
	};
}

// An adjacent pair on the main track: A (start 0, dur 100) ends exactly where
// B (start 100, dur 100) begins, so the cut between them is rollable.
function adjacentPairTrack(): VideoTrack {
	return videoTrack({
		id: "track-1",
		elements: [
			videoElement({
				id: "A",
				startTime: 0,
				duration: 100,
				trimStart: 5,
				trimEnd: 20,
				sourceDuration: 125,
			}),
			videoElement({
				id: "B",
				startTime: 100,
				duration: 100,
				trimStart: 10,
				trimEnd: 15,
				sourceDuration: 125,
			}),
		],
	});
}

describe("computeGroupRoll", () => {
	test("(a) returns EMPTY for an unknown trackId", () => {
		const result = computeGroupRoll({
			members: [member({ trackId: "missing", elementId: "A" })],
			tracks: sceneTracks({ main: adjacentPairTrack() }),
			side: "right",
			deltaTime: ticks(10),
			minDuration: ticks(1),
		});
		expect(result.updates).toEqual([]);
	});

	test("(b) RIGHT edge: A = dragged, B = the clip starting at its end", () => {
		const result = computeGroupRoll({
			members: [member({ trackId: "track-1", elementId: "A" })],
			tracks: sceneTracks({ main: adjacentPairTrack() }),
			side: "right",
			deltaTime: ticks(10),
			minDuration: ticks(1),
		});

		expect(result.updates).toHaveLength(2);
		const [updateA, updateB] = result.updates;

		// A is the dragged clip; it grows from its tail (+10) and gives up trimEnd.
		expect(updateA.elementId).toBe("A");
		expect(updateA.patch.startTime).toBe(ticks(0));
		expect(updateA.patch.duration).toBe(ticks(110));
		expect(updateA.patch.trimStart).toBe(ticks(5));
		expect(updateA.patch.trimEnd).toBe(ticks(10));

		// B is the neighbor; its head moves right (+10) and it takes on trimStart.
		expect(updateB.elementId).toBe("B");
		expect(updateB.patch.startTime).toBe(ticks(110));
		expect(updateB.patch.duration).toBe(ticks(90));
		expect(updateB.patch.trimStart).toBe(ticks(20));
		expect(updateB.patch.trimEnd).toBe(ticks(15));
	});

	test("(c) LEFT edge: B = dragged, A = the clip ending at its start", () => {
		const result = computeGroupRoll({
			members: [member({ trackId: "track-1", elementId: "B" })],
			tracks: sceneTracks({ main: adjacentPairTrack() }),
			side: "left",
			deltaTime: ticks(10),
			minDuration: ticks(1),
		});

		expect(result.updates).toHaveLength(2);
		const [updateA, updateB] = result.updates;

		// A is the neighbor (ends where the dragged clip starts); B is dragged.
		expect(updateA.elementId).toBe("A");
		expect(updateB.elementId).toBe("B");
		// Same cut motion as the right-edge case: A grows, B shrinks.
		expect(updateA.patch.duration).toBe(ticks(110));
		expect(updateB.patch.startTime).toBe(ticks(110));
		expect(updateB.patch.duration).toBe(ticks(90));
	});

	test("(d) returns EMPTY when there is no adjacent clip on the dragged side", () => {
		const lonely = videoTrack({
			id: "track-1",
			elements: [
				videoElement({
					id: "A",
					startTime: 0,
					duration: 100,
					trimStart: 5,
					trimEnd: 20,
					sourceDuration: 125,
				}),
			],
		});
		const result = computeGroupRoll({
			members: [member({ trackId: "track-1", elementId: "A" })],
			tracks: sceneTracks({ main: lonely }),
			side: "right",
			deltaTime: ticks(10),
			minDuration: ticks(1),
		});
		expect(result.updates).toEqual([]);
	});

	test("(e) returns EMPTY when a clip's sourceDuration is undefined", () => {
		const track = videoTrack({
			id: "track-1",
			elements: [
				videoElement({
					id: "A",
					startTime: 0,
					duration: 100,
					trimStart: 5,
					trimEnd: 20,
					sourceDuration: undefined,
				}),
				videoElement({
					id: "B",
					startTime: 100,
					duration: 100,
					trimStart: 10,
					trimEnd: 15,
					sourceDuration: 125,
				}),
			],
		});
		const result = computeGroupRoll({
			members: [member({ trackId: "track-1", elementId: "A" })],
			tracks: sceneTracks({ main: track }),
			side: "right",
			deltaTime: ticks(10),
			minDuration: ticks(1),
		});
		expect(result.updates).toEqual([]);
	});

	test("(f) returns EMPTY for a no-op roll (zero clamped delta)", () => {
		const result = computeGroupRoll({
			members: [member({ trackId: "track-1", elementId: "A" })],
			tracks: sceneTracks({ main: adjacentPairTrack() }),
			side: "right",
			deltaTime: ticks(0),
			minDuration: ticks(1),
		});
		expect(result.updates).toEqual([]);
	});
});
