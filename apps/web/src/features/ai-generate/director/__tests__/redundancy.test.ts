import { describe, expect, test } from "bun:test";
import { detectRedundancyCuts } from "../redundancy";
import type { ClusterMember, TakeCluster } from "../take-clusters";

function member(partial: Partial<ClusterMember> & { index: number; startSec: number; endSec: number; text: string }): ClusterMember {
	return { assetId: "a", audioScore: 0.5, ...partial };
}

const LINE = "today we ship the brand new editor";

describe("detectRedundancyCuts", () => {
	test("a cross-asset cluster emits a take_select over the non-keeper, in timeline coords", () => {
		const cluster: TakeCluster = {
			kind: "take",
			members: [
				member({ index: 0, assetId: "a", startSec: 0, endSec: 3, text: LINE, audioScore: 0.4 }),
				member({ index: 1, assetId: "b", startSec: 3, endSec: 6, text: LINE, audioScore: 0.85 }),
			],
			keeperIndex: 1,
			nearTie: false,
			lowConfidence: false,
			similarity: 1,
		};
		const { ops, nearTies } = detectRedundancyCuts({ clusters: [cluster] });
		expect(nearTies).toHaveLength(0);
		expect(ops).toHaveLength(1);
		expect(ops[0].op).toBe("take_select");
		expect(ops[0].category).toBe("take");
		expect(ops[0].startSec).toBe(0); // the non-keeper (asset a), timeline coords
		expect(ops[0].endSec).toBe(3);
		expect(ops[0].confidence).toBeGreaterThan(0.7);
		expect(ops[0].reason.length).toBeGreaterThan(0);
	});

	test("a far-apart same-asset repeat emits a low-confidence cut", () => {
		const cluster: TakeCluster = {
			kind: "repeat",
			members: [
				member({ index: 0, startSec: 0, endSec: 3, text: LINE, audioScore: 0.5 }),
				member({ index: 1, startSec: 200, endSec: 203, text: LINE, audioScore: 0.6 }),
			],
			keeperIndex: 1,
			nearTie: false,
			lowConfidence: true,
			similarity: 1,
		};
		const { ops } = detectRedundancyCuts({ clusters: [cluster] });
		expect(ops).toHaveLength(1);
		expect(ops[0].op).toBe("cut");
		expect(ops[0].category).toBe("repeat");
		expect(ops[0].startSec).toBe(0); // the earlier instance is cut
		expect(ops[0].confidence).toBeLessThanOrEqual(0.5);
	});

	test("a near-tie emits NO removal op — only an informational note", () => {
		const cluster: TakeCluster = {
			kind: "take",
			members: [
				member({ index: 0, assetId: "a", startSec: 0, endSec: 3, text: LINE, audioScore: 0.5 }),
				member({ index: 1, assetId: "b", startSec: 3, endSec: 6, text: LINE, audioScore: 0.52 }),
			],
			keeperIndex: 1,
			nearTie: true,
			lowConfidence: false,
			similarity: 1,
		};
		const { ops, nearTies } = detectRedundancyCuts({ clusters: [cluster] });
		expect(ops).toHaveLength(0);
		expect(nearTies).toHaveLength(1);
		expect(nearTies[0].members).toHaveLength(2);
	});

	test("the precision guard skips a member not actually similar to the keeper", () => {
		// A transitively-linked outlier whose similarity to the keeper is below the
		// merge threshold must NOT be removed (it could be distinct content).
		const cluster: TakeCluster = {
			kind: "take",
			members: [
				member({ index: 0, assetId: "a", startSec: 0, endSec: 3, text: "an entirely different sentence about cats", audioScore: 0.4 }),
				member({ index: 1, assetId: "b", startSec: 3, endSec: 6, text: LINE, audioScore: 0.85 }),
			],
			keeperIndex: 1,
			nearTie: false,
			lowConfidence: false,
			similarity: 0.3,
		};
		const { ops } = detectRedundancyCuts({ clusters: [cluster] });
		expect(ops).toHaveLength(0);
	});

	test("a 3-take cluster yields exactly 2 removals; the keeper is never cut", () => {
		const cluster: TakeCluster = {
			kind: "take",
			members: [
				member({ index: 0, assetId: "a", startSec: 0, endSec: 3, text: LINE, audioScore: 0.4 }),
				member({ index: 1, assetId: "b", startSec: 3, endSec: 6, text: LINE, audioScore: 0.6 }),
				member({ index: 2, assetId: "c", startSec: 6, endSec: 9, text: LINE, audioScore: 0.9 }),
			],
			keeperIndex: 2,
			nearTie: false,
			lowConfidence: false,
			similarity: 1,
		};
		const { ops } = detectRedundancyCuts({ clusters: [cluster] });
		expect(ops).toHaveLength(2);
		// The keeper span (6–9) is never among the removals.
		expect(ops.every((o) => o.startSec !== 6)).toBe(true);
	});

	test("no clusters → no ops, no notes", () => {
		expect(detectRedundancyCuts({ clusters: [] })).toEqual({ ops: [], nearTies: [] });
	});
});
