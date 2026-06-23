import { describe, expect, test } from "bun:test";
import { nearestLowEnergyTime, snapRemovalOps } from "../snap-cut";
import type { DirectorOp } from "@framecut/hf-bridge";

const WIN = 0.05; // ENERGY_WINDOW_SEC default

const cut = ({
	startSec,
	endSec,
	op = "cut",
}: {
	startSec: number;
	endSec: number;
	op?: DirectorOp["op"];
}): DirectorOp => ({
	id: `t-${startSec}-${endSec}`,
	op,
	startSec,
	endSec,
	reason: "test",
	confidence: 0.5,
});

describe("nearestLowEnergyTime", () => {
	test("moves the boundary to a strictly quieter nearby window", () => {
		// windows: index 20 (=1.0s) is loud, index 22 (=1.1s) is the trough.
		const envelope = new Array<number>(40).fill(0.9);
		envelope[22] = 0.05;
		const t = nearestLowEnergyTime({ envelope, windowSec: WIN, centerSec: 1.0, searchSec: 0.1 });
		expect(t).toBeCloseTo((22 + 0.5) * WIN, 3); // 1.125s
	});

	test("no-ops when the boundary is already the local minimum", () => {
		const envelope = new Array<number>(40).fill(0.9);
		envelope[20] = 0.05; // 1.0s is already quietest
		const t = nearestLowEnergyTime({ envelope, windowSec: WIN, centerSec: 1.0, searchSec: 0.1 });
		expect(t).toBe(1.0);
	});

	test("empty envelope or zero radius returns the center unchanged", () => {
		expect(nearestLowEnergyTime({ envelope: [], windowSec: WIN, centerSec: 1.0, searchSec: 0.1 })).toBe(1.0);
		const env = new Array<number>(40).fill(0.5);
		expect(nearestLowEnergyTime({ envelope: env, windowSec: WIN, centerSec: 1.0, searchSec: 0 })).toBe(1.0);
	});
});

describe("snapRemovalOps", () => {
	test("snaps a cut's edges to surrounding troughs", () => {
		const envelope = new Array<number>(80).fill(0.9);
		envelope[18] = 0.05; // 0.9s trough (near start 1.0)
		envelope[42] = 0.05; // 2.1s trough (near end 2.0)
		const ops = snapRemovalOps({
			ops: [cut({ startSec: 1.0, endSec: 2.0 })],
			envelope,
		});
		expect(ops).toHaveLength(1);
		expect(ops[0].startSec).toBeCloseTo((18 + 0.5) * WIN, 3); // 0.925s
		expect(ops[0].endSec).toBeCloseTo((42 + 0.5) * WIN, 3); // 2.125s
	});

	test("leaves reorder ops untouched", () => {
		const envelope = new Array<number>(80).fill(0.9);
		envelope[18] = 0.05;
		const reorder = cut({ startSec: 1.0, endSec: 2.0, op: "reorder" });
		const ops = snapRemovalOps({ ops: [reorder], envelope });
		expect(ops[0].startSec).toBe(1.0);
		expect(ops[0].endSec).toBe(2.0);
	});

	test("empty envelope passes ops through unchanged", () => {
		const input = [cut({ startSec: 1.0, endSec: 2.0 })];
		const ops = snapRemovalOps({ ops: input, envelope: [] });
		expect(ops).toEqual(input);
	});

	test("clips an overlap a snap would introduce between two cuts", () => {
		// Two cuts end-to-end at 1.0; the first's end snaps later, the second's start
		// snaps earlier — they would cross. The clip pass keeps them disjoint.
		const envelope = new Array<number>(80).fill(0.9);
		envelope[22] = 0.05; // 1.1s — pulls cut A's end forward
		envelope[18] = 0.05; // 0.9s — pulls cut B's start back
		const ops = snapRemovalOps({
			ops: [cut({ startSec: 0.5, endSec: 1.0 }), cut({ startSec: 1.0, endSec: 1.5 })],
			envelope,
		});
		// No removal starts before the previous one ends.
		for (let i = 1; i < ops.length; i++) {
			expect(ops[i].startSec).toBeGreaterThanOrEqual(ops[i - 1].endSec - 1e-9);
		}
	});

	test("keeps the original range when snapping would invert it", () => {
		// A 1-frame cut where both edges resolve into the same trough window.
		const envelope = new Array<number>(80).fill(0.9);
		envelope[20] = 0.05;
		const original = cut({ startSec: 1.0, endSec: 1.02 });
		const ops = snapRemovalOps({ ops: [original], envelope });
		expect(ops[0].endSec).toBeGreaterThan(ops[0].startSec);
	});
});
