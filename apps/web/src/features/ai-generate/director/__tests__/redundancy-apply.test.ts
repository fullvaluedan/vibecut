import { describe, expect, test } from "bun:test";
import {
	cutMembersForKeeper,
	mapRedundancyGroups,
	shouldRunLexicalRepeatDetectors,
} from "../redundancy-apply";
import type { RedundancyGroup, RedundancyMember } from "@framecut/hf-bridge";

const member = ({ lineId, startSec, endSec }: { lineId: string; startSec: number; endSec: number }): RedundancyMember => ({
	lineId,
	startSec,
	endSec,
	text: lineId,
});

const group = ({
	members,
	keeperLineId,
	confidence,
	reason = "same point",
}: {
	members: RedundancyMember[];
	keeperLineId: string;
	confidence: number;
	reason?: string;
}): RedundancyGroup => ({ members, keeperLineId, confidence, reason });

describe("mapRedundancyGroups", () => {
	test("a 3-take group → 2 cuts over the non-keepers; keeper not cut; category redundancy", () => {
		const { cuts, groups } = mapRedundancyGroups({
			groups: [
				group({
					members: [
						member({ lineId: "L0", startSec: 0, endSec: 2 }),
						member({ lineId: "L1", startSec: 3, endSec: 5 }),
						member({ lineId: "L2", startSec: 6, endSec: 8 }),
					],
					keeperLineId: "L1",
					confidence: 0.9,
				}),
			],
		});
		expect(cuts).toHaveLength(2);
		expect(cuts.every((c) => c.op === "cut" && c.category === "redundancy")).toBe(true);
		// keeper L1 [3,5] is not cut
		expect(cuts.some((c) => c.startSec === 3 && c.endSec === 5)).toBe(false);
		expect(cuts.map((c) => c.startSec).sort()).toEqual([0, 6]);
		expect(groups).toHaveLength(1);
	});

	test("keeper can be the EARLIEST take → still cuts the later takes (not keep-last)", () => {
		const { cuts } = mapRedundancyGroups({
			groups: [
				group({
					members: [
						member({ lineId: "L0", startSec: 0, endSec: 2 }),
						member({ lineId: "L1", startSec: 3, endSec: 5 }),
					],
					keeperLineId: "L0", // earliest is the keeper
					confidence: 0.9,
				}),
			],
		});
		expect(cuts).toHaveLength(1);
		expect(cuts[0].startSec).toBe(3); // the LATER take is cut
	});

	test("a keeper-only group → 0 cuts (defensive)", () => {
		const { cuts, groups } = mapRedundancyGroups({
			groups: [group({ members: [member({ lineId: "L0", startSec: 0, endSec: 2 })], keeperLineId: "L0", confidence: 0.9 })],
		});
		expect(cuts).toHaveLength(0);
		expect(groups).toHaveLength(0);
	});

	test("confidence floor is inclusive: 0.6 dropped, exactly 0.7 kept", () => {
		const mk = (confidence: number) =>
			group({
				members: [member({ lineId: "L0", startSec: 0, endSec: 2 }), member({ lineId: "L1", startSec: 3, endSec: 5 })],
				keeperLineId: "L1",
				confidence,
			});
		expect(mapRedundancyGroups({ groups: [mk(0.6)], confidenceFloor: 0.7 }).cuts).toHaveLength(0);
		expect(mapRedundancyGroups({ groups: [mk(0.7)], confidenceFloor: 0.7 }).cuts).toHaveLength(1);
	});

	test("two groups → a flat list of all non-keeper cuts", () => {
		const { cuts } = mapRedundancyGroups({
			groups: [
				group({
					members: [member({ lineId: "L0", startSec: 0, endSec: 2 }), member({ lineId: "L1", startSec: 3, endSec: 5 })],
					keeperLineId: "L1",
					confidence: 0.9,
				}),
				group({
					members: [member({ lineId: "L5", startSec: 20, endSec: 22 }), member({ lineId: "L6", startSec: 23, endSec: 25 })],
					keeperLineId: "L5",
					confidence: 0.8,
				}),
			],
		});
		expect(cuts.map((c) => c.startSec).sort((a, b) => a - b)).toEqual([0, 23]);
	});

	test("empty groups → no cuts", () => {
		expect(mapRedundancyGroups({ groups: [] }).cuts).toEqual([]);
	});
});

describe("cutMembersForKeeper (swap-to-alternate recompute)", () => {
	const members = [
		member({ lineId: "L0", startSec: 0, endSec: 2 }),
		member({ lineId: "L1", startSec: 3, endSec: 5 }),
		member({ lineId: "L2", startSec: 6, endSec: 8 }),
	];

	test("swapping to the CURRENT keeper returns the original cut set (no-op)", () => {
		const cut = cutMembersForKeeper({ members, keeperLineId: "L1" });
		expect(cut.map((m) => m.lineId)).toEqual(["L0", "L2"]);
	});

	test("2-take group: swapping the keeper flips which take is cut", () => {
		const two = [member({ lineId: "L0", startSec: 0, endSec: 2 }), member({ lineId: "L1", startSec: 3, endSec: 5 })];
		expect(cutMembersForKeeper({ members: two, keeperLineId: "L1" }).map((m) => m.lineId)).toEqual(["L0"]);
		expect(cutMembersForKeeper({ members: two, keeperLineId: "L0" }).map((m) => m.lineId)).toEqual(["L1"]);
	});
});

describe("shouldRunLexicalRepeatDetectors", () => {
	test("redundancy pass ran (success) → lexical detectors stay silent", () => {
		expect(shouldRunLexicalRepeatDetectors({ redundancyRan: true })).toBe(false);
	});
	test("redundancy pass errored → lexical detectors run (fallback)", () => {
		expect(shouldRunLexicalRepeatDetectors({ redundancyRan: false })).toBe(true);
	});
});
