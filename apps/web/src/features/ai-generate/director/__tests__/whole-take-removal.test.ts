/**
 * U3 Part A: a redundant take is removed as ONE whole-span cut per non-keeper,
 * not nibbled into fragments. Composes the pure detectors exactly as run-director
 * wires them (detectRedundancyCuts → mergeDetectedCuts keeper protection → the
 * clip-edge snap), so the whole-take behavior is locked without the full Director.
 */
import { describe, expect, test } from "bun:test";
import { detectRedundancyCuts } from "../redundancy";
import { mergeDetectedCuts } from "../cut-utils";
import { snapRemovalsToClipEdges } from "../snap-cut";
import type { TakeCluster, ClusterMember } from "../take-clusters";
import type { DirectorOp } from "@framecut/hf-bridge";

const member = ({
	index,
	assetId,
	startSec,
	endSec,
	text = "the exact same line spoken again",
}: {
	index: number;
	assetId: string;
	startSec: number;
	endSec: number;
	text?: string;
}): ClusterMember => ({ index, assetId, startSec, endSec, text, audioScore: 0 });

// A 3-take cluster of one recording restating the SAME line three times. members are
// timeline-ordered; keeper is the LATEST take (keeperIndex 2).
const threeTakeCluster: TakeCluster = {
	kind: "repeat",
	members: [
		member({ index: 0, assetId: "A", startSec: 10, endSec: 15 }),
		member({ index: 1, assetId: "A", startSec: 20, endSec: 25 }),
		member({ index: 2, assetId: "A", startSec: 30, endSec: 35 }),
	],
	keeperIndex: 2,
	lowConfidence: false,
	similarity: 1,
};

describe("whole-take removal (U3 Part A)", () => {
	test("a 3-take cluster emits one whole-span cut per non-keeper; keeper untouched", () => {
		const { ops } = detectRedundancyCuts({ clusters: [threeTakeCluster] });
		expect(ops).toHaveLength(2); // the two earlier takes, not the keeper
		// Each cut is the FULL member span, not a fragment of it.
		expect(ops.map((o) => [o.startSec, o.endSec]).sort((a, b) => a[0] - b[0])).toEqual([
			[10, 15],
			[20, 25],
		]);
		// keeper [30,35] is never cut.
		expect(ops.some((o) => o.startSec === 30 || o.endSec === 35)).toBe(false);
		expect(ops.every((o) => o.op === "cut")).toBe(true);
	});

	test("the keeper span is protected through the merge; the non-keeper takes still cut", () => {
		const { ops } = detectRedundancyCuts({ clusters: [threeTakeCluster] });
		const keeper = { startSec: 30, endSec: 35 };
		// A per-line cleaning cut (filler) landing INSIDE a non-keeper take.
		const containedFiller: DirectorOp = {
			id: "f",
			op: "cut",
			startSec: 12,
			endSec: 12.3,
			reason: "filler",
			confidence: 0.8,
			category: "filler",
		};
		const merged = mergeDetectedCuts({
			planOps: [],
			extraOps: [...ops, containedFiller],
			keepers: [keeper],
		});
		// Both whole-take cuts survive; the keeper span is never removed.
		expect(merged.some((o) => o.startSec === 10 && o.endSec === 15)).toBe(true);
		expect(merged.some((o) => o.startSec === 20 && o.endSec === 25)).toBe(true);
		expect(merged.some((o) => o.startSec >= 30 && o.endSec <= 35)).toBe(false);
	});

	test("a single op per non-keeper (no separate linked-audio op): the whole-take cut is one timeline span", () => {
		// Removing a whole take is a single [startSec,endSec) timeline removal, applied
		// as one ripple across all tracks, so the linked audio partner is never removed
		// by a SECOND, independent op. detectRedundancyCuts emits exactly one op per take.
		const { ops } = detectRedundancyCuts({ clusters: [threeTakeCluster] });
		expect(ops).toHaveLength(2);
		expect(new Set(ops.map((o) => o.id)).size).toBe(2); // distinct, one per take
	});

	test("whole-take cut edges snap out to nearby clip boundaries (no leftover sliver)", () => {
		const { ops } = detectRedundancyCuts({ clusters: [threeTakeCluster] });
		// Clip [9.9, 15.1] surrounds the [10,15] take within a 0.2s tolerance.
		const snapped = snapRemovalsToClipEdges({
			ops,
			clipStartsSec: [9.9],
			clipEndsSec: [15.1],
			toleranceSec: 0.2,
		});
		const first = snapped.find((o) => o.startSec <= 10.001);
		expect(first?.startSec).toBeCloseTo(9.9, 5);
		expect(first?.endSec).toBeCloseTo(15.1, 5);
	});
});
