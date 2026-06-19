import { describe, expect, test } from "bun:test";
import { describeReviewOp } from "../review-format";
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
