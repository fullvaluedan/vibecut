import { describe, expect, test } from "bun:test";
import {
	initDecisions,
	initKeepRows,
	selectAccepted,
	selectAcceptedKeeps,
	toggleDecision,
	toggleWithPremiseGuard,
	useDirectorPlanStore,
} from "../director-plan-store";
import type { DirectorOp, DirectorPlan } from "@framecut/hf-bridge";

const op = ({ id, kind }: { id: string; kind: DirectorOp["op"] }): DirectorOp => ({
	id,
	op: kind,
	startSec: 0,
	endSec: 1,
	reason: "r",
	confidence: 0.8,
});

const plan: DirectorPlan = {
	operations: [
		op({ id: "a", kind: "cut" }),
		op({ id: "b", kind: "take_select" }),
		op({ id: "c", kind: "reorder" }),
	],
};

describe("director plan decisions", () => {
	test("every op starts accepted", () => {
		expect(initDecisions(plan)).toEqual({ a: true, b: true, c: true });
	});

	test("an op flagged defaultAccept:false starts unchecked (opt-in)", () => {
		const optIn: DirectorPlan = {
			operations: [
				op({ id: "a", kind: "cut" }),
				{ ...op({ id: "b", kind: "cut" }), defaultAccept: false },
			],
		};
		expect(initDecisions(optIn)).toEqual({ a: true, b: false });
	});

	test("toggle flips one op and leaves the rest", () => {
		const d = toggleDecision({ decisions: initDecisions(plan), id: "b" });
		expect(d).toEqual({ a: true, b: false, c: true });
	});

	test("selectAccepted returns only accepted ops, in plan order", () => {
		const d = toggleDecision({ decisions: initDecisions(plan), id: "b" });
		expect(selectAccepted({ plan, decisions: d }).map((o) => o.id)).toEqual(["a", "c"]);
	});

	test("rejecting all ops yields nothing to apply", () => {
		let d = initDecisions(plan);
		for (const id of ["a", "b", "c"]) d = toggleDecision({ decisions: d, id });
		expect(selectAccepted({ plan, decisions: d })).toEqual([]);
	});
});

describe("toggleWithPremiseGuard (review F4)", () => {
	const operations: DirectorOp[] = [
		op({ id: "a", kind: "cut" }), // premise removal (default-accepted)
		{ ...op({ id: "b", kind: "cut" }), defaultAccept: false }, // opt-in, never premise
		op({ id: "c", kind: "reorder" }), // not a removal
		op({ id: "sp-1", kind: "cut" }), // second-pass finding
		{ ...op({ id: "sp-2", kind: "cut" }), defaultAccept: false }, // sp, already opt-in
	];

	test("rejecting a premise removal downgrades every accepted sp- row", () => {
		const d = toggleWithPremiseGuard({
			operations,
			decisions: initDecisions({ operations }),
			id: "a",
		});
		expect(d.a).toBe(false);
		expect(d["sp-1"]).toBe(false); // premise stale -> opt-in
		expect(d["sp-2"]).toBe(false); // was already unchecked, stays
	});

	test("rejecting an opt-in op leaves sp- rows alone (never part of the premise)", () => {
		const start = { ...initDecisions({ operations }), b: true }; // user had checked b
		const d = toggleWithPremiseGuard({ operations, decisions: start, id: "b" });
		expect(d.b).toBe(false);
		expect(d["sp-1"]).toBe(true);
	});

	test("rejecting a non-removal (reorder) leaves sp- rows alone", () => {
		const d = toggleWithPremiseGuard({
			operations,
			decisions: initDecisions({ operations }),
			id: "c",
		});
		expect(d["sp-1"]).toBe(true);
	});

	test("ACCEPTING a premise op does not touch sp- rows", () => {
		const start = { ...initDecisions({ operations }), a: false };
		const d = toggleWithPremiseGuard({ operations, decisions: start, id: "a" });
		expect(d.a).toBe(true);
		expect(d["sp-1"]).toBe(true);
	});

	test("rejecting an sp- op itself does not cascade to other sp- rows", () => {
		const d = toggleWithPremiseGuard({
			operations,
			decisions: initDecisions({ operations }),
			id: "sp-1",
		});
		expect(d["sp-1"]).toBe(false);
		expect(d.a).toBe(true);
	});

	test("a manually re-checked sp- row is downgraded again by a later premise reject", () => {
		let d = toggleWithPremiseGuard({
			operations,
			decisions: { ...initDecisions({ operations }), "sp-2": true },
			id: "a",
		});
		expect(d["sp-2"]).toBe(false);
		d = toggleWithPremiseGuard({ operations, decisions: d, id: "sp-2" });
		expect(d["sp-2"]).toBe(true); // the user's explicit re-check still works
	});
});

describe("openCutPanel (docked cut review, U6)", () => {
	const optIn: DirectorPlan = {
		operations: [
			op({ id: "a", kind: "cut" }),
			{ ...op({ id: "b", kind: "cut" }), defaultAccept: false },
		],
	};
	const groups = [
		{ groupId: "g1", keeperLineId: "l1", members: [], confidence: 0.6, reason: "r" },
	];

	test("docks in the panel with open:false and preserves plan/decisions/groups", () => {
		useDirectorPlanStore.getState().close();
		useDirectorPlanStore.getState().openCutPanel({
			plan: optIn,
			nearTies: [],
			redundancyGroups: groups,
		});
		const s = useDirectorPlanStore.getState();
		expect(s.surface).toBe("panel");
		expect(s.mode).toBe("cut");
		// `open` stays false so the still-mounted modal does NOT also pop.
		expect(s.open).toBe(false);
		expect(s.plan?.operations.map((o) => o.id)).toEqual(["a", "b"]);
		// defaultAccept:false op starts unchecked; nothing new is auto-applied.
		expect(s.decisions).toEqual({ a: true, b: false });
		expect(s.redundancyGroups.map((g) => g.groupId)).toEqual(["g1"]);
	});

	test("close() resets the surface back to the modal default", () => {
		useDirectorPlanStore.getState().openCutPanel({ plan: optIn });
		useDirectorPlanStore.getState().close();
		const s = useDirectorPlanStore.getState();
		expect(s.surface).toBe("modal");
		expect(s.plan).toBeNull();
	});
});

describe("highlight keep decisions", () => {
	const keeps = [
		{ startSec: 0, endSec: 3 },
		{ startSec: 10, endSec: 12, text: "the key line" },
	];

	test("initKeepRows assigns stable ids and carries text", () => {
		const rows = initKeepRows(keeps);
		expect(rows.map((r) => r.id)).toEqual(["keep-0", "keep-1"]);
		expect(rows[1].text).toBe("the key line");
	});

	test("selectAcceptedKeeps returns only accepted rows", () => {
		const rows = initKeepRows(keeps);
		const decisions = toggleDecision({
			decisions: { "keep-0": true, "keep-1": true },
			id: "keep-1",
		});
		expect(selectAcceptedKeeps({ keeps: rows, decisions }).map((r) => r.id)).toEqual(["keep-0"]);
	});

	test("rejecting every keep leaves nothing (caller must guard the empty apply)", () => {
		const rows = initKeepRows(keeps);
		expect(selectAcceptedKeeps({ keeps: rows, decisions: {} })).toEqual([]);
	});
});
