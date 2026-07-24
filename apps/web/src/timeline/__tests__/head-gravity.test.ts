import { describe, expect, test } from "bun:test";
import {
	HEAD_GRAVITY_SEC,
	isUnderHeadGravity,
	snapToHead,
} from "@/timeline/head-gravity";
import { mediaTime, TICKS_PER_SECOND, ZERO_MEDIA_TIME } from "@/wasm";

const GRAVITY_TICKS = HEAD_GRAVITY_SEC * TICKS_PER_SECOND;

describe("head gravity (2s zone, Dan's fork)", () => {
	test("the constant is 2.0 seconds", () => {
		expect(HEAD_GRAVITY_SEC).toBe(2.0);
	});

	test("0 is under gravity and snaps to 0", () => {
		expect(isUnderHeadGravity({ startTime: ZERO_MEDIA_TIME })).toBe(true);
		expect(snapToHead({ startTime: ZERO_MEDIA_TIME })).toBe(0);
	});

	test("one frame is under gravity and snaps to 0", () => {
		const oneFrame = mediaTime({ ticks: 4_000 });
		expect(snapToHead({ startTime: oneFrame })).toBe(0);
	});

	test("just under 2s snaps to 0", () => {
		const justUnder = mediaTime({ ticks: GRAVITY_TICKS - 1 });
		expect(snapToHead({ startTime: justUnder })).toBe(0);
	});

	test("exactly 2.0s is free (at or beyond the threshold moves freely)", () => {
		const exactly = mediaTime({ ticks: GRAVITY_TICKS });
		expect(isUnderHeadGravity({ startTime: exactly })).toBe(false);
		expect(snapToHead({ startTime: exactly })).toBe(GRAVITY_TICKS);
	});

	test("beyond 2s is returned unchanged", () => {
		const fiveSec = mediaTime({ ticks: 5 * TICKS_PER_SECOND });
		expect(snapToHead({ startTime: fiveSec })).toBe(5 * TICKS_PER_SECOND);
	});

	test("a negative request is under gravity and snaps to 0", () => {
		const negative = mediaTime({ ticks: -4_000 });
		expect(snapToHead({ startTime: negative })).toBe(0);
	});
});
