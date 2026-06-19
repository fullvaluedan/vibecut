import { describe, expect, test } from "bun:test";
import { mergeDetectedCuts } from "../cut-utils";
import type { DirectorOp } from "@framecut/hf-bridge";

function op(
	over: Partial<DirectorOp> & { startSec: number; endSec: number },
): DirectorOp {
	return { id: `id-${over.startSec}-${over.endSec}`, op: "cut", reason: "r", confidence: 0.8, ...over };
}

describe("mergeDetectedCuts — keeper safety (KTD7)", () => {
	test("a planner removal over a keeper span is dropped", () => {
		const merged = mergeDetectedCuts({
			planOps: [op({ startSec: 10, endSec: 15, op: "take_select" })],
			extraOps: [],
			keepers: [{ startSec: 10, endSec: 15 }],
		});
		expect(merged).toHaveLength(0);
	});

	test("a detector removal over a keeper span is dropped too", () => {
		const merged = mergeDetectedCuts({
			planOps: [],
			extraOps: [op({ startSec: 10, endSec: 15, category: "filler" })],
			keepers: [{ startSec: 10, endSec: 15 }],
		});
		expect(merged).toHaveLength(0);
	});

	test("disagreement: LLM cuts the keeper, detector cuts the other take → one removal, keeper survives", () => {
		// Cluster members A[0,3] and B[3,6]; deterministic keeper = B.
		const merged = mergeDetectedCuts({
			// LLM thinks A is the keeper, so it removes B (the deterministic keeper).
			planOps: [op({ startSec: 3, endSec: 6, op: "take_select", id: "llm-B" })],
			// Deterministic layer removes the non-keeper A.
			extraOps: [op({ startSec: 0, endSec: 3, op: "take_select", category: "take", id: "det-A" })],
			keepers: [{ startSec: 3, endSec: 6 }],
		});
		expect(merged).toHaveLength(1);
		expect(merged[0].id).toBe("det-A");
		// The keeper span (3–6) is never removed.
		expect(merged.some((o) => o.startSec === 3 && o.endSec === 6)).toBe(false);
	});

	test("a non-removal op (keep/reorder) over a keeper span passes through", () => {
		const merged = mergeDetectedCuts({
			planOps: [op({ startSec: 10, endSec: 15, op: "keep" })],
			extraOps: [],
			keepers: [{ startSec: 10, endSec: 15 }],
		});
		expect(merged).toHaveLength(1);
		expect(merged[0].op).toBe("keep");
	});

	test("a detector cut overlapping a SURVIVING planner removal is dropped", () => {
		const merged = mergeDetectedCuts({
			planOps: [op({ startSec: 0, endSec: 5 })],
			extraOps: [op({ startSec: 2, endSec: 3, id: "x" })],
			keepers: [],
		});
		expect(merged).toHaveLength(1);
		expect(merged[0].startSec).toBe(0);
	});

	test("a detector cut overlapping a DROPPED planner removal survives", () => {
		// The LLM removal hits a keeper and is dropped, so the detector op it
		// overlapped is no longer suppressed by it.
		const merged = mergeDetectedCuts({
			planOps: [op({ startSec: 10, endSec: 15, op: "take_select", id: "llm" })],
			extraOps: [op({ startSec: 14, endSec: 16, id: "det", op: "cut" })],
			keepers: [{ startSec: 10, endSec: 15 }],
		});
		// det[14,16] overlaps keeper[10,15]? 14<15 → yes → also dropped (keeper safety).
		expect(merged).toHaveLength(0);
	});

	test("empty keepers reproduces the pre-cluster merge (regression)", () => {
		const merged = mergeDetectedCuts({
			planOps: [op({ startSec: 10, endSec: 12 })],
			extraOps: [op({ startSec: 3, endSec: 3.3, id: "y" })],
		});
		expect(merged.map((o) => o.startSec)).toEqual([3, 10]);
	});
});
