import { describe, expect, test } from "bun:test";
import {
	MAX_STRUCTURAL_DROP_FRACTION,
	mapStructuralDrops,
} from "../structural-apply";
import { DEFAULT_REDUNDANCY_CONFIDENCE_FLOOR } from "../redundancy-apply";
import type { StructuralDrop } from "@framecut/hf-bridge";

const drop = ({
	startSec,
	endSec,
	confidence,
	reason = "wanders off the throughline",
}: {
	startSec: number;
	endSec: number;
	confidence: number;
	reason?: string;
}): StructuralDrop => ({ startSec, endSec, reason, confidence });

describe("mapStructuralDrops", () => {
	// Big totalSec so the runaway guard never fires for these small spans.
	const TOTAL = 100;

	test("drops candidates below the 0.5 confidence floor (reuses the redundancy constant)", () => {
		expect(DEFAULT_REDUNDANCY_CONFIDENCE_FLOOR).toBe(0.5);
		expect(
			mapStructuralDrops({ drops: [drop({ startSec: 0, endSec: 1, confidence: 0.49 })], totalSec: TOTAL }),
		).toHaveLength(0);
		expect(
			mapStructuralDrops({ drops: [drop({ startSec: 0, endSec: 1, confidence: 0.1 })], totalSec: TOTAL }),
		).toHaveLength(0);
	});

	test("keeps candidates at/above the floor (0.5..1.0) and NEVER defaultAccept true", () => {
		const ops = mapStructuralDrops({
			drops: [
				drop({ startSec: 0, endSec: 1, confidence: 0.5 }), // floor is inclusive
				drop({ startSec: 2, endSec: 3, confidence: 0.75 }),
				drop({ startSec: 4, endSec: 5, confidence: 1.0 }),
			],
			totalSec: TOTAL,
		});
		expect(ops).toHaveLength(3);
		// OFFERED-only: every surviving op starts unchecked, whatever its confidence.
		expect(ops.every((o) => o.defaultAccept === false)).toBe(true);
		expect(ops.some((o) => o.defaultAccept === true)).toBe(false);
	});

	test("every op is a cut with category structural and a structural- id (never take_select/keep/reorder)", () => {
		const ops = mapStructuralDrops({
			drops: [
				drop({ startSec: 0, endSec: 1, confidence: 0.6 }),
				drop({ startSec: 2, endSec: 3, confidence: 0.9 }),
			],
			totalSec: TOTAL,
		});
		expect(ops.every((o) => o.op === "cut")).toBe(true);
		expect(ops.every((o) => o.category === "structural")).toBe(true);
		expect(ops.every((o) => o.id.startsWith("structural-"))).toBe(true);
		// Stable + unique ids.
		expect(ops[0].id).not.toBe(ops[1].id);
	});

	test("R5b runaway guard: a single candidate covering more than the cap is dropped; a normal multi-line drop passes", () => {
		const totalSec = 100;
		// Covers 40% of the timeline (> 0.35 cap) → dropped at mapping time.
		expect(
			mapStructuralDrops({ drops: [drop({ startSec: 0, endSec: 40, confidence: 0.9 })], totalSec }),
		).toHaveLength(0);
		// A real multi-line section drop (10% of the timeline) survives.
		expect(
			mapStructuralDrops({ drops: [drop({ startSec: 10, endSec: 20, confidence: 0.9 })], totalSec }),
		).toHaveLength(1);
	});

	test("the runaway cap is the documented tuned fraction, applied with strict >", () => {
		expect(MAX_STRUCTURAL_DROP_FRACTION).toBe(0.35);
		// Exactly at the cap passes (strict >, "more than" the fraction).
		expect(
			mapStructuralDrops({ drops: [drop({ startSec: 0, endSec: 35, confidence: 0.9 })], totalSec: 100 }),
		).toHaveLength(1);
		// Just over the cap dies.
		expect(
			mapStructuralDrops({ drops: [drop({ startSec: 0, endSec: 35.1, confidence: 0.9 })], totalSec: 100 }),
		).toHaveLength(0);
	});

	test("carries the LLM reason (clamped), preserves seconds", () => {
		const ops = mapStructuralDrops({
			drops: [
				drop({ startSec: 1.234, endSec: 2.5, confidence: 0.8, reason: "off-throughline tangent" }),
				drop({ startSec: 6, endSec: 7, confidence: 0.8, reason: "" }),
			],
			totalSec: TOTAL,
		});
		expect(ops[0].reason).toBe("off-throughline tangent");
		expect(ops[1].reason).toBe("Off-throughline section"); // empty reason → default
		expect([ops[0].startSec, ops[0].endSec]).toEqual([1.234, 2.5]);
	});

	test("empty input → no ops", () => {
		expect(mapStructuralDrops({ drops: [], totalSec: TOTAL })).toEqual([]);
	});
});
