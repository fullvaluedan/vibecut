import { describe, expect, test } from "bun:test";
import {
	isSeekSuperseded,
	SEEK_SUPERSEDE_EPSILON_SEC,
} from "../seek-supersede";

describe("isSeekSuperseded", () => {
	test("a same-time repeat is NOT superseded (the freeze fix)", () => {
		expect(isSeekSuperseded({ requestedTime: 600, latestTime: 600 })).toBe(false);
	});

	test("a genuinely newer/different time supersedes", () => {
		expect(isSeekSuperseded({ requestedTime: 600, latestTime: 605 })).toBe(true);
		expect(isSeekSuperseded({ requestedTime: 605, latestTime: 600 })).toBe(true);
	});

	test("sub-epsilon jitter is treated as the same seek", () => {
		expect(
			isSeekSuperseded({
				requestedTime: 600,
				latestTime: 600 + SEEK_SUPERSEDE_EPSILON_SEC / 2,
			}),
		).toBe(false);
	});

	test("a one-frame scrub (~33ms) supersedes", () => {
		expect(isSeekSuperseded({ requestedTime: 600, latestTime: 600.033 })).toBe(true);
	});

	test("no recorded latest time is never superseded", () => {
		expect(isSeekSuperseded({ requestedTime: 600, latestTime: undefined })).toBe(false);
	});

	test("epsilon is well under a frame duration", () => {
		// 30fps frame ≈ 33ms; epsilon must be far smaller so real scrubs win.
		expect(SEEK_SUPERSEDE_EPSILON_SEC).toBeLessThan(1 / 30 / 2);
	});
});
