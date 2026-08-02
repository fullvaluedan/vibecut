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

describe("timelineChangedWhileStale - lineage-aware branch (T16.1 note 2)", () => {
	test("an explained lineage never blocks, however far the hash moved", () => {
		expect(
			timelineChangedWhileStale({
				stale: true,
				liveHash: "hashA",
				expectedHash: "hashB",
				lineageExplained: true,
			}),
		).toBe(false);
	});

	test("the same delete -> undo -> delete case is ALLOWED once a lineage explains it", () => {
		// The pre-T16.1 guard blocks this (see the regression above), because the
		// local words described the pre-undo timeline. With a lineage the panel
		// re-derives its words from the live timeline on every read, so the coords
		// are correct and a further delete is safe.
		expect(
			timelineChangedWhileStale({
				stale: true,
				liveHash: "hashA",
				expectedHash: "hashB",
				lineageExplained: true,
			}),
		).toBe(false);
	});

	test("a missing or unexplainable lineage keeps the old guard exactly", () => {
		expect(
			timelineChangedWhileStale({
				stale: true,
				liveHash: "hashA",
				expectedHash: "hashB",
				lineageExplained: false,
			}),
		).toBe(true);
		// Omitting the flag entirely is the same as false (pre-T16.2 callers).
		expect(
			timelineChangedWhileStale({
				stale: true,
				liveHash: "hashA",
				expectedHash: "hashB",
			}),
		).toBe(true);
	});
});
