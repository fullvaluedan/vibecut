import { describe, expect, test } from "bun:test";
import { mapContextFlags } from "../context-relevance";
import { DEFAULT_REDUNDANCY_ACCEPT_THRESHOLD } from "../redundancy-apply";
import type { ContextFlag } from "@framecut/hf-bridge";

const flag = ({
	lineId = "L0",
	startSec,
	endSec,
	confidence = 0.5,
	reason = "off-topic tangent",
}: {
	lineId?: string;
	startSec: number;
	endSec: number;
	confidence?: number;
	reason?: string;
}): ContextFlag => ({ lineId, startSec, endSec, text: lineId, confidence, reason });

describe("mapContextFlags (U3 Part B + 2P-U4 confidence split)", () => {
	test("a low-confidence flag becomes an opt-in context cut carrying the LLM reason", () => {
		const ops = mapContextFlags({ flags: [flag({ startSec: 10, endSec: 14, confidence: 0.5, reason: "belongs to a different video" })] });
		expect(ops).toHaveLength(1);
		expect(ops[0].op).toBe("cut");
		expect(ops[0].category).toBe("context");
		expect(ops[0].defaultAccept).toBe(false); // below threshold → opt-in
		expect(ops[0].startSec).toBe(10);
		expect(ops[0].endSec).toBe(14);
		expect(ops[0].confidence).toBe(0.5);
		expect(ops[0].reason).toContain("belongs to a different video");
	});

	test("a high-confidence flag default-accepts so it actually leaves", () => {
		const ops = mapContextFlags({ flags: [flag({ startSec: 10, endSec: 14, confidence: 0.85 })] });
		expect(ops).toHaveLength(1);
		expect(ops[0].defaultAccept).toBe(true);
	});

	test("a flag exactly at the accept threshold default-accepts (inclusive)", () => {
		const ops = mapContextFlags({ flags: [flag({ startSec: 10, endSec: 14, confidence: DEFAULT_REDUNDANCY_ACCEPT_THRESHOLD })] });
		expect(ops[0].defaultAccept).toBe(true);
	});

	test("a flag just below the threshold stays opt-in", () => {
		const ops = mapContextFlags({ flags: [flag({ startSec: 10, endSec: 14, confidence: 0.6 })] });
		expect(ops[0].defaultAccept).toBe(false);
	});

	test("a non-finite confidence never auto-accepts (fail toward keeping)", () => {
		const ops = mapContextFlags({ flags: [flag({ startSec: 10, endSec: 14, confidence: Number.NaN })] });
		expect(ops[0].defaultAccept).toBe(false);
	});

	test("a flag overlapping an existing cut is dropped (no double-flag)", () => {
		const ops = mapContextFlags({
			flags: [flag({ startSec: 10, endSec: 14, confidence: 0.9 })],
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
