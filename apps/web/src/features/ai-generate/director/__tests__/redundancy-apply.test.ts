import { describe, expect, test } from "bun:test";
import {
	applyKeeperSwap,
	cutMembersForKeeper,
	lexicalBackstopDefaultAccept,
	mapRedundancyGroups,
	shouldRunLexicalRepeatDetectors,
} from "../redundancy-apply";
import type { DirectorOp, RedundancyGroup, RedundancyMember } from "@framecut/hf-bridge";

// Members share a near-verbatim take text by default so the confidence-gate
// tests exercise confidence semantics; the round-7 near-verbatim gate has its
// own describe block with paraphrase-level texts.
const member = ({
	lineId,
	startSec,
	endSec,
	text = "so we grab the config file and restart the server",
}: {
	lineId: string;
	startSec: number;
	endSec: number;
	text?: string;
}): RedundancyMember => ({
	lineId,
	startSec,
	endSec,
	text,
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

	test("0.85 group → accepted; 0.6 group → opt-in; keeper never in the accepted cut set", () => {
		const highCuts = mapRedundancyGroups({ groups: [mk(0.85)] }).cuts;
		expect(highCuts[0].defaultAccept).not.toBe(false); // auto-removed
		expect(mapRedundancyGroups({ groups: [mk(0.6)] }).cuts[0].defaultAccept).toBe(false); // opt-in
		// keeper L1 [3,5] is never one of the accepted cuts (no group loses all takes)
		const accepted = highCuts.filter((c) => c.defaultAccept !== false);
		expect(accepted.some((c) => c.startSec === 3 && c.endSec === 5)).toBe(false);
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

	test("sub-threshold group stays accept-OFF across a swap (never silently re-accepted)", () => {
		// A 0.55-confidence group is in [floor 0.5, accept-threshold 0.7): surfaced as
		// opt-in, so its cut ops start `defaultAccept: false`.
		const { cuts, groups } = mapRedundancyGroups({
			groups: [
				group({
					members: [member({ lineId: "L0", startSec: 0, endSec: 2 }), member({ lineId: "L1", startSec: 3, endSec: 5 })],
					keeperLineId: "L1",
					confidence: 0.55,
				}),
			],
		});
		expect(cuts[0].defaultAccept).toBe(false); // baseline: opt-in before any swap
		// Swapping the keeper must NOT flip the rebuilt op to accepted. Before the fix
		// the rebuilt op dropped `defaultAccept` and fell back to accepted.
		const swapped = applyKeeperSwap({ operations: cuts, group: groups[0], newKeeperLineId: "L0" });
		expect(swapped.map((c) => c.startSec)).toEqual([3]); // keeper L0 → cut L1
		expect(swapped[0].defaultAccept).toBe(false); // still opt-in
	});

	test("above-threshold group's rebuilt ops stay accepted (defaultAccept omitted)", () => {
		const { cuts, groups } = mapRedundancyGroups({
			groups: [
				group({
					members: [member({ lineId: "L0", startSec: 0, endSec: 2 }), member({ lineId: "L1", startSec: 3, endSec: 5 })],
					keeperLineId: "L1",
					confidence: 0.9,
				}),
			],
		});
		const swapped = applyKeeperSwap({ operations: cuts, group: groups[0], newKeeperLineId: "L0" });
		expect(swapped[0].defaultAccept).not.toBe(false); // accepted default preserved
	});

	test("KTD5: rebuilt cuts are word-refined off mid-word landings when words are passed", () => {
		const { cuts, groups } = mapRedundancyGroups({
			groups: [
				group({
					members: [
						member({ lineId: "L0", startSec: 0, endSec: 2 }),
						member({ lineId: "L1", startSec: 3, endSec: 5.05 }), // end lands mid-word
					],
					keeperLineId: "L1",
					confidence: 0.9,
				}),
			],
		});
		// A word "end" spans 5.0–5.4; the cut end at 5.05 is inside it, midpoint 5.2 kept
		// → refine shrinks the edge back to the word start (5.0), sparing the word.
		const words = [
			{ text: "the", start: 4.5, end: 4.8 },
			{ text: "end", start: 5.0, end: 5.4 },
		];
		const swapped = applyKeeperSwap({
			operations: cuts,
			group: groups[0],
			newKeeperLineId: "L0",
			words,
		});
		expect(swapped.map((c) => c.startSec)).toEqual([3]); // keeper L0 → cut L1
		expect(swapped[0].endSec).toBe(5.0); // refined off the mid-word landing (was 5.05)
	});

	test("KTD5: no envelope/words is byte-identical to the pre-U2 raw-span swap", () => {
		const { cuts, groups } = mapRedundancyGroups({
			groups: [
				group({
					members: [member({ lineId: "L0", startSec: 0, endSec: 2 }), member({ lineId: "L1", startSec: 3, endSec: 5.05 })],
					keeperLineId: "L1",
					confidence: 0.9,
				}),
			],
		});
		const swapped = applyKeeperSwap({ operations: cuts, group: groups[0], newKeeperLineId: "L0" });
		expect(swapped[0].endSec).toBe(5.05); // untouched — no words to refine against
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

describe("lexicalBackstopDefaultAccept (U1/KTD2)", () => {
	test("verbatim phrase-repeat cut auto-accepts even when additive to the LLM pass", () => {
		expect(lexicalBackstopDefaultAccept({ verbatim: true, redundancyRan: true })).toBe(true);
	});
	test("verbatim phrase-repeat cut auto-accepts on route-error fallback too", () => {
		expect(lexicalBackstopDefaultAccept({ verbatim: true, redundancyRan: false })).toBe(true);
	});
	test("soft backstop (segment-repeat / redundancyOps) is accept-OFF when additive", () => {
		expect(lexicalBackstopDefaultAccept({ verbatim: false, redundancyRan: true })).toBe(false);
	});
	test("soft backstop is the sole authority on route-error fallback → accepted default", () => {
		expect(lexicalBackstopDefaultAccept({ verbatim: false, redundancyRan: false })).toBe(true);
	});
});

describe("round-7 near-verbatim gate (Dan smoke pass 2026-07-17)", () => {
	test("Dan's live restatement pair (paraphrase-level) demotes despite 0.8 confidence", () => {
		// The exact pair the redundancy pass auto-cut inside the flowing 0-45s
		// conversation: deliberate setup-then-payoff, not a retake.
		const g = group({
			members: [
				member({
					lineId: "L7",
					startSec: 29.92,
					endSec: 31.58,
					text: "So I'm going to leave a link in the description.",
				}),
				member({
					lineId: "L12",
					startSec: 47.9,
					endSec: 51.36,
					text: "So I'm going to leave a link in the description, and all you do is hit join group.",
				}),
			],
			keeperLineId: "L12",
			confidence: 0.8,
		});
		const { cuts } = mapRedundancyGroups({ groups: [g] });
		expect(cuts).toHaveLength(1);
		expect(cuts[0].defaultAccept).toBe(false);
		expect(cuts[0].reason).toContain("paraphrased");
	});

	test("a true near-verbatim retake keeps the auto-accept at 0.8 confidence", () => {
		const g = group({
			members: [
				member({ lineId: "A", startSec: 0, endSec: 4 }),
				member({ lineId: "B", startSec: 6, endSec: 10 }),
			],
			keeperLineId: "B",
			confidence: 0.8,
		});
		const { cuts } = mapRedundancyGroups({ groups: [g] });
		expect(cuts).toHaveLength(1);
		expect(cuts[0].defaultAccept).toBeUndefined();
		expect(cuts[0].reason).not.toContain("paraphrased");
	});

	test("missing or empty member text is conservatively opt-in", () => {
		const g = group({
			members: [
				member({ lineId: "A", startSec: 0, endSec: 4, text: "" }),
				member({ lineId: "B", startSec: 6, endSec: 10 }),
			],
			keeperLineId: "B",
			confidence: 0.9,
		});
		const { cuts } = mapRedundancyGroups({ groups: [g] });
		expect(cuts[0].defaultAccept).toBe(false);
	});

	test("a paraphrase group below the accept threshold stays opt-in (no double demotion weirdness)", () => {
		const g = group({
			members: [
				member({ lineId: "A", startSec: 0, endSec: 4, text: "completely different words here" }),
				member({ lineId: "B", startSec: 6, endSec: 10, text: "another sentence about the topic" }),
			],
			keeperLineId: "B",
			confidence: 0.6,
		});
		const { cuts } = mapRedundancyGroups({ groups: [g] });
		expect(cuts[0].defaultAccept).toBe(false);
	});
});
