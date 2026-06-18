import { describe, expect, test } from "bun:test";
import type { MediaTime } from "@/wasm";
import type { TimelineElement, VideoElement } from "@/timeline";
import type { PlacementTimeSpan } from "@/timeline/placement/types";
import { canPlaceTimeSpansOnTrack } from "@/timeline/placement/overlap";
import {
	canElementGoOnTrack,
	getTrackTypeForElementType,
	validateElementTrackCompatibility,
} from "@/timeline/placement/compatibility";

// These lock the two placement rules that live in pure, wasm-free modules:
//   - same-track overlap rejection (overlap.ts)
//   - element/track type compatibility (compatibility.ts)
// The remaining rules (the 0:00 floor clamp / RC1, and the linked-group
// new-track creation / U2) live in resolve-move.ts, which imports the wasm
// `@/wasm` time math and therefore can't run under bun — those are covered by
// the live acceptance scenarios (AE2, AE3, AE4) in the plan.

// Build a MediaTime without importing the wasm runtime (a type guard narrows
// `number` to MediaTime with no unsafe assertion).
function isTick(value: number): value is MediaTime {
	return Number.isInteger(value);
}
function tick(value: number): MediaTime {
	if (!isTick(value)) {
		throw new Error(`expected integer ticks, got ${value}`);
	}
	return value;
}

function videoElement({
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
		startTime: tick(startTime),
		duration: tick(duration),
		trimStart: tick(0),
		trimEnd: tick(0),
		mediaId: "media",
		params: {},
	};
}

function span({
	startTime,
	duration,
	excludeElementId,
}: {
	startTime: number;
	duration: number;
	excludeElementId?: string;
}): PlacementTimeSpan {
	return {
		startTime: tick(startTime),
		duration: tick(duration),
		...(excludeElementId ? { excludeElementId } : {}),
	};
}

describe("placement: same-track overlap rule (canPlaceTimeSpansOnTrack)", () => {
	const track = {
		elements: [
			videoElement({ id: "a", startTime: 0, duration: 10 }),
			videoElement({ id: "b", startTime: 20, duration: 10 }),
		] as TimelineElement[],
	};

	test("a clip placed in a gap is allowed (gaps are valid, not auto-closed)", () => {
		expect(
			canPlaceTimeSpansOnTrack({ track, timeSpans: [span({ startTime: 12, duration: 5 })] }),
		).toBe(true);
	});

	test("a clip overlapping an existing clip is rejected", () => {
		expect(
			canPlaceTimeSpansOnTrack({ track, timeSpans: [span({ startTime: 5, duration: 10 })] }),
		).toBe(false);
	});

	test("a clip butting exactly between two clips (back-to-back) is allowed", () => {
		expect(
			canPlaceTimeSpansOnTrack({ track, timeSpans: [span({ startTime: 10, duration: 10 })] }),
		).toBe(true);
	});

	test("a move that excludes its own id may sit on its own span", () => {
		expect(
			canPlaceTimeSpansOnTrack({
				track,
				timeSpans: [span({ startTime: 0, duration: 10, excludeElementId: "a" })],
			}),
		).toBe(true);
	});
});

describe("placement: element/track type-compatibility rule", () => {
	test("an element type maps to its track type", () => {
		expect(getTrackTypeForElementType({ elementType: "video" })).toBe("video");
		expect(getTrackTypeForElementType({ elementType: "image" })).toBe("video");
		expect(getTrackTypeForElementType({ elementType: "audio" })).toBe("audio");
		expect(getTrackTypeForElementType({ elementType: "text" })).toBe("text");
		// graphic + sticker both map to a graphic track (non-obvious — pin it)
		expect(getTrackTypeForElementType({ elementType: "graphic" })).toBe("graphic");
		expect(getTrackTypeForElementType({ elementType: "sticker" })).toBe("graphic");
		expect(getTrackTypeForElementType({ elementType: "effect" })).toBe("effect");
	});

	test("a video can go on a video track but not an audio track", () => {
		expect(canElementGoOnTrack({ elementType: "video", trackType: "video" })).toBe(true);
		expect(canElementGoOnTrack({ elementType: "video", trackType: "audio" })).toBe(false);
	});

	test("validate rejects a type mismatch with an error message", () => {
		const result = validateElementTrackCompatibility({
			element: { type: "audio" },
			track: { type: "video" },
		});
		expect(result.isValid).toBe(false);
		expect(result.errorMessage).toContain("cannot be placed");
	});

	test("validate passes for a compatible element/track pair", () => {
		expect(
			validateElementTrackCompatibility({
				element: { type: "video" },
				track: { type: "video" },
			}).isValid,
		).toBe(true);
	});
});
