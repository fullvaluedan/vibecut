import { describe, expect, test } from "bun:test";
import {
	applyKeeperSwap,
	backstopDefaultAccept,
	cutMembersForKeeper,
	mapRedundancyGroups,
	shouldRunLexicalRepeatDetectors,
} from "../redundancy-apply";
import type { DirectorOp, RedundancyGroup, RedundancyMember } from "@framecut/hf-bridge";

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

describe("mapRedundancyGroups recall surfacing (#5/R4)", () => {
	const mk = (confidence: number) =>
		group({
			members: [
				member({ lineId: "L0", startSec: 0, endSec: 2 }),
				member({ lineId: "L1", startSec: 3, endSec: 5 }),
			],
			keeperLineId: "L1",
			confidence,
		});

	test("a 0.55 group is surfaced as an accept-OFF row (previously dropped at floor 0.7)", () => {
		const { cuts, groups } = mapRedundancyGroups({ groups: [mk(0.55)] });
		expect(groups).toHaveLength(1);
		expect(cuts).toHaveLength(1);
		expect(cuts[0].defaultAccept).toBe(false);
	});

	test("a group at/above the accept threshold defaults to accepted (no defaultAccept flag)", () => {
		const { cuts } = mapRedundancyGroups({ groups: [mk(0.8)] });
		expect(cuts).toHaveLength(1);
		expect(cuts[0].defaultAccept).not.toBe(false);
	});

	test("a group below the floor is still dropped entirely", () => {
		const { cuts, groups } = mapRedundancyGroups({ groups: [mk(0.4)] });
		expect(cuts).toHaveLength(0);
		expect(groups).toHaveLength(0);
	});

	test("exactly at the accept threshold is accepted; exactly at the floor is accept-off", () => {
		expect(mapRedundancyGroups({ groups: [mk(0.7)] }).cuts[0].defaultAccept).not.toBe(false);
		expect(mapRedundancyGroups({ groups: [mk(0.5)] }).cuts[0].defaultAccept).toBe(false);
	});
});

describe("mapRedundancyGroups groupId tagging", () => {
	test("each surviving group gets a stable id shared by its cut ops", () => {
		const { cuts, groups } = mapRedundancyGroups({
			groups: [
				group({
					members: [member({ lineId: "L0", startSec: 0, endSec: 2 }), member({ lineId: "L1", startSec: 3, endSec: 5 })],
					keeperLineId: "L1",
					confidence: 0.9,
				}),
				// below-floor group does NOT consume an index — ids stay g0, g1 across runs
				group({
					members: [member({ lineId: "L2", startSec: 9, endSec: 10 }), member({ lineId: "L3", startSec: 11, endSec: 12 })],
					keeperLineId: "L2",
					confidence: 0.3,
				}),
				group({
					members: [member({ lineId: "L5", startSec: 20, endSec: 22 }), member({ lineId: "L6", startSec: 23, endSec: 25 })],
					keeperLineId: "L5",
					confidence: 0.8,
				}),
			],
		});
		expect(groups.map((g) => g.groupId)).toEqual(["g0", "g1"]);
		expect(cuts.every((c) => c.groupId === "g0" || c.groupId === "g1")).toBe(true);
	});
});

describe("applyKeeperSwap (rebuild a group's cuts for a new keeper)", () => {
	test("2-take group: swapping the keeper flips which take is cut; groupId preserved", () => {
		const { cuts, groups } = mapRedundancyGroups({
			groups: [
				group({
					members: [member({ lineId: "L0", startSec: 0, endSec: 2 }), member({ lineId: "L1", startSec: 3, endSec: 5 })],
					keeperLineId: "L1",
					confidence: 0.9,
				}),
			],
		});
		expect(cuts.map((c) => c.startSec)).toEqual([0]); // keeper L1 → cut L0
		const swapped = applyKeeperSwap({ operations: cuts, group: groups[0], newKeeperLineId: "L0" });
		expect(swapped.map((c) => c.startSec)).toEqual([3]); // keeper L0 → cut L1
		expect(swapped[0].groupId).toBe("g0");
		expect(swapped[0].category).toBe("redundancy");
	});

	test("preserves ops OUTSIDE the group and stays start-sorted", () => {
		const { cuts, groups } = mapRedundancyGroups({
			groups: [
				group({
					members: [member({ lineId: "L0", startSec: 10, endSec: 12 }), member({ lineId: "L1", startSec: 13, endSec: 15 })],
					keeperLineId: "L1",
					confidence: 0.9,
				}),
			],
		});
		const other: DirectorOp = { id: "x", op: "cut", startSec: 1, endSec: 2, reason: "filler", confidence: 0.8, category: "filler" };
		const swapped = applyKeeperSwap({ operations: [other, ...cuts], group: groups[0], newKeeperLineId: "L0" });
		expect(swapped.map((c) => c.startSec)).toEqual([1, 13]); // other kept; group rebuilt to cut L1
		expect(swapped.find((o) => o.id === "x")).toBeTruthy();
	});

	test("a keeper that isn't a member is a no-op (never cuts the whole group)", () => {
		const { cuts, groups } = mapRedundancyGroups({
			groups: [
				group({
					members: [member({ lineId: "L0", startSec: 0, endSec: 2 }), member({ lineId: "L1", startSec: 3, endSec: 5 })],
					keeperLineId: "L1",
					confidence: 0.9,
				}),
			],
		});
		// "L9" is not in the group → must NOT cut every take; ops unchanged.
		const swapped = applyKeeperSwap({ operations: cuts, group: groups[0], newKeeperLineId: "L9" });
		expect(swapped).toEqual(cuts);
	});

	test("3-take group: swap rebuilds BOTH new non-keeper cuts", () => {
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
		expect(cuts.map((c) => c.startSec).sort((a, b) => a - b)).toEqual([0, 6]); // keeper L1
		const swapped = applyKeeperSwap({ operations: cuts, group: groups[0], newKeeperLineId: "L2" });
		expect(swapped.map((c) => c.startSec).sort((a, b) => a - b)).toEqual([0, 3]); // keeper L2 → cut L0,L1
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
	test("the detectors ALWAYS run now (additive backstop — U5/R5)", () => {
		expect(shouldRunLexicalRepeatDetectors()).toBe(true);
	});
});

describe("backstopDefaultAccept", () => {
	test("LLM pass ran → additive backstop cuts are accept-OFF (opt-in)", () => {
		expect(backstopDefaultAccept({ redundancyRan: true })).toBe(false);
	});
	test("route-error fallback → backstop is the sole authority, accepted default", () => {
		expect(backstopDefaultAccept({ redundancyRan: false })).toBe(true);
	});
});
