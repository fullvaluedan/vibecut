import { describe, expect, mock, test } from "bun:test";
import type { DirectorOp } from "@framecut/hf-bridge";

// apply-plan imports `@/wasm` + several command classes at module top; stub them
// so the pure helpers import under bun. The glue (applyDirectorPlan) composes the
// commands and is verified live; planRemovalRanges + planReorderMoves hold the
// logic and are tested here.
mock.module("@/wasm", () => ({
	TICKS_PER_SECOND: 120_000,
	mediaTime: ({ ticks }: { ticks: number }) => ticks,
}));
mock.module("@/commands/timeline/track/remove-ranges", () => ({
	RemoveRangesCommand: class {},
}));
mock.module("@/commands/timeline/element/move-elements", () => ({
	MoveElementCommand: class {},
}));
mock.module("@/commands/batch-command", () => ({ BatchCommand: class {} }));

const { planRemovalRanges, planReorderMoves } = await import("../apply-plan");

const op = (
	o: Partial<DirectorOp> & Pick<DirectorOp, "op" | "startSec" | "endSec">,
): DirectorOp => ({ id: "op_x", reason: "r", confidence: 0.8, ...o });

const el = ([elementId, startTimeTicks, durationTicks, trackId = "main"]: [
	string,
	number,
	number,
	string?,
]) => ({ elementId, trackId, startTimeTicks, durationTicks });

describe("planRemovalRanges", () => {
	test("keeps cut + take_select as tick ranges, ignores keep + reorder", () => {
		const ops: DirectorOp[] = [
			op({ op: "cut", startSec: 1, endSec: 2 }),
			op({ op: "keep", startSec: 2, endSec: 3 }),
			op({ op: "take_select", startSec: 5, endSec: 6 }),
			op({ op: "reorder", startSec: 8, endSec: 9, targetStartSec: 0 }),
		];
		const { ranges, removedSec } = planRemovalRanges({
			ops,
			ticksPerSecond: 120_000,
		});
		expect(ranges).toEqual([
			{ start: 120_000, end: 240_000 },
			{ start: 600_000, end: 720_000 },
		]);
		expect(removedSec).toBe(2); // 1s + 1s
	});

	test("no removals yields empty ranges", () => {
		const { ranges, removedSec } = planRemovalRanges({
			ops: [op({ op: "reorder", startSec: 1, endSec: 2, targetStartSec: 0 })],
			ticksPerSecond: 120_000,
		});
		expect(ranges).toEqual([]);
		expect(removedSec).toBe(0);
	});

	test("rounds fractional seconds to whole ticks", () => {
		const { ranges } = planRemovalRanges({
			ops: [op({ op: "cut", startSec: 1.5, endSec: 2.25 })],
			ticksPerSecond: 120_000,
		});
		expect(ranges).toEqual([{ start: 180_000, end: 270_000 }]);
	});
});

describe("planReorderMoves", () => {
	test("shifts elements FULLY contained in the span by the target delta", () => {
		const moves = planReorderMoves({
			ops: [op({ op: "reorder", startSec: 8, endSec: 12, targetStartSec: 0 })],
			ticksPerSecond: 120_000,
			elements: [
				el(["a", 960_000, 240_000]), // 8s..10s — contained → moves to 0
				el(["b", 1_320_000, 240_000]), // 11s..13s — straddles span end → not moved
				el(["c", 0, 120_000]), // 0s..1s — outside span → not moved
			],
		});
		expect(moves).toEqual([
			{ elementId: "a", trackId: "main", newStartTimeTicks: 0 },
		]);
	});

	test("target equal to start (no movement) yields nothing", () => {
		const moves = planReorderMoves({
			ops: [op({ op: "reorder", startSec: 5, endSec: 7, targetStartSec: 5 })],
			ticksPerSecond: 120_000,
			elements: [el(["a", 600_000, 120_000])],
		});
		expect(moves).toEqual([]);
	});

	test("ignores non-reorder ops and reorders without a target", () => {
		const moves = planReorderMoves({
			ops: [
				op({ op: "cut", startSec: 0, endSec: 12 }),
				op({ op: "reorder", startSec: 0, endSec: 12 }), // no targetStartSec
			],
			ticksPerSecond: 120_000,
			elements: [el(["a", 0, 120_000])],
		});
		expect(moves).toEqual([]);
	});

	test("clamps a negative target to zero and keeps the source track", () => {
		const moves = planReorderMoves({
			ops: [op({ op: "reorder", startSec: 10, endSec: 12, targetStartSec: 0 })],
			ticksPerSecond: 120_000,
			elements: [el(["v", 1_200_000, 120_000, "overlay-1"])],
		});
		expect(moves).toEqual([
			{ elementId: "v", trackId: "overlay-1", newStartTimeTicks: 0 },
		]);
	});
});
