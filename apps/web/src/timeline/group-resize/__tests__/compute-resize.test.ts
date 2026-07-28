import { describe, expect, test } from "bun:test";
import type { FrameRate } from "opencut-wasm";
import { computeLinkedResize, computeResize } from "@/timeline/group-resize";
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

describe("computeResize (single grabbed clip)", () => {
	test("returns exactly one update for the grabbed clip", () => {
		const result = computeResize({
			member: member({ elementId: "a" }),
			side: "right",
			deltaTime: mediaTime({ ticks: 2 * FRAME }),
			fps: FPS,
		});
		expect(result.updates).toHaveLength(1);
		expect(result.updates[0].elementId).toBe("a");
		expect(result.updates[0].patch.duration).toBe(12 * FRAME);
		expect(result.updates[0].patch.startTime).toBe(10 * FRAME);
	});

	test("right resize is clamped only by its own source limit", () => {
		// Clip shows 10 frames of a 12-frame source (trimEnd = 2 frames of source).
		// Right-extend by 5 frames: source ceiling caps at +2 frames.
		const result = computeResize({
			member: member({
				elementId: "a",
				sourceDuration: mediaTime({ ticks: 12 * FRAME }),
				trimEnd: mediaTime({ ticks: 2 * FRAME }),
			}),
			side: "right",
			deltaTime: mediaTime({ ticks: 5 * FRAME }),
			fps: FPS,
		});
		expect(result.deltaTime).toBe(2 * FRAME);
		expect(result.updates[0].patch.duration).toBe(12 * FRAME);
	});

	test("only the grabbed clip's own source headroom limits it (no fan-out)", () => {
		// The grabbed clip 'a' has 5 frames of source headroom; since only the
		// grabbed clip is ever resized, it extends its full +3 frames regardless of
		// any other selected clip's tighter limit (the U2 no-fan-out guarantee).
		const grabbedAlone = computeResize({
			member: member({
				elementId: "a",
				sourceDuration: mediaTime({ ticks: 15 * FRAME }),
				trimEnd: mediaTime({ ticks: 5 * FRAME }),
			}),
			side: "right",
			deltaTime: mediaTime({ ticks: 3 * FRAME }),
			fps: FPS,
		});
		expect(grabbedAlone.deltaTime).toBe(3 * FRAME);
		expect(grabbedAlone.updates).toHaveLength(1);
	});

	test("a right-neighbor bound clamps the grabbed clip's duration exactly at the neighbor start", () => {
		// The real U2 guarantee: clip 'a' (start 10, duration 10 => ends at frame
		// 20) has an adjacent clip 'b' starting at frame 22, recorded as its
		// rightNeighborBound. A large +10-frame right drag must stop the grabbed
		// clip's right edge exactly at 22 (2 frames of growth), never running into
		// or past the neighbor. Ample source headroom so the neighbor is the only
		// binding limit.
		const result = computeResize({
			member: member({
				elementId: "a",
				sourceDuration: mediaTime({ ticks: 100 * FRAME }),
				rightNeighborBound: mediaTime({ ticks: 22 * FRAME }),
			}),
			side: "right",
			deltaTime: mediaTime({ ticks: 10 * FRAME }),
			fps: FPS,
		});
		expect(result.deltaTime).toBe(2 * FRAME);
		const endEdge =
			result.updates[0].patch.startTime + result.updates[0].patch.duration;
		expect(endEdge).toBe(22 * FRAME);
	});

	test("left handle resizes only the grabbed clip", () => {
		const result = computeResize({
			member: member({ elementId: "a" }),
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

describe("computeLinkedResize (linked trim, Dan's fork)", () => {
	test("a single member matches computeResize exactly (Alt-solo parity)", () => {
		const m = member({
			elementId: "a",
			sourceDuration: mediaTime({ ticks: 12 * FRAME }),
			trimEnd: mediaTime({ ticks: 2 * FRAME }),
		});
		const solo = computeResize({
			member: m,
			side: "right",
			deltaTime: mediaTime({ ticks: 5 * FRAME }),
			fps: FPS,
		});
		const linked = computeLinkedResize({
			members: [m],
			side: "right",
			deltaTime: mediaTime({ ticks: 5 * FRAME }),
			fps: FPS,
		});
		expect(linked).toEqual(solo);
	});

	test("the shared delta is clamped by the MOST restrictive member's source headroom", () => {
		// Grabbed video has 5 frames of headroom, its linked audio only 2: the
		// pair extends 2 frames together, never desyncing mid-trim.
		const video = member({
			elementId: "v",
			sourceDuration: mediaTime({ ticks: 15 * FRAME }),
			trimEnd: mediaTime({ ticks: 5 * FRAME }),
		});
		const audio = member({
			elementId: "a",
			trackId: "audio-1",
			sourceDuration: mediaTime({ ticks: 12 * FRAME }),
			trimEnd: mediaTime({ ticks: 2 * FRAME }),
		});
		const result = computeLinkedResize({
			members: [video, audio],
			side: "right",
			deltaTime: mediaTime({ ticks: 5 * FRAME }),
			fps: FPS,
		});
		expect(result.deltaTime).toBe(2 * FRAME);
		expect(result.updates).toHaveLength(2);
		expect(result.updates[0].patch.duration).toBe(12 * FRAME);
		expect(result.updates[1].patch.duration).toBe(12 * FRAME);
	});

	test("a partner's neighbor bound clamps the whole pair", () => {
		const video = member({
			elementId: "v",
			sourceDuration: mediaTime({ ticks: 100 * FRAME }),
		});
		const audio = member({
			elementId: "a",
			trackId: "audio-1",
			sourceDuration: mediaTime({ ticks: 100 * FRAME }),
			// Another audio clip right behind the partner: ends at frame 23.
			rightNeighborBound: mediaTime({ ticks: 23 * FRAME }),
		});
		const result = computeLinkedResize({
			members: [video, audio],
			side: "right",
			deltaTime: mediaTime({ ticks: 10 * FRAME }),
			fps: FPS,
		});
		// Both end at frame 20; the audio neighbor allows +3 frames only.
		expect(result.deltaTime).toBe(3 * FRAME);
		for (const update of result.updates) {
			expect(update.patch.duration).toBe(13 * FRAME);
		}
	});

	test("a retimed partner consumes PER-MEMBER source deltas, never the shared one", () => {
		// Timeline delta +2 frames: the 1x video gives up 2 frames of source
		// trimEnd, the 2x partner gives up 4 (delta * rate).
		const video = member({
			elementId: "v",
			sourceDuration: mediaTime({ ticks: 18 * FRAME }),
			trimEnd: mediaTime({ ticks: 8 * FRAME }),
		});
		const retimed = member({
			elementId: "r",
			trackId: "audio-1",
			sourceDuration: mediaTime({ ticks: 28 * FRAME }),
			trimEnd: mediaTime({ ticks: 8 * FRAME }),
			retime: { rate: 2 },
		});
		const result = computeLinkedResize({
			members: [video, retimed],
			side: "right",
			deltaTime: mediaTime({ ticks: 2 * FRAME }),
			fps: FPS,
		});
		expect(result.deltaTime).toBe(2 * FRAME);
		expect(result.updates[0].patch.trimEnd).toBe(6 * FRAME);
		expect(result.updates[1].patch.trimEnd).toBe(4 * FRAME);
		// Same timeline geometry for both.
		expect(result.updates[0].patch.duration).toBe(12 * FRAME);
		expect(result.updates[1].patch.duration).toBe(12 * FRAME);
	});

	test("a left trim moves every member's start by the same shared delta", () => {
		const video = member({ elementId: "v" });
		const audio = member({ elementId: "a", trackId: "audio-1" });
		const result = computeLinkedResize({
			members: [video, audio],
			side: "left",
			deltaTime: mediaTime({ ticks: 2 * FRAME }),
			fps: FPS,
		});
		for (const update of result.updates) {
			expect(update.patch.startTime).toBe(12 * FRAME);
			expect(update.patch.duration).toBe(8 * FRAME);
			expect(update.patch.trimStart).toBe(2 * FRAME);
		}
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
