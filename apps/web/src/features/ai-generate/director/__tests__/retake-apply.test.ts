import { describe, expect, test } from "bun:test";
import {
	MIN_RETAKE_REMAINDER_SEC,
	mapRetakeCuts,
	trimRetakeCuts,
} from "../retake-apply";
import { DEFAULT_REDUNDANCY_CONFIDENCE_FLOOR } from "../redundancy-apply";
import type { RetakeCut } from "@framecut/hf-bridge";

const cut = ({
	startSec,
	endSec,
	confidence,
	reason = "abandoned false start",
}: {
	startSec: number;
	endSec: number;
	confidence: number;
	reason?: string;
}): RetakeCut => ({ startSec, endSec, reason, confidence });

describe("mapRetakeCuts", () => {
	test("drops cuts below the 0.5 confidence floor (reuses the redundancy constant)", () => {
		expect(DEFAULT_REDUNDANCY_CONFIDENCE_FLOOR).toBe(0.5);
		expect(mapRetakeCuts({ cuts: [cut({ startSec: 0, endSec: 1, confidence: 0.49 })] })).toHaveLength(0);
		expect(mapRetakeCuts({ cuts: [cut({ startSec: 0, endSec: 1, confidence: 0.1 })] })).toHaveLength(0);
	});

	test("keeps cuts at/above the floor (0.5..1.0) and NEVER defaultAccept true", () => {
		const ops = mapRetakeCuts({ cuts: [
			cut({ startSec: 0, endSec: 1, confidence: 0.5 }), // floor is inclusive
			cut({ startSec: 2, endSec: 3, confidence: 0.75 }),
			cut({ startSec: 4, endSec: 5, confidence: 1.0 }),
		] });
		expect(ops).toHaveLength(3);
		// OFFERED-only: every surviving op starts unchecked, whatever its confidence.
		expect(ops.every((o) => o.defaultAccept === false)).toBe(true);
		expect(ops.some((o) => o.defaultAccept === true)).toBe(false);
	});

	test("every op is a cut with category retake (never take_select/keep/reorder)", () => {
		const ops = mapRetakeCuts({ cuts: [
			cut({ startSec: 0, endSec: 1, confidence: 0.6 }),
			cut({ startSec: 2, endSec: 3, confidence: 0.9 }),
		] });
		expect(ops.every((o) => o.op === "cut")).toBe(true);
		expect(ops.every((o) => o.category === "retake")).toBe(true);
	});

	test("carries the LLM reason (clamped), preserves seconds, stable + unique ids", () => {
		const ops = mapRetakeCuts({ cuts: [
			cut({ startSec: 1.234, endSec: 2.5, confidence: 0.8, reason: "stumble" }),
			cut({ startSec: 6, endSec: 7, confidence: 0.8, reason: "" }),
		] });
		expect(ops[0].reason).toBe("stumble");
		expect(ops[1].reason).toBe("Retake or false start"); // empty reason → default
		expect([ops[0].startSec, ops[0].endSec]).toEqual([1.234, 2.5]);
		expect(ops[0].id).toMatch(/^retake-/);
		expect(ops[0].id).not.toBe(ops[1].id);
		// Re-running the same cuts yields the same ids (stable).
		const again = mapRetakeCuts({ cuts: [cut({ startSec: 1.234, endSec: 2.5, confidence: 0.8, reason: "x" })] });
		expect(again[0].id).toBe(ops[0].id);
	});

	test("empty input → no ops", () => {
		expect(mapRetakeCuts({ cuts: [] })).toEqual([]);
	});

	test("an explicit override floor is honored", () => {
		expect(mapRetakeCuts({ cuts: [cut({ startSec: 0, endSec: 1, confidence: 0.6 })], confidenceFloor: 0.7 })).toHaveLength(0);
		expect(mapRetakeCuts({ cuts: [cut({ startSec: 0, endSec: 1, confidence: 0.7 })], confidenceFloor: 0.7 })).toHaveLength(1);
	});
});

describe("trimRetakeCuts", () => {
	const op = (startSec: number, endSec: number) =>
		mapRetakeCuts({ cuts: [cut({ startSec, endSec, confidence: 0.9 })] })[0];

	test("partial overlap with an existing removal keeps the new-material remainder", () => {
		const trimmed = trimRetakeCuts({
			ops: [op(10, 20)],
			blockers: [{ startSec: 8, endSec: 12 }],
		});
		expect(trimmed).toHaveLength(1);
		expect([trimmed[0].startSec, trimmed[0].endSec]).toEqual([12, 20]);
		expect(trimmed[0].category).toBe("retake");
		expect(trimmed[0].defaultAccept).toBe(false);
	});

	test("a candidate spanning a keeper splits around it (keeper words never cut)", () => {
		const trimmed = trimRetakeCuts({
			ops: [op(0, 10)],
			blockers: [],
			keepers: [{ startSec: 4, endSec: 6 }],
		});
		expect(trimmed).toHaveLength(2);
		expect([trimmed[0].startSec, trimmed[0].endSec]).toEqual([0, 4]);
		expect([trimmed[1].startSec, trimmed[1].endSec]).toEqual([6, 10]);
		expect(trimmed[0].id).not.toBe(trimmed[1].id);
	});

	test("fully covered candidate drops to nothing; sliver remainders drop too", () => {
		expect(
			trimRetakeCuts({ ops: [op(3, 4)], blockers: [{ startSec: 2.5, endSec: 4.5 }] }),
		).toHaveLength(0);
		expect(
			trimRetakeCuts({
				ops: [op(0, 5)],
				blockers: [{ startSec: MIN_RETAKE_REMAINDER_SEC - 0.1, endSec: 5 }],
			}),
		).toHaveLength(0);
	});

	test("untouched candidate passes through byte-identical (same id)", () => {
		const original = op(1, 2);
		const trimmed = trimRetakeCuts({ ops: [original], blockers: [{ startSec: 5, endSec: 6 }] });
		expect(trimmed).toEqual([original]);
	});

	test("multiple overlapping blockers subtract cumulatively in order", () => {
		const trimmed = trimRetakeCuts({
			ops: [op(0, 12)],
			blockers: [
				{ startSec: 2, endSec: 4 },
				{ startSec: 3, endSec: 6 },
				{ startSec: 9, endSec: 10 },
			],
		});
		expect(trimmed.map((t) => [t.startSec, t.endSec])).toEqual([
			[0, 2],
			[6, 9],
			[10, 12],
		]);
	});
});
