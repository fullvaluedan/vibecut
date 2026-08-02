import { describe, expect, test } from "bun:test";
import { isFollowSuspended } from "../follow-playback-suspend";

describe("isFollowSuspended", () => {
	test("not suspended when idle and no recent scroll", () => {
		expect(
			isFollowSuspended({ pointerOver: false, lastManualScrollAt: null, now: 1000 }),
		).toBe(false);
	});

	test("suspended while the pointer is over the transcript", () => {
		expect(
			isFollowSuspended({ pointerOver: true, lastManualScrollAt: null, now: 1000 }),
		).toBe(true);
	});

	test("suspended within the suspend window after a manual scroll", () => {
		expect(
			isFollowSuspended({
				pointerOver: false,
				lastManualScrollAt: 1000,
				now: 1500,
				suspendMs: 2000,
			}),
		).toBe(true);
	});

	test("resumes once the suspend window elapses", () => {
		expect(
			isFollowSuspended({
				pointerOver: false,
				lastManualScrollAt: 1000,
				now: 3001,
				suspendMs: 2000,
			}),
		).toBe(false);
	});

	test("boundary: exactly at the window edge is no longer suspended", () => {
		expect(
			isFollowSuspended({
				pointerOver: false,
				lastManualScrollAt: 1000,
				now: 3000,
				suspendMs: 2000,
			}),
		).toBe(false);
	});

	test("pointer-over wins even after the scroll window elapses", () => {
		expect(
			isFollowSuspended({
				pointerOver: true,
				lastManualScrollAt: 1000,
				now: 9000,
				suspendMs: 2000,
			}),
		).toBe(true);
	});

	test("defaults to a 2s suspend window when suspendMs is omitted", () => {
		expect(
			isFollowSuspended({ pointerOver: false, lastManualScrollAt: 1000, now: 2999 }),
		).toBe(true);
		expect(
			isFollowSuspended({ pointerOver: false, lastManualScrollAt: 1000, now: 3000 }),
		).toBe(false);
	});
});
