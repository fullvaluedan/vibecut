import { describe, expect, test } from "bun:test";
import { describeReviewOp, formatTimecode, formatTimeRange } from "../review-format";
import type { DirectorOp } from "@framecut/hf-bridge";

function op(over: Partial<DirectorOp> & { op: DirectorOp["op"] }): DirectorOp {
	return { id: "x", startSec: 0, endSec: 1, reason: "r", confidence: 0.8, ...over };
}

describe("describeReviewOp", () => {
	test("take_select shows the Take badge and no duplicate category badge", () => {
		const d = describeReviewOp({ op: op({ op: "take_select", category: "take" }), accepted: true });
		expect(d.badge).toBe("Take");
		expect(d.categoryBadge).toBeUndefined();
		expect(d.rejectedHint).toBe("");
	});

	test("rejecting a take_select explains that both takes are kept", () => {
		const d = describeReviewOp({ op: op({ op: "take_select", category: "take" }), accepted: false });
		expect(d.rejectedHint).toBe("Keeping both takes");
	});

	test("a repeat cut shows Cut + Repeat badges; rejecting keeps the restatement", () => {
		const accepted = describeReviewOp({ op: op({ op: "cut", category: "repeat" }), accepted: true });
		expect(accepted.badge).toBe("Cut");
		expect(accepted.categoryBadge).toBe("Repeat");
		expect(accepted.rejectedHint).toBe("");

		const rejected = describeReviewOp({ op: op({ op: "cut", category: "repeat" }), accepted: false });
		expect(rejected.rejectedHint).toBe("Keeping the restatement");
	});

	test("a redundancy cut shows the Repeat badge; rejecting keeps THIS take (group-aware)", () => {
		const accepted = describeReviewOp({ op: op({ op: "cut", category: "redundancy" }), accepted: true });
		expect(accepted.categoryBadge).toBe("Repeat");
		expect(accepted.rejectedHint).toBe("");
		const rejected = describeReviewOp({ op: op({ op: "cut", category: "redundancy" }), accepted: false });
		// distinct from the per-op "repeat" hint ("Keeping the restatement")
		expect(rejected.rejectedHint).toBe("Keeping this take");
	});

	test("a plain filler cut has no rejected hint (keeping it is obvious)", () => {
		const d = describeReviewOp({ op: op({ op: "cut", category: "filler" }), accepted: false });
		expect(d.rejectedHint).toBe("");
	});

	test("vision and dead-air categories surface their badges", () => {
		expect(describeReviewOp({ op: op({ op: "cut", category: "vision" }), accepted: true }).categoryBadge).toBe("Vision");
		expect(describeReviewOp({ op: op({ op: "cut", category: "deadair" }), accepted: true }).categoryBadge).toBe("Dead air");
	});

	test("a reorder never gets a rejected hint", () => {
		expect(describeReviewOp({ op: op({ op: "reorder" }), accepted: false }).rejectedHint).toBe("");
		expect(describeReviewOp({ op: op({ op: "reorder" }), accepted: true }).badge).toBe("Reorder");
	});
});

describe("formatTimecode", () => {
	test("renders M:SS.s in minutes", () => {
		expect(formatTimecode(108)).toBe("1:48.0");
		expect(formatTimecode(13.8)).toBe("0:13.8");
		expect(formatTimecode(45.2)).toBe("0:45.2");
	});

	test("zero-pads seconds and handles whole minutes", () => {
		expect(formatTimecode(8)).toBe("0:08.0");
		expect(formatTimecode(60)).toBe("1:00.0");
		expect(formatTimecode(125.5)).toBe("2:05.5");
	});

	test("clamps non-finite / negative input to 0:00.0", () => {
		expect(formatTimecode(0)).toBe("0:00.0");
		expect(formatTimecode(-5)).toBe("0:00.0");
		expect(formatTimecode(Number.NaN)).toBe("0:00.0");
	});

	test("a sub-second span stays distinguishable (does not collapse)", () => {
		expect(formatTimeRange({ startSec: 13.8, endSec: 14.3 })).toBe("0:13.8–0:14.3");
		expect(formatTimeRange({ startSec: 108, endSec: 111 })).toBe("1:48.0–1:51.0");
	});
});
