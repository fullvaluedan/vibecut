import { describe, expect, test } from "bun:test";
import { mapContextFlags } from "../context-relevance";
import type { ContextFlag } from "@framecut/hf-bridge";

const flag = ({
	lineId = "L0",
	startSec,
	endSec,
	confidence = 0.7,
	reason = "off-topic tangent",
}: {
	lineId?: string;
	startSec: number;
	endSec: number;
	confidence?: number;
	reason?: string;
}): ContextFlag => ({ lineId, startSec, endSec, text: lineId, confidence, reason });

describe("mapContextFlags (U3 Part B)", () => {
	test("a flag becomes an opt-in context cut carrying the LLM reason", () => {
		const ops = mapContextFlags({ flags: [flag({ startSec: 10, endSec: 14, reason: "belongs to a different video" })] });
		expect(ops).toHaveLength(1);
		expect(ops[0].op).toBe("cut");
		expect(ops[0].category).toBe("context");
		expect(ops[0].defaultAccept).toBe(false); // OPT-IN, never auto-cut
		expect(ops[0].startSec).toBe(10);
		expect(ops[0].endSec).toBe(14);
		expect(ops[0].confidence).toBe(0.7);
		expect(ops[0].reason).toContain("belongs to a different video");
	});

	test("a flag overlapping an existing cut is dropped (no double-flag)", () => {
		const ops = mapContextFlags({
			flags: [flag({ startSec: 10, endSec: 14 })],
			existingCuts: [{ startSec: 12, endSec: 13 }], // a repeat/dead-air cut inside the span
		});
		expect(ops).toHaveLength(0);
	});

	test("a non-overlapping flag survives alongside existing cuts", () => {
		const ops = mapContextFlags({
			flags: [flag({ startSec: 20, endSec: 24 })],
			existingCuts: [{ startSec: 0, endSec: 5 }],
		});
		expect(ops).toHaveLength(1);
	});

	test("an empty span (endSec <= startSec) is skipped defensively", () => {
		expect(mapContextFlags({ flags: [flag({ startSec: 5, endSec: 5 })] })).toHaveLength(0);
		expect(mapContextFlags({ flags: [flag({ startSec: 5, endSec: 4 })] })).toHaveLength(0);
	});

	test("no flags → no ops", () => {
		expect(mapContextFlags({ flags: [] })).toEqual([]);
	});

	test("a flag with no reason falls back to a generic out-of-context reason", () => {
		const ops = mapContextFlags({ flags: [flag({ startSec: 1, endSec: 2, reason: "" })] });
		expect(ops[0].reason).toContain("Out of context");
	});
});
