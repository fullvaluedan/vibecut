import { describe, expect, test } from "bun:test";
import {
	nearestLowEnergyTime,
	snapKeepSpans,
	snapRemovalOps,
	snapRemovalsToClipEdges,
} from "../snap-cut";
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

describe("snapKeepSpans", () => {
	test("expands a kept span OUTWARD to surrounding troughs", () => {
		const envelope = new Array<number>(80).fill(0.9);
		envelope[18] = 0.05; // 0.9s trough — before start 1.0 → start expands earlier
		envelope[42] = 0.05; // 2.1s trough — after end 2.0 → end expands later
		const [span] = snapKeepSpans({
			spans: [{ startSec: 1.0, endSec: 2.0 }],
			envelope,
		});
		expect(span.startSec).toBeCloseTo((18 + 0.5) * WIN, 3); // 0.925s (earlier)
		expect(span.endSec).toBeCloseTo((42 + 0.5) * WIN, 3); // 2.125s (later)
	});

	test("never shrinks a span into a word (start only earlier, end only later)", () => {
		// Troughs sit INSIDE the span; directional search must ignore them — a keep
		// must not pull its start later or its end earlier (that would clip a word).
		const envelope = new Array<number>(80).fill(0.9);
		envelope[22] = 0.05; // 1.1s — inside, would pull start later if undirected
		envelope[38] = 0.05; // 1.9s — inside, would pull end earlier if undirected
		const [span] = snapKeepSpans({
			spans: [{ startSec: 1.0, endSec: 2.0 }],
			envelope,
		});
		expect(span.startSec).toBeLessThanOrEqual(1.0);
		expect(span.endSec).toBeGreaterThanOrEqual(2.0);
	});

	test("clamps expansion so two close kept spans stay disjoint", () => {
		// A trough in the gap between the two spans is in BOTH expansion ranges; the
		// neighbour clamp keeps the snapped spans from crossing.
		const envelope = new Array<number>(120).fill(0.9);
		envelope[29] = 0.05; // ~1.45s, in the [1.4,1.5] gap between A and B
		const out = snapKeepSpans({
			spans: [
				{ startSec: 1.0, endSec: 1.4 },
				{ startSec: 1.5, endSec: 2.0 },
			],
			envelope,
		});
		for (let i = 1; i < out.length; i++) {
			expect(out[i].startSec).toBeGreaterThanOrEqual(out[i - 1].endSec - 1e-9);
		}
	});

	test("empty envelope passes spans through (sorted, cleaned)", () => {
		const out = snapKeepSpans({
			spans: [{ startSec: 1.0, endSec: 2.0 }],
			envelope: [],
		});
		expect(out).toEqual([{ startSec: 1.0, endSec: 2.0 }]);
	});
});

describe("snapRemovalsToClipEdges", () => {
	test("snaps a removal START back to a clip start to swallow a leading sliver", () => {
		// Clip [0,5]; the cut starts 0.07s in, leaving a 2-frame sliver at 0.
		const ops = snapRemovalsToClipEdges({
			ops: [cut({ startSec: 0.07, endSec: 4.0 })],
			clipStartsSec: [0],
			clipEndsSec: [5],
			toleranceSec: 0.5,
		});
		expect(ops[0].startSec).toBe(0);
		expect(ops[0].endSec).toBe(4.0);
	});

	test("snaps a removal END out to a clip end to swallow a trailing sliver", () => {
		const ops = snapRemovalsToClipEdges({
			ops: [cut({ startSec: 1.0, endSec: 4.6 })],
			clipStartsSec: [0],
			clipEndsSec: [5],
			toleranceSec: 0.5,
		});
		expect(ops[0].startSec).toBe(1.0);
		expect(ops[0].endSec).toBe(5);
	});

	test("does NOT snap when the boundary is farther than the tolerance", () => {
		const input = cut({ startSec: 1.0, endSec: 3.0 });
		const ops = snapRemovalsToClipEdges({
			ops: [input],
			clipStartsSec: [0],
			clipEndsSec: [5],
			toleranceSec: 0.5,
		});
		expect(ops[0].startSec).toBe(1.0);
		expect(ops[0].endSec).toBe(3.0);
	});

	test("leaves reorder ops untouched", () => {
		const reorder = cut({ startSec: 0.07, endSec: 4.0, op: "reorder" });
		const ops = snapRemovalsToClipEdges({
			ops: [reorder],
			clipStartsSec: [0],
			clipEndsSec: [5],
			toleranceSec: 0.5,
		});
		expect(ops[0].startSec).toBe(0.07);
	});

	test("zero tolerance is a pass-through", () => {
		const input = [cut({ startSec: 0.07, endSec: 4.0 })];
		expect(snapRemovalsToClipEdges({ ops: input, clipStartsSec: [0], clipEndsSec: [5], toleranceSec: 0 })).toEqual(input);
	});
});
