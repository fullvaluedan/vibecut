import { describe, expect, test } from "bun:test";
import { timelineChangedWhileStale } from "../detect-timeline-change";

describe("timelineChangedWhileStale", () => {
	test("never blocks when not stale", () => {
		expect(
			timelineChangedWhileStale({
				stale: false,
				liveHash: "a",
				expectedHash: "b",
			}),
		).toBe(false);
	});

	test("no change when the live hash matches the expected (our own delete)", () => {
		expect(
			timelineChangedWhileStale({
				stale: true,
				liveHash: "hashB",
				expectedHash: "hashB",
			}),
		).toBe(false);
	});

	test("detects an external change while stale (live hash diverged)", () => {
		expect(
			timelineChangedWhileStale({
				stale: true,
				liveHash: "hashA",
				expectedHash: "hashB",
			}),
		).toBe(true);
	});

	test("an unreadable (empty) live hash does not block on its own", () => {
		expect(
			timelineChangedWhileStale({
				stale: true,
				liveHash: "",
				expectedHash: "hashB",
			}),
		).toBe(false);
	});

	test("regression: delete -> undo -> delete is blocked against restored coords", () => {
		// After the first local delete the timeline is at state B and the panel is
		// stale; the expected hash is B, so a second delete is allowed (matches live).
		const afterDelete = timelineChangedWhileStale({
			stale: true,
			liveHash: "hashB",
			expectedHash: "hashB",
		});
		expect(afterDelete).toBe(false);

		// An external Ctrl+Z restores the timeline to state A (hashA). The local words
		// still describe state B, so the next delete must be BLOCKED until Refresh.
		const afterUndo = timelineChangedWhileStale({
			stale: true,
			liveHash: "hashA",
			expectedHash: "hashB",
		});
		expect(afterUndo).toBe(true);
	});
});
