import { describe, expect, test } from "bun:test";
import type { FrameRate } from "opencut-wasm";
import { getGroupClampReason, getMemberClampReason } from "@/timeline/group-resize";
import type { GroupResizeMember } from "@/timeline/group-resize";
import { mediaTime, ZERO_MEDIA_TIME } from "@/wasm";

// Mirrors compute-resize.test.ts: 30fps => 1 frame = 4_000 ticks, deltas below
// are frame-aligned so rounding never enters the comparison.
const FPS: FrameRate = { numerator: 30, denominator: 1 };
const FRAME = 4_000;
const MIN_DURATION = mediaTime({ ticks: FRAME });

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
		sourceDurationRequired: undefined,
		retime: undefined,
		leftNeighborBound: null,
		rightNeighborBound: null,
		...overrides,
	};
}

describe("getMemberClampReason - right side", () => {
	test("min-duration: shrinking past the one-frame floor", () => {
		const m = member({ elementId: "a" }); // duration 10 frames
		const reason = getMemberClampReason({
			member: m,
			side: "right",
			requestedDeltaTime: mediaTime({ ticks: -10 * FRAME }), // floor is -9 frames
			minDuration: MIN_DURATION,
		});
		expect(reason).toBe("min-duration");
	});

	test("source-limit: no more footage past trimEnd, no neighbor", () => {
		const m = member({
			elementId: "a",
			sourceDuration: mediaTime({ ticks: 12 * FRAME }),
			trimEnd: mediaTime({ ticks: 2 * FRAME }), // ceiling is +2 frames
		});
		const reason = getMemberClampReason({
			member: m,
			side: "right",
			requestedDeltaTime: mediaTime({ ticks: 5 * FRAME }),
			minDuration: MIN_DURATION,
		});
		expect(reason).toBe("source-limit");
	});

	test("neighbor: a downstream clip is the wall, ample source headroom", () => {
		const m = member({
			elementId: "a",
			sourceDuration: mediaTime({ ticks: 100 * FRAME }),
			rightNeighborBound: mediaTime({ ticks: 22 * FRAME }), // ends at 20, ceiling +2
		});
		const reason = getMemberClampReason({
			member: m,
			side: "right",
			requestedDeltaTime: mediaTime({ ticks: 10 * FRAME }),
			minDuration: MIN_DURATION,
		});
		expect(reason).toBe("neighbor");
	});

	test("not clamped: requested delta is within bounds", () => {
		const m = member({
			elementId: "a",
			sourceDuration: mediaTime({ ticks: 100 * FRAME }),
		});
		const reason = getMemberClampReason({
			member: m,
			side: "right",
			requestedDeltaTime: mediaTime({ ticks: 3 * FRAME }),
			minDuration: MIN_DURATION,
		});
		expect(reason).toBeNull();
	});
});

describe("getMemberClampReason - left side", () => {
	test("min-duration: shrinking past the one-frame floor", () => {
		const m = member({ elementId: "a" }); // duration 10 frames, max shrink +9
		const reason = getMemberClampReason({
			member: m,
			side: "left",
			requestedDeltaTime: mediaTime({ ticks: 10 * FRAME }),
			minDuration: MIN_DURATION,
		});
		expect(reason).toBe("min-duration");
	});

	test("source-limit: no more footage before trimStart, distant/no neighbor", () => {
		const m = member({
			elementId: "a",
			trimStart: mediaTime({ ticks: 2 * FRAME }),
			sourceDuration: mediaTime({ ticks: 12 * FRAME }), // only 2 frames of left headroom
			// no leftNeighborBound: the floor is "don't go before timeline 0", far
			// looser than the 2-frame source floor.
		});
		const reason = getMemberClampReason({
			member: m,
			side: "left",
			requestedDeltaTime: mediaTime({ ticks: -5 * FRAME }),
			minDuration: MIN_DURATION,
		});
		expect(reason).toBe("source-limit");
	});

	test("neighbor: an upstream clip is the wall, ample source headroom", () => {
		const m = member({
			elementId: "a",
			trimStart: mediaTime({ ticks: 50 * FRAME }),
			sourceDuration: mediaTime({ ticks: 100 * FRAME }), // 50 frames of left headroom
			leftNeighborBound: mediaTime({ ticks: 3 * FRAME }), // startTime 10, floor -7
		});
		const reason = getMemberClampReason({
			member: m,
			side: "left",
			requestedDeltaTime: mediaTime({ ticks: -10 * FRAME }),
			minDuration: MIN_DURATION,
		});
		expect(reason).toBe("neighbor");
	});

	test("not clamped: requested delta is within bounds", () => {
		const m = member({ elementId: "a" });
		const reason = getMemberClampReason({
			member: m,
			side: "left",
			requestedDeltaTime: mediaTime({ ticks: -1 * FRAME }),
			minDuration: MIN_DURATION,
		});
		expect(reason).toBeNull();
	});
});

describe("getMemberClampReason - retimed partner (sourceDelta = delta * rate)", () => {
	test("a 2x retimed member hits source-limit at half the nominal headroom", () => {
		// 26 frames of raw source, rate 2: the timeline-visible ceiling is
		// 26/2 - 10 = 3 frames, not 26 - 10 = 16 like a 1x clip would see.
		const retimed = member({
			elementId: "r",
			sourceDuration: mediaTime({ ticks: 26 * FRAME }),
			retime: { rate: 2 },
		});
		const oneX = member({
			elementId: "v",
			sourceDuration: mediaTime({ ticks: 26 * FRAME }),
		});
		const requestedDeltaTime = mediaTime({ ticks: 5 * FRAME });

		expect(
			getMemberClampReason({
				member: retimed,
				side: "right",
				requestedDeltaTime,
				minDuration: MIN_DURATION,
			}),
		).toBe("source-limit");
		// The 1x member with the SAME raw sourceDuration has 16 frames of
		// timeline headroom, so the identical request is not clamped at all.
		expect(
			getMemberClampReason({
				member: oneX,
				side: "right",
				requestedDeltaTime,
				minDuration: MIN_DURATION,
			}),
		).toBeNull();
	});
});

describe("getMemberClampReason - missing sourceDuration", () => {
	test("image/text (sourceDurationRequired unset) keeps free extension", () => {
		const m = member({ elementId: "img" }); // sourceDuration undefined, flag unset
		const reason = getMemberClampReason({
			member: m,
			side: "right",
			requestedDeltaTime: mediaTime({ ticks: 1000 * FRAME }),
			minDuration: MIN_DURATION,
		});
		expect(reason).toBeNull();
	});

	test("video/audio with sourceDurationRequired but no sourceDuration is clamped at ZERO headroom, not unbounded (right side)", () => {
		const m = member({ elementId: "v", sourceDurationRequired: true });
		const reason = getMemberClampReason({
			member: m,
			side: "right",
			requestedDeltaTime: mediaTime({ ticks: 1 * FRAME }),
			minDuration: MIN_DURATION,
		});
		expect(reason).toBe("source-limit");
	});

	test("video/audio with sourceDurationRequired but no sourceDuration is clamped at ZERO headroom, not unbounded (left side)", () => {
		const m = member({ elementId: "v", sourceDurationRequired: true });
		const reason = getMemberClampReason({
			member: m,
			side: "left",
			requestedDeltaTime: mediaTime({ ticks: -1 * FRAME }),
			minDuration: MIN_DURATION,
		});
		expect(reason).toBe("source-limit");
	});

	test("video/audio with sourceDurationRequired can still SHRINK freely (only extension is blocked)", () => {
		const m = member({ elementId: "v", sourceDurationRequired: true });
		const reason = getMemberClampReason({
			member: m,
			side: "right",
			requestedDeltaTime: mediaTime({ ticks: -3 * FRAME }), // within the min-duration floor
			minDuration: MIN_DURATION,
		});
		expect(reason).toBeNull();
	});
});

describe("getGroupClampReason", () => {
	test("reports the neighbor reason and the BINDING member's id (a linked partner, not the grabbed clip)", () => {
		const video = member({
			elementId: "v",
			sourceDuration: mediaTime({ ticks: 100 * FRAME }),
		});
		const audio = member({
			elementId: "a",
			trackId: "audio-1",
			sourceDuration: mediaTime({ ticks: 100 * FRAME }),
			rightNeighborBound: mediaTime({ ticks: 23 * FRAME }), // ceiling +3
		});
		const result = getGroupClampReason({
			members: [video, audio],
			side: "right",
			requestedDeltaTime: mediaTime({ ticks: 10 * FRAME }),
			minDuration: MIN_DURATION,
		});
		expect(result).toEqual({ reason: "neighbor", elementId: "a" });
	});

	test("reports the source-limit reason and the binding member's id", () => {
		const video = member({
			elementId: "v",
			sourceDuration: mediaTime({ ticks: 12 * FRAME }),
			trimEnd: mediaTime({ ticks: 2 * FRAME }), // ceiling +2
		});
		const audio = member({
			elementId: "a",
			trackId: "audio-1",
			sourceDuration: mediaTime({ ticks: 100 * FRAME }), // ceiling +90
		});
		const result = getGroupClampReason({
			members: [video, audio],
			side: "right",
			requestedDeltaTime: mediaTime({ ticks: 5 * FRAME }),
			minDuration: MIN_DURATION,
		});
		expect(result).toEqual({ reason: "source-limit", elementId: "v" });
	});

	test("a tighter ripple shrink floor reports as neighbor, keyed to the grabbed member", () => {
		const video = member({ elementId: "v" });
		const audio = member({ elementId: "a", trackId: "audio-1" });
		const result = getGroupClampReason({
			members: [video, audio],
			side: "right",
			requestedDeltaTime: mediaTime({ ticks: -5 * FRAME }),
			minDuration: MIN_DURATION,
			rippleShrinkFloorDelta: mediaTime({ ticks: -3 * FRAME }),
		});
		expect(result).toEqual({ reason: "neighbor", elementId: "v" });
	});

	test("not clamped: returns null when the request is within every member's bound", () => {
		const video = member({
			elementId: "v",
			sourceDuration: mediaTime({ ticks: 100 * FRAME }),
		});
		const audio = member({
			elementId: "a",
			trackId: "audio-1",
			sourceDuration: mediaTime({ ticks: 100 * FRAME }),
		});
		const result = getGroupClampReason({
			members: [video, audio],
			side: "right",
			requestedDeltaTime: mediaTime({ ticks: 3 * FRAME }),
			minDuration: MIN_DURATION,
		});
		expect(result).toBeNull();
	});

	test("empty member list is never clamped", () => {
		const result = getGroupClampReason({
			members: [],
			side: "right",
			requestedDeltaTime: mediaTime({ ticks: 3 * FRAME }),
			minDuration: MIN_DURATION,
		});
		expect(result).toBeNull();
	});
});
