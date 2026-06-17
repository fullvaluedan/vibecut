import { describe, expect, mock, test } from "bun:test";
import type { DirectorOp } from "@framecut/hf-bridge";

// apply-plan imports `@/wasm` (TICKS_PER_SECOND) and RemoveRangesCommand at module
// top; stub both so the pure helper can be imported under bun. The glue
// (applyDirectorPlan) is a thin wrapper over the proven remove-repeats pattern and
// is verified live; planRemovalRanges holds the logic and is tested here.
mock.module("@/wasm", () => ({ TICKS_PER_SECOND: 120_000 }));
mock.module("@/commands/timeline/track/remove-ranges", () => ({
	RemoveRangesCommand: class {},
}));

const { planRemovalRanges } = await import("../apply-plan");

const op = (
	o: Partial<DirectorOp> & Pick<DirectorOp, "op" | "startSec" | "endSec">,
): DirectorOp => ({ id: "op_x", reason: "r", confidence: 0.8, ...o });

describe("planRemovalRanges", () => {
	test("keeps cut + take_select as tick ranges, ignores keep, counts reorders", () => {
		const ops: DirectorOp[] = [
			op({ op: "cut", startSec: 1, endSec: 2 }),
			op({ op: "keep", startSec: 2, endSec: 3 }),
			op({ op: "take_select", startSec: 5, endSec: 6 }),
			op({ op: "reorder", startSec: 8, endSec: 9, targetStartSec: 0 }),
		];
		const { ranges, removedSec, reorders } = planRemovalRanges({
			ops,
			ticksPerSecond: 120_000,
		});
		expect(ranges).toEqual([
			{ start: 120_000, end: 240_000 },
			{ start: 600_000, end: 720_000 },
		]);
		expect(removedSec).toBe(2); // 1s + 1s
		expect(reorders).toBe(1);
	});

	test("no removals yields empty ranges (reorders still counted)", () => {
		const { ranges, removedSec, reorders } = planRemovalRanges({
			ops: [op({ op: "reorder", startSec: 1, endSec: 2, targetStartSec: 0 })],
			ticksPerSecond: 120_000,
		});
		expect(ranges).toEqual([]);
		expect(removedSec).toBe(0);
		expect(reorders).toBe(1);
	});

	test("rounds fractional seconds to whole ticks", () => {
		const { ranges } = planRemovalRanges({
			ops: [op({ op: "cut", startSec: 1.5, endSec: 2.25 })],
			ticksPerSecond: 120_000,
		});
		expect(ranges).toEqual([{ start: 180_000, end: 270_000 }]);
	});
});
