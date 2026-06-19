import { describe, expect, mock, test } from "bun:test";
import type { DirectorOp } from "@framecut/hf-bridge";
import type { DirectorApplyEditor } from "../apply-plan";

// apply-plan imports `@/wasm` + several command classes at module top; stub them
// so the helpers import under bun. The command stubs CAPTURE their constructor args
// (and carry identity via instanceof) so applyDirectorPlan's composition — which
// command runs, in what order — is assertable; planRemovalRanges + planReorderMoves
// hold the pure logic.
mock.module("@/wasm", () => ({
	TICKS_PER_SECOND: 120_000,
	mediaTime: ({ ticks }: { ticks: number }) => ticks,
}));

class FakeRemoveRangesCommand {
	readonly ranges: { start: number; end: number }[];
	constructor(args: { ranges: { start: number; end: number }[] }) {
		this.ranges = args.ranges;
	}
	getRemovedCount(): number {
		return this.ranges.length;
	}
}
class FakeMoveElementCommand {
	readonly moves: unknown[];
	constructor(args: { moves: unknown[] }) {
		this.moves = args.moves;
	}
}
class FakeBatchCommand {
	readonly commands: unknown[];
	constructor(commands: unknown[]) {
		this.commands = commands;
	}
}

mock.module("@/commands/timeline/track/remove-ranges", () => ({
	RemoveRangesCommand: FakeRemoveRangesCommand,
}));
mock.module("@/commands/timeline/element/move-elements", () => ({
	MoveElementCommand: FakeMoveElementCommand,
}));
mock.module("@/commands/batch-command", () => ({ BatchCommand: FakeBatchCommand }));

const { applyDirectorPlan, planRemovalRanges, planReorderMoves, planKeepInverseRanges, applyHighlightPlan } =
	await import("../apply-plan");

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

interface ReorderElementFixture {
	id: string;
	startTime: number;
	duration: number;
	trackId?: string;
}

// A plain DirectorApplyEditor stub exposing only what applyDirectorPlan reads: the
// active scene's tracks (elements default to main) and a command.execute spy. No
// cast needed — the apply takes the segregated interface, not the full EditorCore.
function fakeEditor(elements: ReorderElementFixture[] = []): {
	editor: DirectorApplyEditor;
	executed: unknown[];
} {
	const executed: unknown[] = [];
	const onTrack = (id: string) =>
		elements
			.filter((e) => (e.trackId ?? "main") === id)
			.map((e) => ({ id: e.id, startTime: e.startTime, duration: e.duration }));
	const editor: DirectorApplyEditor = {
		scenes: {
			getActiveScene: () => ({
				tracks: {
					main: { id: "main", elements: onTrack("main") },
					overlay: [],
					audio: [],
				},
			}),
		},
		command: {
			execute: ({ command }) => {
				executed.push(command);
			},
		},
	};
	return { editor, executed };
}

describe("applyDirectorPlan (composition glue)", () => {
	test("removals-only plan executes a BARE RemoveRangesCommand, reorders: 0 (R6)", () => {
		const { editor, executed } = fakeEditor();
		const result = applyDirectorPlan({
			editor,
			ops: [op({ op: "cut", startSec: 1, endSec: 2 })],
		});
		expect(executed).toHaveLength(1);
		expect(executed[0]).toBeInstanceOf(FakeRemoveRangesCommand);
		expect(executed[0]).not.toBeInstanceOf(FakeBatchCommand);
		expect(result).toEqual({ cuts: 1, removedSec: 1, reorders: 0 });
	});

	test("reorder + cut executes ONE BatchCommand wrapping [Move, Remove] in that order (KTD-1)", () => {
		const { editor, executed } = fakeEditor([
			{ id: "a", startTime: 960_000, duration: 240_000 }, // 8s..10s
		]);
		const result = applyDirectorPlan({
			editor,
			ops: [
				op({ op: "reorder", startSec: 8, endSec: 10, targetStartSec: 0 }),
				op({ op: "cut", startSec: 1, endSec: 2 }),
			],
		});
		expect(executed).toHaveLength(1);
		const batch = executed[0];
		expect(batch).toBeInstanceOf(FakeBatchCommand);
		// Reorders composed FIRST so removal ranges (original coords) still line up.
		if (batch instanceof FakeBatchCommand) {
			expect(batch.commands[0]).toBeInstanceOf(FakeMoveElementCommand);
			expect(batch.commands[1]).toBeInstanceOf(FakeRemoveRangesCommand);
		}
		expect(result.reorders).toBe(1);
		expect(result.cuts).toBe(1);
	});

	test("reorder-only plan executes a single MoveElementCommand (not batched)", () => {
		const { editor, executed } = fakeEditor([
			{ id: "a", startTime: 960_000, duration: 240_000 },
		]);
		const result = applyDirectorPlan({
			editor,
			ops: [op({ op: "reorder", startSec: 8, endSec: 10, targetStartSec: 0 })],
		});
		expect(executed).toHaveLength(1);
		expect(executed[0]).toBeInstanceOf(FakeMoveElementCommand);
		expect(executed[0]).not.toBeInstanceOf(FakeBatchCommand);
		expect(result).toEqual({ cuts: 0, removedSec: 0, reorders: 1 });
	});

	test("empty / all-keep plan executes nothing", () => {
		const { editor, executed } = fakeEditor();
		const result = applyDirectorPlan({
			editor,
			ops: [op({ op: "keep", startSec: 1, endSec: 2 })],
		});
		expect(executed).toHaveLength(0);
		expect(result).toEqual({ cuts: 0, removedSec: 0, reorders: 0 });
	});
});

describe("planKeepInverseRanges (Highlight inverse apply)", () => {
	const TPS = 120_000;
	const rg = ([startSec, endSec]: [number, number]) => ({
		start: startSec * TPS,
		end: endSec * TPS,
	});

	test("removes the complement of the kept spans", () => {
		const { ranges, removedSec } = planKeepInverseRanges({
			keeps: [
				{ startSec: 2, endSec: 5 },
				{ startSec: 10, endSec: 12 },
			],
			totalSec: 15,
			ticksPerSecond: TPS,
		});
		expect(ranges).toEqual([rg([0, 2]), rg([5, 10]), rg([12, 15])]);
		expect(removedSec).toBe(10);
	});

	test("partial acceptance: only the accepted spans survive", () => {
		const { ranges } = planKeepInverseRanges({
			keeps: [
				{ startSec: 2, endSec: 5 },
				{ startSec: 20, endSec: 25 },
			],
			totalSec: 30,
			ticksPerSecond: TPS,
		});
		expect(ranges).toEqual([rg([0, 2]), rg([5, 20]), rg([25, 30])]);
	});

	test("adjacent/overlapping keeps merge before complementing (no zero-length ranges)", () => {
		const { ranges } = planKeepInverseRanges({
			keeps: [
				{ startSec: 2, endSec: 5 },
				{ startSec: 5, endSec: 8 },
				{ startSec: 4, endSec: 6 },
			],
			totalSec: 10,
			ticksPerSecond: TPS,
		});
		expect(ranges).toEqual([rg([0, 2]), rg([8, 10])]);
	});

	test("a full-timeline keep removes nothing", () => {
		const { ranges, removedSec } = planKeepInverseRanges({
			keeps: [{ startSec: 0, endSec: 12 }],
			totalSec: 12,
			ticksPerSecond: TPS,
		});
		expect(ranges).toEqual([]);
		expect(removedSec).toBe(0);
	});

	test("an empty / all-invalid keep set throws (never removes the whole timeline)", () => {
		expect(() => planKeepInverseRanges({ keeps: [], totalSec: 15, ticksPerSecond: TPS })).toThrow(
			/nothing to keep/,
		);
		expect(() =>
			planKeepInverseRanges({
				keeps: [{ startSec: 5, endSec: 5 }],
				totalSec: 15,
				ticksPerSecond: TPS,
			}),
		).toThrow(/nothing to keep/);
	});

	test("a sub-frame complement gap is not emitted (boundary tolerance)", () => {
		const { ranges } = planKeepInverseRanges({
			keeps: [
				{ startSec: 0, endSec: 5 },
				{ startSec: 5.02, endSec: 10 },
			],
			totalSec: 10,
			ticksPerSecond: TPS,
		});
		expect(ranges).toEqual([]);
	});

	test("keeps beyond the timeline are clamped", () => {
		const { ranges } = planKeepInverseRanges({
			keeps: [
				{ startSec: 2, endSec: 5 },
				{ startSec: 12, endSec: 20 },
			],
			totalSec: 15,
			ticksPerSecond: TPS,
		});
		expect(ranges).toEqual([rg([0, 2]), rg([5, 12])]);
	});

	test("idempotent: the same keep set yields the same ranges", () => {
		const args = { keeps: [{ startSec: 3, endSec: 6 }], totalSec: 12, ticksPerSecond: TPS };
		expect(planKeepInverseRanges(args).ranges).toEqual(planKeepInverseRanges(args).ranges);
	});
});

describe("applyHighlightPlan (composition glue)", () => {
	test("removes the complement of the kept spans as one RemoveRangesCommand", () => {
		const { editor, executed } = fakeEditor();
		const result = applyHighlightPlan({
			editor,
			keeps: [
				{ startSec: 2, endSec: 5 },
				{ startSec: 10, endSec: 12 },
			],
			totalSec: 15,
		});
		expect(executed).toHaveLength(1);
		expect(executed[0]).toBeInstanceOf(FakeRemoveRangesCommand);
		if (executed[0] instanceof FakeRemoveRangesCommand) {
			expect(executed[0].ranges).toEqual([
				{ start: 0, end: 240_000 },
				{ start: 600_000, end: 1_200_000 },
				{ start: 1_440_000, end: 1_800_000 },
			]);
		}
		expect(result.removedSec).toBe(10);
	});

	test("a full-timeline keep executes nothing", () => {
		const { editor, executed } = fakeEditor();
		const result = applyHighlightPlan({
			editor,
			keeps: [{ startSec: 0, endSec: 12 }],
			totalSec: 12,
		});
		expect(executed).toHaveLength(0);
		expect(result).toEqual({ cuts: 0, removedSec: 0 });
	});

	test("an empty keep set throws (never removes everything)", () => {
		const { editor } = fakeEditor();
		expect(() => applyHighlightPlan({ editor, keeps: [], totalSec: 12 })).toThrow(/nothing to keep/);
	});
});
