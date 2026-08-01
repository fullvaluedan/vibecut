import { describe, expect, test } from "bun:test";
import type { FrameRate } from "opencut-wasm";
import {
	collectMagnetTrimTargets,
	computeMagnetGapShifts,
	computeMagnetShrinkFloor,
	computeMagnetTrimShifts,
	liftMagnetNeighborBounds,
	magnetShrinkCeiling,
} from "@/timeline/magnet";
import {
	computeLinkedResize,
	getResizeBoundBreakdown,
	getMinDurationForFps,
} from "@/timeline/group-resize";
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
	linkId,
}: {
	id: string;
	startTime: number;
	duration: number;
	linkId?: string;
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
		...(linkId ? { linkId } : {}),
		params: {
			"transform.positionX": 0,
			"transform.positionY": 0,
			"transform.scaleX": 1,
			"transform.scaleY": 1,
			"transform.rotate": 0,
			opacity: 1,
		},
	} as VideoElement;
}

function aud({
	id,
	startTime,
	duration,
	linkId,
}: {
	id: string;
	startTime: number;
	duration: number;
	linkId?: string;
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
		...(linkId ? { linkId } : {}),
		params: {},
	} as unknown as AudioElement;
}

function buildTracks({
	main,
	overlay = [],
	audio = [],
}: {
	main: VideoElement[];
	overlay?: VideoElement[][];
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
	const overlayTracks = overlay.map(
		(elements, index) =>
			({
				id: `overlay-${index}`,
				type: "video",
				name: `V${index + 2}`,
				muted: false,
				hidden: false,
				elements,
			}) as VideoTrack,
	);
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
	return { overlay: overlayTracks, main: mainTrack, audio: audioTracks };
}

/** Three butted main clips, each with its separated audio half on A1, plus an
 * overlay title and an unlinked music bed that the magnet must never touch. */
function threeClipProject({
	main,
	audio,
}: {
	main: VideoElement[];
	audio: AudioElement[];
}): SceneTracks {
	return buildTracks({
		main,
		overlay: [[vid({ id: "title", startTime: 25 * FRAME, duration: 10 * FRAME })]],
		audio: [audio, [aud({ id: "bed", startTime: 0, duration: 40 * FRAME })]],
	});
}

const beforeThreeClips = threeClipProject({
	main: [
		vid({ id: "a", startTime: 0, duration: 10 * FRAME, linkId: "l-a" }),
		vid({ id: "b", startTime: 10 * FRAME, duration: 10 * FRAME, linkId: "l-b" }),
		vid({ id: "c", startTime: 20 * FRAME, duration: 10 * FRAME, linkId: "l-c" }),
	],
	audio: [
		aud({ id: "a-au", startTime: 0, duration: 10 * FRAME, linkId: "l-a" }),
		aud({ id: "b-au", startTime: 10 * FRAME, duration: 10 * FRAME, linkId: "l-b" }),
		aud({ id: "c-au", startTime: 20 * FRAME, duration: 10 * FRAME, linkId: "l-c" }),
	],
});

describe("computeMagnetGapShifts (main-track gap close)", () => {
	test("deleting a main clip closes the gap; its linked audio follows, overlay and the music bed stay put", () => {
		const afterTracks = threeClipProject({
			main: [
				vid({ id: "a", startTime: 0, duration: 10 * FRAME, linkId: "l-a" }),
				vid({ id: "c", startTime: 20 * FRAME, duration: 10 * FRAME, linkId: "l-c" }),
			],
			audio: [
				aud({ id: "a-au", startTime: 0, duration: 10 * FRAME, linkId: "l-a" }),
				aud({
					id: "c-au",
					startTime: 20 * FRAME,
					duration: 10 * FRAME,
					linkId: "l-c",
				}),
			],
		});

		const shifts = computeMagnetGapShifts({
			beforeTracks: beforeThreeClips,
			afterTracks,
		});

		expect(shifts).toEqual([
			{
				trackId: "main",
				elementId: "c",
				newStartTime: mediaTime({ ticks: 10 * FRAME }),
			},
			{
				trackId: "audio-0",
				elementId: "c-au",
				newStartTime: mediaTime({ ticks: 10 * FRAME }),
			},
		]);
	});

	test("dragging a main clip OUT to an overlay lane re-butts what is left", () => {
		const afterTracks = buildTracks({
			main: [
				vid({ id: "a", startTime: 0, duration: 10 * FRAME }),
				vid({ id: "c", startTime: 20 * FRAME, duration: 10 * FRAME }),
			],
			overlay: [
				[vid({ id: "b", startTime: 10 * FRAME, duration: 10 * FRAME })],
			],
		});
		const beforeTracks = buildTracks({
			main: [
				vid({ id: "a", startTime: 0, duration: 10 * FRAME }),
				vid({ id: "b", startTime: 10 * FRAME, duration: 10 * FRAME }),
				vid({ id: "c", startTime: 20 * FRAME, duration: 10 * FRAME }),
			],
			overlay: [[]],
		});

		expect(computeMagnetGapShifts({ beforeTracks, afterTracks })).toEqual([
			{
				trackId: "main",
				elementId: "c",
				newStartTime: mediaTime({ ticks: 10 * FRAME }),
			},
		]);
	});

	test("moving a main clip to a LATER main position re-butts the remainder and leaves the moved clip where it was dropped", () => {
		const beforeTracks = buildTracks({
			main: [
				vid({ id: "a", startTime: 0, duration: 10 * FRAME }),
				vid({ id: "b", startTime: 10 * FRAME, duration: 10 * FRAME }),
				vid({ id: "c", startTime: 20 * FRAME, duration: 10 * FRAME }),
			],
		});
		const afterTracks = buildTracks({
			main: [
				vid({ id: "a", startTime: 0, duration: 10 * FRAME }),
				vid({ id: "c", startTime: 20 * FRAME, duration: 10 * FRAME }),
				vid({ id: "b", startTime: 40 * FRAME, duration: 10 * FRAME }),
			],
		});

		expect(computeMagnetGapShifts({ beforeTracks, afterTracks })).toEqual([
			{
				trackId: "main",
				elementId: "c",
				newStartTime: mediaTime({ ticks: 10 * FRAME }),
			},
		]);
	});

	test("a ripple-insert between two main clips composes with the magnet (nothing shifts twice)", () => {
		const beforeTracks = buildTracks({
			main: [
				vid({ id: "a", startTime: 0, duration: 10 * FRAME }),
				vid({ id: "c", startTime: 10 * FRAME, duration: 10 * FRAME }),
			],
		});
		const afterTracks = buildTracks({
			main: [
				vid({ id: "a", startTime: 0, duration: 10 * FRAME }),
				vid({ id: "new", startTime: 10 * FRAME, duration: 10 * FRAME }),
				vid({ id: "c", startTime: 20 * FRAME, duration: 10 * FRAME }),
			],
		});

		expect(computeMagnetGapShifts({ beforeTracks, afterTracks })).toEqual([]);
	});

	test("a command that already closed its own gap (ripple delete) produces no extra shift", () => {
		const afterTracks = buildTracks({
			main: [
				vid({ id: "a", startTime: 0, duration: 10 * FRAME }),
				vid({ id: "c", startTime: 10 * FRAME, duration: 10 * FRAME }),
			],
		});
		const beforeTracks = buildTracks({
			main: [
				vid({ id: "a", startTime: 0, duration: 10 * FRAME }),
				vid({ id: "b", startTime: 10 * FRAME, duration: 10 * FRAME }),
				vid({ id: "c", startTime: 20 * FRAME, duration: 10 * FRAME }),
			],
		});

		expect(computeMagnetGapShifts({ beforeTracks, afterTracks })).toEqual([]);
	});

	test("a head trim on main pulls the trimmed clip back so it stays butted", () => {
		const beforeTracks = buildTracks({
			main: [
				vid({ id: "a", startTime: 0, duration: 10 * FRAME }),
				vid({ id: "b", startTime: 10 * FRAME, duration: 10 * FRAME }),
			],
		});
		const afterTracks = buildTracks({
			main: [
				vid({ id: "a", startTime: 0, duration: 10 * FRAME }),
				vid({ id: "b", startTime: 15 * FRAME, duration: 5 * FRAME }),
			],
		});

		expect(computeMagnetGapShifts({ beforeTracks, afterTracks })).toEqual([
			{
				trackId: "main",
				elementId: "b",
				newStartTime: mediaTime({ ticks: 10 * FRAME }),
			},
		]);
	});

	test("an edit that only touches an overlay lane never moves anything", () => {
		const afterTracks = threeClipProject({
			main: beforeThreeClips.main.elements as VideoElement[],
			audio: beforeThreeClips.audio[0].elements as AudioElement[],
		});
		afterTracks.overlay[0] = { ...afterTracks.overlay[0], elements: [] };

		expect(
			computeMagnetGapShifts({ beforeTracks: beforeThreeClips, afterTracks }),
		).toEqual([]);
	});
});

describe("collectMagnetTrimTargets (what a magnet trim moves)", () => {
	test("main-track clips at/after the pivot plus their linked audio, and nothing else", () => {
		const targets = collectMagnetTrimTargets({
			tracks: beforeThreeClips,
			pivotTime: mediaTime({ ticks: 10 * FRAME }),
			excludeElementIds: new Set(["a", "a-au"]),
		});

		expect(targets).toEqual([
			{ trackId: "main", elementId: "b", baseStartTime: mediaTime({ ticks: 10 * FRAME }) },
			{
				trackId: "audio-0",
				elementId: "b-au",
				baseStartTime: mediaTime({ ticks: 10 * FRAME }),
			},
			{ trackId: "main", elementId: "c", baseStartTime: mediaTime({ ticks: 20 * FRAME }) },
			{
				trackId: "audio-0",
				elementId: "c-au",
				baseStartTime: mediaTime({ ticks: 20 * FRAME }),
			},
		]);
		// The overlay title (25f) and the unlinked music bed both sit at/after the
		// pivot and must still be absent.
		expect(targets.map((target) => target.elementId)).not.toContain("title");
		expect(targets.map((target) => target.elementId)).not.toContain("bed");
	});
});

describe("computeMagnetTrimShifts (commit-side)", () => {
	test("extending a main clip's right edge pushes downstream main + linked audio only", () => {
		expect(
			computeMagnetTrimShifts({
				tracks: beforeThreeClips,
				pivotTime: mediaTime({ ticks: 10 * FRAME }),
				deltaTime: mediaTime({ ticks: 5 * FRAME }),
				excludeElementIds: new Set(["a", "a-au"]),
			}),
		).toEqual([
			{ trackId: "main", elementId: "b", newStartTime: mediaTime({ ticks: 15 * FRAME }) },
			{
				trackId: "audio-0",
				elementId: "b-au",
				newStartTime: mediaTime({ ticks: 15 * FRAME }),
			},
			{ trackId: "main", elementId: "c", newStartTime: mediaTime({ ticks: 25 * FRAME }) },
			{
				trackId: "audio-0",
				elementId: "c-au",
				newStartTime: mediaTime({ ticks: 25 * FRAME }),
			},
		]);
	});

	test("a zero delta commits nothing", () => {
		expect(
			computeMagnetTrimShifts({
				tracks: beforeThreeClips,
				pivotTime: mediaTime({ ticks: 10 * FRAME }),
				deltaTime: ZERO_MEDIA_TIME,
				excludeElementIds: new Set(["a", "a-au"]),
			}),
		).toEqual([]);
	});
});

describe("computeMagnetShrinkFloor", () => {
	const tracks = buildTracks({
		main: [
			vid({ id: "v", startTime: 0, duration: 20 * FRAME, linkId: "l-v" }),
			vid({ id: "v2", startTime: 20 * FRAME, duration: 10 * FRAME, linkId: "l-v2" }),
		],
		audio: [
			[
				aud({ id: "bed", startTime: 0, duration: 15 * FRAME }),
				aud({ id: "v2-au", startTime: 20 * FRAME, duration: 10 * FRAME, linkId: "l-v2" }),
			],
		],
	});

	test("an unlinked clip that stays put floors the shrink at its end", () => {
		expect(
			computeMagnetShrinkFloor({
				tracks,
				excludeElementIds: new Set(["v"]),
				shiftingElementIds: new Set(["v2", "v2-au"]),
			}),
		).toBe(mediaTime({ ticks: -5 * FRAME }));
	});

	test("nothing in the way leaves the shrink unbounded", () => {
		expect(
			computeMagnetShrinkFloor({
				tracks: buildTracks({
					main: [
						vid({ id: "v", startTime: 0, duration: 20 * FRAME }),
						vid({ id: "v2", startTime: 20 * FRAME, duration: 10 * FRAME }),
					],
				}),
				excludeElementIds: new Set(["v"]),
				shiftingElementIds: new Set(["v2"]),
			}),
		).toBeNull();
	});

	test("the left-handle ceiling is the same headroom with the opposite sign", () => {
		expect(magnetShrinkCeiling(mediaTime({ ticks: -5 * FRAME }))).toBe(
			mediaTime({ ticks: 5 * FRAME }),
		);
		expect(magnetShrinkCeiling(null)).toBeNull();
	});
});

describe("liftMagnetNeighborBounds", () => {
	const member = (overrides: Partial<GroupResizeMember>): GroupResizeMember => ({
		trackId: "main",
		elementId: "v",
		startTime: mediaTime({ ticks: 10 * FRAME }),
		duration: mediaTime({ ticks: 10 * FRAME }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		leftNeighborBound: mediaTime({ ticks: 10 * FRAME }),
		rightNeighborBound: mediaTime({ ticks: 20 * FRAME }),
		...overrides,
	});

	test("a right-handle bound is lifted only when that exact neighbor shifts", () => {
		const neighbors = new Map([["v", { left: null, right: "next" }]]);

		expect(
			liftMagnetNeighborBounds({
				members: [member({})],
				side: "right",
				shiftingElementIds: new Set(["next"]),
				neighborElementIds: neighbors,
			})[0].rightNeighborBound,
		).toBeNull();

		// Same neighbor, but it is an overlay clip the magnet never moves.
		expect(
			liftMagnetNeighborBounds({
				members: [member({})],
				side: "right",
				shiftingElementIds: new Set(),
				neighborElementIds: neighbors,
			})[0].rightNeighborBound,
		).toBe(mediaTime({ ticks: 20 * FRAME }));
	});

	test("a left-handle magnet trim pins the start, so the left bound is lifted outright", () => {
		const lifted = liftMagnetNeighborBounds({
			members: [member({})],
			side: "left",
			shiftingElementIds: new Set(),
			neighborElementIds: new Map(),
		})[0];

		expect(lifted.leftBoundLifted).toBe(true);
		expect(lifted.rightNeighborBound).toBe(mediaTime({ ticks: 20 * FRAME }));
	});
});

describe("clamp reason under the magnet (T15.3 feedback stays honest)", () => {
	const buttedClip: GroupResizeMember = {
		trackId: "main",
		elementId: "v",
		startTime: mediaTime({ ticks: 10 * FRAME }),
		duration: mediaTime({ ticks: 10 * FRAME }),
		trimStart: mediaTime({ ticks: 5 * FRAME }),
		trimEnd: ZERO_MEDIA_TIME,
		sourceDuration: mediaTime({ ticks: 15 * FRAME }),
		sourceDurationRequired: true,
		leftNeighborBound: mediaTime({ ticks: 10 * FRAME }),
		rightNeighborBound: null,
	};
	const minDuration = getMinDurationForFps(FPS);

	test("magnet OFF: the butted left neighbor is the wall", () => {
		const breakdown = getResizeBoundBreakdown({
			member: buttedClip,
			side: "left",
			minDuration,
		});
		expect(breakdown.minimum).toBe(ZERO_MEDIA_TIME);
		expect(breakdown.minimumReason).toBe("neighbor");
	});

	test("magnet ON: the lifted bound makes the real limit the source head", () => {
		const breakdown = getResizeBoundBreakdown({
			member: { ...buttedClip, leftBoundLifted: true },
			side: "left",
			minDuration,
		});
		expect(breakdown.minimum).toBe(mediaTime({ ticks: -5 * FRAME }));
		expect(breakdown.minimumReason).toBe("source-limit");
	});
});

describe("computeLinkedResize with the magnet's left-handle ceiling", () => {
	const member: GroupResizeMember = {
		trackId: "main",
		elementId: "v",
		startTime: mediaTime({ ticks: 10 * FRAME }),
		duration: mediaTime({ ticks: 10 * FRAME }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		leftNeighborBound: mediaTime({ ticks: 10 * FRAME }),
		rightNeighborBound: null,
		leftBoundLifted: true,
	};

	test("a head trim is capped by the straddler headroom the tail would eat", () => {
		const result = computeLinkedResize({
			members: [member],
			side: "left",
			deltaTime: mediaTime({ ticks: 8 * FRAME }),
			fps: FPS,
			rippleTrim: {
				shrinkFloorDelta: null,
				shrinkCeilingDelta: mediaTime({ ticks: 3 * FRAME }),
			},
		});

		expect(result.deltaTime).toBe(mediaTime({ ticks: 3 * FRAME }));
	});

	test("without a ceiling the same drag is limited only by the clip itself", () => {
		const result = computeLinkedResize({
			members: [member],
			side: "left",
			deltaTime: mediaTime({ ticks: 8 * FRAME }),
			fps: FPS,
		});

		expect(result.deltaTime).toBe(mediaTime({ ticks: 8 * FRAME }));
	});
});
