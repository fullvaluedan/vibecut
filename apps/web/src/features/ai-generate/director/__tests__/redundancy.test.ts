import { describe, expect, test } from "bun:test";
import { detectRedundancyCuts, TAKE_WINDOW_SEC } from "../redundancy";
import type { ClusterMember, TakeCluster } from "../take-clusters";

function member(
	partial: Partial<ClusterMember> & {
		index: number;
		startSec: number;
		endSec: number;
		text: string;
	},
): ClusterMember {
	return { assetId: "a", audioScore: 0.5, ...partial };
}

function takeCluster(
	partial: Partial<TakeCluster> & {
		members: ClusterMember[];
		keeperIndex: number;
	},
): TakeCluster {
	return { kind: "take", lowConfidence: false, similarity: 1, ...partial };
}

const LINE = "today we ship the brand new editor";

describe("detectRedundancyCuts (keep-last)", () => {
	test("a cross-asset cluster cuts the EARLIER take, keeping the latest", () => {
		const cluster = takeCluster({
			kind: "take",
			members: [
				member({ index: 0, assetId: "a", startSec: 0, endSec: 3, text: LINE }),
				member({ index: 1, assetId: "b", startSec: 3, endSec: 6, text: LINE }),
			],
			keeperIndex: 1, // latest
		});
		const { ops, nearTies } = detectRedundancyCuts({ clusters: [cluster] });
		expect(nearTies).toHaveLength(0);
		expect(ops).toHaveLength(1);
		expect(ops[0].op).toBe("take_select");
		expect(ops[0].category).toBe("take");
		expect(ops[0].startSec).toBe(0); // the EARLIER take is cut
		expect(ops[0].endSec).toBe(3);
		expect(ops[0].reason.length).toBeGreaterThan(0);
	});

	test("near-identical takes no longer punt — the earlier one is cut, latest kept", () => {
		// Previously a near-audio tie produced a "pick one yourself" note + no cut.
		const cluster = takeCluster({
			members: [
				member({ index: 0, assetId: "a", startSec: 0, endSec: 3, text: LINE, audioScore: 0.5 }),
				member({ index: 1, assetId: "b", startSec: 3, endSec: 6, text: LINE, audioScore: 0.52 }),
			],
			keeperIndex: 1,
		});
		const { ops, nearTies } = detectRedundancyCuts({ clusters: [cluster] });
		expect(nearTies).toHaveLength(0);
		expect(ops).toHaveLength(1);
		expect(ops[0].startSec).toBe(0); // earlier take cut
	});

	test("an earlier take FURTHER than the recency window is NOT cut", () => {
		// keeper at t=200; the earlier instance at t=0 is 200s before it (> window) →
		// probably legitimately repeated content (callback), so leave it.
		const cluster = takeCluster({
			kind: "repeat",
			members: [
				member({ index: 0, startSec: 0, endSec: 3, text: LINE }),
				member({ index: 1, startSec: 200, endSec: 203, text: LINE }),
			],
			keeperIndex: 1,
			lowConfidence: true,
		});
		expect(detectRedundancyCuts({ clusters: [cluster] }).ops).toHaveLength(0);
	});

	test("an earlier take JUST INSIDE the recency window IS cut", () => {
		const keeperStart = 130;
		const cluster = takeCluster({
			kind: "repeat",
			members: [
				member({
					index: 0,
					startSec: keeperStart - TAKE_WINDOW_SEC + 1,
					endSec: keeperStart - TAKE_WINDOW_SEC + 4,
					text: LINE,
				}),
				member({ index: 1, startSec: keeperStart, endSec: keeperStart + 3, text: LINE }),
			],
			keeperIndex: 1,
		});
		const { ops } = detectRedundancyCuts({ clusters: [cluster] });
		expect(ops).toHaveLength(1);
		expect(ops[0].op).toBe("cut");
	});

	test("the precision guard skips a member not actually similar to the keeper", () => {
		const cluster = takeCluster({
			members: [
				member({
					index: 0,
					assetId: "a",
					startSec: 0,
					endSec: 3,
					text: "an entirely different sentence about cats",
				}),
				member({ index: 1, assetId: "b", startSec: 3, endSec: 6, text: LINE }),
			],
			keeperIndex: 1,
			similarity: 0.3,
		});
		expect(detectRedundancyCuts({ clusters: [cluster] }).ops).toHaveLength(0);
	});

	test("a 3-take cluster (all in window) cuts the 2 earlier takes; keeper never cut", () => {
		const cluster = takeCluster({
			members: [
				member({ index: 0, assetId: "a", startSec: 0, endSec: 3, text: LINE }),
				member({ index: 1, assetId: "b", startSec: 3, endSec: 6, text: LINE }),
				member({ index: 2, assetId: "c", startSec: 6, endSec: 9, text: LINE }),
			],
			keeperIndex: 2, // latest
		});
		const { ops } = detectRedundancyCuts({ clusters: [cluster] });
		expect(ops).toHaveLength(2);
		expect(ops.every((o) => o.startSec !== 6)).toBe(true); // keeper span (6–9) never cut
	});

	test("no clusters → no ops, no notes", () => {
		expect(detectRedundancyCuts({ clusters: [] })).toEqual({ ops: [], nearTies: [] });
	});
});
