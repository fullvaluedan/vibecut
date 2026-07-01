import { describe, expect, test } from "bun:test";
import type { FrameRate } from "opencut-wasm";
import { computeGroupResize } from "@/timeline/group-resize";
import type { GroupResizeMember } from "@/timeline/group-resize";
import { buildResizeMembers } from "@/timeline/controllers/resize-controller";
import type { SceneTracks, VideoElement, VideoTrack } from "@/timeline";
import { mediaTime, ZERO_MEDIA_TIME } from "@/wasm";

// 30fps => 1 frame = 120_000 / 30 = 4_000 ticks. Deltas below are frame-aligned
// multiples of 4_000 so the frame-rounding is a no-op and the math is exact.
const FPS: FrameRate = { numerator: 30, denominator: 1 };
const FRAME = 4_000;

function member(
	overrides: Partial<GroupResizeMember> & { elementId: string },
): GroupResizeMember {
	return {
		trackId: "track-1",
		startTime: mediaTime({ ticks: 10 * FRAME }),
		duration: mediaTime({ ticks: 10 * FRAME }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		sourceDuration: undefined,
		retime: undefined,
		leftNeighborBound: null,
		rightNeighborBound: null,
		...overrides,
	};
}

describe("computeGroupResize (characterization)", () => {
	test("a single member returns exactly one update", () => {
		const result = computeGroupResize({
			members: [member({ elementId: "a" })],
			side: "right",
			deltaTime: mediaTime({ ticks: 2 * FRAME }),
			fps: FPS,
		});
		expect(result.updates).toHaveLength(1);
		expect(result.updates[0].elementId).toBe("a");
		expect(result.updates[0].patch.duration).toBe(12 * FRAME);
		expect(result.updates[0].patch.startTime).toBe(10 * FRAME);
	});

	test("single-member right resize is clamped only by its own source limit", () => {
		// Clip shows 10 frames of a 12-frame source (trimEnd = 2 frames of source).
		// Right-extend by 5 frames: source ceiling caps at +2 frames.
		const result = computeGroupResize({
			members: [
				member({
					elementId: "a",
					sourceDuration: mediaTime({ ticks: 12 * FRAME }),
					trimEnd: mediaTime({ ticks: 2 * FRAME }),
				}),
			],
			side: "right",
			deltaTime: mediaTime({ ticks: 5 * FRAME }),
			fps: FPS,
		});
		expect(result.deltaTime).toBe(2 * FRAME);
		expect(result.updates[0].patch.duration).toBe(12 * FRAME);
	});

	test("a shorter OTHER member's limit does NOT constrain the grabbed clip when it resizes alone", () => {
		// The grabbed clip 'a' has 5 frames of source headroom. A different clip
		// 'b' with only 1 frame of headroom is NOT in this (single-member) session,
		// so 'a' extends its full +3 frames.
		const grabbedAlone = computeGroupResize({
			members: [
				member({
					elementId: "a",
					sourceDuration: mediaTime({ ticks: 15 * FRAME }),
					trimEnd: mediaTime({ ticks: 5 * FRAME }),
				}),
			],
			side: "right",
			deltaTime: mediaTime({ ticks: 3 * FRAME }),
			fps: FPS,
		});
		expect(grabbedAlone.deltaTime).toBe(3 * FRAME);

		// Same drag with the tight clip 'b' ALSO in the group clamps to +1 frame —
		// this is the group-resize fan-out behavior U2's controller change avoids.
		const asGroup = computeGroupResize({
			members: [
				member({
					elementId: "a",
					sourceDuration: mediaTime({ ticks: 15 * FRAME }),
					trimEnd: mediaTime({ ticks: 5 * FRAME }),
				}),
				member({
					elementId: "b",
					sourceDuration: mediaTime({ ticks: 11 * FRAME }),
					trimEnd: mediaTime({ ticks: 1 * FRAME }),
				}),
			],
			side: "right",
			deltaTime: mediaTime({ ticks: 3 * FRAME }),
			fps: FPS,
		});
		expect(asGroup.deltaTime).toBe(1 * FRAME);
		expect(asGroup.updates).toHaveLength(2);
	});

	test("left handle resizes only the grabbed clip", () => {
		const result = computeGroupResize({
			members: [member({ elementId: "a" })],
			side: "left",
			deltaTime: mediaTime({ ticks: 2 * FRAME }),
			fps: FPS,
		});
		expect(result.updates).toHaveLength(1);
		// left-trim by +2 frames: start moves right, duration shrinks.
		expect(result.updates[0].patch.startTime).toBe(12 * FRAME);
		expect(result.updates[0].patch.duration).toBe(8 * FRAME);
	});
});

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

describe("buildResizeMembers (U2 single-clip trim)", () => {
	// Two clips on one track, both selected. Grabbing clip 'a' with only 'a' in
	// the ref list (what onResizeStart now always passes) builds a ONE-member
	// session, and the other selected clip 'b' becomes a neighbor BOUND, not a
	// group member.
	const track: VideoTrack = {
		id: "video-main",
		type: "video",
		name: "video-main",
		muted: false,
		hidden: false,
		elements: [
			buildVideoElement({ id: "a", startTime: 0, duration: 5 }),
			buildVideoElement({ id: "b", startTime: 5, duration: 5 }),
		],
	};
	const tracks: SceneTracks = { overlay: [], main: track, audio: [] };

	test("a single grabbed ref builds exactly one member", () => {
		const members = buildResizeMembers({
			tracks,
			selectedElements: [{ trackId: "video-main", elementId: "a" }],
		});
		expect(members).toHaveLength(1);
		expect(members[0].elementId).toBe("a");
	});

	test("the other clip on the track is a neighbor bound, not a member", () => {
		const members = buildResizeMembers({
			tracks,
			selectedElements: [{ trackId: "video-main", elementId: "a" }],
		});
		// 'b' starts at tick 5 and sits to the right of 'a' (ends at 5), so it
		// bounds a's right edge — it is not resized alongside 'a'.
		expect(members[0].rightNeighborBound).toBe(mediaTime({ ticks: 5 }));
	});
});
