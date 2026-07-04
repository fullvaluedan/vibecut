import { describe, expect, test } from "bun:test";
import {
	initDecisions,
	initKeepRows,
	selectAccepted,
	selectAcceptedKeeps,
	selectApplyGuardSpans,
	selectFilteredOps,
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
		op({ id: "sp-1", kind: "cut" }), // second-pass finding (default-accepted -> premise too)
		{ ...op({ id: "sp-2", kind: "cut" }), defaultAccept: false }, // sp, already opt-in
		op({ id: "sp-3", kind: "cut" }), // later-pass finding premised on sp-1
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
		expect(d["sp-3"]).toBe(false);
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

	test("rejecting a default-accepted sp- op downgrades LATER sp- rows too (X2)", () => {
		// Passes 2-3 compress over earlier sp- removals, so an sp- op IS a premise
		// for later findings: rejecting it must downgrade them like any other premise.
		const d = toggleWithPremiseGuard({
			operations,
			decisions: initDecisions({ operations }),
			id: "sp-1",
		});
		expect(d["sp-1"]).toBe(false);
		expect(d["sp-3"]).toBe(false); // premised on sp-1's compression -> downgraded
		expect(d.a).toBe(true); // non-sp rows untouched
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

describe("selectApplyGuardSpans (review F5/X6)", () => {
	const spanOp = (id: string, startSec: number, endSec: number, kind: DirectorOp["op"] = "cut"): DirectorOp => ({
		id,
		op: kind,
		startSec,
		endSec,
		reason: "r",
		confidence: 0.8,
	});
	const plan2: DirectorPlan = {
		operations: [
			spanOp("acc", 0, 2), // accepted
			spanOp("rej", 3, 4), // rejected removal
			spanOp("rord", 5, 6, "reorder"), // rejected but not a removal
		],
	};
	const decisions = { acc: true, rej: false, rord: false };

	test("rejected removal rows become both rejected AND protected spans; reorders excluded", () => {
		const g = selectApplyGuardSpans({ plan: plan2, decisions, protectedSpans: [] });
		expect(g.rejectedSpansSec).toEqual([{ startSec: 3, endSec: 4 }]);
		// protected = plan-time keepers + rejected (superset), reorder never included.
		expect(g.protectedSpansSec).toEqual([{ startSec: 3, endSec: 4 }]);
	});

	test("plan-time keepers ride along in protected but not in rejected", () => {
		const g = selectApplyGuardSpans({
			plan: plan2,
			decisions,
			protectedSpans: [{ startSec: 10, endSec: 11 }],
		});
		expect(g.protectedSpansSec).toEqual([
			{ startSec: 10, endSec: 11 },
			{ startSec: 3, endSec: 4 },
		]);
		expect(g.rejectedSpansSec).toEqual([{ startSec: 3, endSec: 4 }]);
	});

	test("a null plan yields empty guard sets", () => {
		const g = selectApplyGuardSpans({ plan: null, decisions: {}, protectedSpans: [] });
		expect(g).toEqual({ protectedSpansSec: [], rejectedSpansSec: [] });
	});

	test("an opt-in op the user never checked is NOT carved out, only gap-protected (RX1)", () => {
		// defaultAccept:false op left unchecked was never 'on' -> not a user reject.
		// Carving it would punch a hole in any accepted wider cut covering it.
		const plan3: DirectorPlan = {
			operations: [
				{ ...spanOp("optin", 3, 4), defaultAccept: false },
				spanOp("wide", 0, 10), // accepted wider cut covering the opt-in span
			],
		};
		const g = selectApplyGuardSpans({
			plan: plan3,
			decisions: { optin: false, wide: true },
			protectedSpans: [],
		});
		expect(g.rejectedSpansSec).toEqual([]); // never carved
		expect(g.protectedSpansSec).toEqual([{ startSec: 3, endSec: 4 }]); // still gap-protected
	});

	test("an AUTO-downgraded sp- row is NOT carved out (RX1: X2 x X6 fix)", () => {
		// The premise guard downgraded sp-1; the user never rejected it. Carving its
		// wide span would delete accepted narrower cuts inside it.
		const plan4: DirectorPlan = {
			operations: [
				spanOp("filler", 30.2, 30.6), // accepted narrow cut inside the sp span
				spanOp("sp-1", 28, 33), // auto-downgraded wide repeat
			],
		};
		const g = selectApplyGuardSpans({
			plan: plan4,
			decisions: { filler: true, "sp-1": false },
			protectedSpans: [],
			autoDowngradedIds: ["sp-1"],
		});
		expect(g.rejectedSpansSec).toEqual([]); // sp-1 not carved -> filler cut survives
		expect(g.protectedSpansSec).toEqual([{ startSec: 28, endSec: 33 }]); // gap-protected only
	});

	test("a user-rejected sp- row (not auto-downgraded) IS carved out", () => {
		const plan5: DirectorPlan = { operations: [spanOp("sp-1", 28, 33)] };
		const g = selectApplyGuardSpans({
			plan: plan5,
			decisions: { "sp-1": false },
			protectedSpans: [],
			autoDowngradedIds: [], // user unchecked it explicitly
		});
		expect(g.rejectedSpansSec).toEqual([{ startSec: 28, endSec: 33 }]);
	});
});

describe("store toggle tracks auto-downgraded ids (review RX1)", () => {
	const plan6: DirectorPlan = {
		operations: [
			{ id: "prem", op: "cut", startSec: 100, endSec: 100.4, reason: "r", confidence: 0.8 },
			{ id: "sp-1", op: "cut", startSec: 28, endSec: 33, reason: "r", confidence: 0.8 },
		],
	};

	test("rejecting a premise records the downgraded sp- id; re-checking clears it", () => {
		useDirectorPlanStore.getState().close();
		useDirectorPlanStore.getState().openCutPanel({ plan: plan6 });
		useDirectorPlanStore.getState().toggle("prem"); // reject the premise
		let s = useDirectorPlanStore.getState();
		expect(s.decisions["sp-1"]).toBe(false); // auto-downgraded
		expect(s.autoDowngradedIds).toEqual(["sp-1"]);
		// The guard set must NOT carve the auto-downgraded sp span.
		const g = selectApplyGuardSpans({
			plan: s.plan,
			decisions: s.decisions,
			protectedSpans: s.protectedSpans,
			autoDowngradedIds: s.autoDowngradedIds,
		});
		expect(g.rejectedSpansSec).toEqual([{ startSec: 100, endSec: 100.4 }]); // only the premise
		useDirectorPlanStore.getState().toggle("sp-1"); // user re-checks sp-1
		s = useDirectorPlanStore.getState();
		expect(s.autoDowngradedIds).toEqual([]); // no longer system-driven
		useDirectorPlanStore.getState().close();
	});
});

describe("selectFilteredOps (U8 row filter)", () => {
	const rows: DirectorOp[] = [
		{ id: "rec", op: "cut", startSec: 0, endSec: 1, reason: "r", confidence: 0.8 },
		{
			id: "opt",
			op: "cut",
			startSec: 1,
			endSec: 2,
			reason: "r",
			confidence: 0.8,
			defaultAccept: false,
		},
	];
	const decisions = { rec: false, opt: false }; // rec turned off, opt untouched

	test("all returns every row", () => {
		expect(selectFilteredOps({ ops: rows, decisions: {}, filter: "all" }).map((o) => o.id)).toEqual([
			"rec",
			"opt",
		]);
	});
	test("recommended = default-accepted rows only", () => {
		expect(
			selectFilteredOps({ ops: rows, decisions: {}, filter: "recommended" }).map((o) => o.id),
		).toEqual(["rec"]);
	});
	test("optin = defaultAccept:false rows only", () => {
		expect(
			selectFilteredOps({ ops: rows, decisions: {}, filter: "optin" }).map((o) => o.id),
		).toEqual(["opt"]);
	});
	test("rejected = rows not currently accepted", () => {
		expect(
			selectFilteredOps({ ops: rows, decisions, filter: "rejected" }).map((o) => o.id),
		).toEqual(["rec", "opt"]);
	});
});

describe("applied phase (U8): persist, dismiss clears, premise guard holds", () => {
	const applyPlan: DirectorPlan = {
		operations: [
			{ id: "prem", op: "cut", startSec: 100, endSec: 100.4, reason: "r", confidence: 0.8 },
			{ id: "sp-1", op: "cut", startSec: 28, endSec: 33, reason: "r", confidence: 0.8 },
		],
	};

	test("markApplied keeps the plan and flips to the applied phase", () => {
		useDirectorPlanStore.getState().close();
		useDirectorPlanStore.getState().openCutPanel({ plan: applyPlan });
		expect(useDirectorPlanStore.getState().phase).toBe("review");
		useDirectorPlanStore.getState().markApplied(true);
		const s = useDirectorPlanStore.getState();
		expect(s.phase).toBe("applied");
		expect(s.appliedHasBatch).toBe(true);
		expect(s.abShowing).toBe("with");
		expect(s.plan).not.toBeNull(); // recipe survives apply
		useDirectorPlanStore.getState().close();
	});

	test("only close clears the applied plan (A/B + toggle do not)", () => {
		useDirectorPlanStore.getState().close();
		useDirectorPlanStore.getState().openCutPanel({ plan: applyPlan });
		useDirectorPlanStore.getState().markApplied(true);
		useDirectorPlanStore.getState().setAbShowing("without");
		useDirectorPlanStore.getState().toggle("sp-1");
		expect(useDirectorPlanStore.getState().plan).not.toBeNull(); // still there
		useDirectorPlanStore.getState().close();
		const s = useDirectorPlanStore.getState();
		expect(s.plan).toBeNull();
		expect(s.phase).toBe("review"); // reset for the next run
	});

	test("the premise guard still downgrades sp- rows during post-apply revision", () => {
		useDirectorPlanStore.getState().close();
		useDirectorPlanStore.getState().openCutPanel({ plan: applyPlan });
		useDirectorPlanStore.getState().markApplied(true);
		// Reject the premise AFTER apply: the still-accepted sp- row must downgrade.
		useDirectorPlanStore.getState().toggle("prem");
		const s = useDirectorPlanStore.getState();
		expect(s.phase).toBe("applied"); // toggle never leaves the applied phase
		expect(s.decisions["sp-1"]).toBe(false);
		expect(s.autoDowngradedIds).toEqual(["sp-1"]);
		useDirectorPlanStore.getState().close();
	});
});
