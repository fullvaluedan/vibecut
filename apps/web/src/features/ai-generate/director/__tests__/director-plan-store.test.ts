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

	test("docks and preserves plan/decisions/groups", () => {
		useDirectorPlanStore.getState().close();
		useDirectorPlanStore.getState().openCutPanel({
			plan: optIn,
			nearTies: [],
			redundancyGroups: groups,
		});
		const s = useDirectorPlanStore.getState();
		expect(s.mode).toBe("cut");
		expect(s.plan?.operations.map((o) => o.id)).toEqual(["a", "b"]);
		// defaultAccept:false op starts unchecked; nothing new is auto-applied.
		expect(s.decisions).toEqual({ a: true, b: false });
		expect(s.redundancyGroups.map((g) => g.groupId)).toEqual(["g1"]);
	});

	test("close() resets the dock tab back to the properties default", () => {
		useDirectorPlanStore.getState().openCutPanel({ plan: optIn });
		useDirectorPlanStore.getState().close();
		const s = useDirectorPlanStore.getState();
		expect(s.dockTab).toBe("properties");
		expect(s.plan).toBeNull();
	});

	test("seekPreRollSec is a session preference: survives close/reopen, clamps to 1-10 (round 9)", () => {
		useDirectorPlanStore.getState().close();
		expect(useDirectorPlanStore.getState().seekPreRollSec).toBe(1); // default
		useDirectorPlanStore.getState().setSeekPreRollSec(5);
		useDirectorPlanStore.getState().close();
		useDirectorPlanStore.getState().openCutPanel({ plan: optIn });
		expect(useDirectorPlanStore.getState().seekPreRollSec).toBe(5);
		useDirectorPlanStore.getState().setSeekPreRollSec(99);
		expect(useDirectorPlanStore.getState().seekPreRollSec).toBe(10);
		useDirectorPlanStore.getState().setSeekPreRollSec(0);
		expect(useDirectorPlanStore.getState().seekPreRollSec).toBe(1);
		// Reset for later describes (the store is module-global across tests).
		useDirectorPlanStore.getState().setSeekPreRollSec(1);
		useDirectorPlanStore.getState().close();
	});
});

describe("dockTab (R1: persistent Director dock, surface field retired)", () => {
	const plan: DirectorPlan = { operations: [op({ id: "a", kind: "cut" })] };

	test("the store starts on the properties tab", () => {
		useDirectorPlanStore.getState().close();
		expect(useDirectorPlanStore.getState().dockTab).toBe("properties");
	});

	test("setDockTab focuses a tab directly", () => {
		useDirectorPlanStore.getState().close();
		useDirectorPlanStore.getState().setDockTab("director");
		expect(useDirectorPlanStore.getState().dockTab).toBe("director");
		useDirectorPlanStore.getState().setDockTab("properties");
		expect(useDirectorPlanStore.getState().dockTab).toBe("properties");
	});

	test("openCutPanel auto-focuses the Director tab on completion", () => {
		useDirectorPlanStore.getState().close();
		useDirectorPlanStore.getState().setDockTab("properties");
		useDirectorPlanStore.getState().openCutPanel({ plan });
		expect(useDirectorPlanStore.getState().dockTab).toBe("director");
		useDirectorPlanStore.getState().close();
	});

	test("openAssemble auto-focuses the Director tab on completion", () => {
		useDirectorPlanStore.getState().close();
		useDirectorPlanStore.getState().setDockTab("properties");
		useDirectorPlanStore.getState().openAssemble({
			draft: { spans: [], alternatesByClusterId: {} },
		});
		expect(useDirectorPlanStore.getState().dockTab).toBe("director");
		useDirectorPlanStore.getState().closeAssemble();
	});

	test("openHighlight docks (no modal) and auto-focuses the Director tab", () => {
		useDirectorPlanStore.getState().close();
		useDirectorPlanStore.getState().setDockTab("properties");
		useDirectorPlanStore.getState().openHighlight({
			keeps: [{ startSec: 0, endSec: 3 }],
			preview: { keptCount: 1, totalCount: 1, keptSec: 3, totalSec: 3 },
			totalSec: 3,
		});
		const s = useDirectorPlanStore.getState();
		expect(s.dockTab).toBe("director");
		expect(s.mode).toBe("highlight");
		useDirectorPlanStore.getState().close();
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
	// A stand-in Director batch handle; the store only stores + returns it.
	const BATCH = { id: "batch" } as never;
	const applyPlan: DirectorPlan = {
		operations: [
			{ id: "prem", op: "cut", startSec: 100, endSec: 100.4, reason: "r", confidence: 0.8 },
			{ id: "sp-1", op: "cut", startSec: 28, endSec: 33, reason: "r", confidence: 0.8 },
		],
	};

	test("markApplied keeps the plan, captures the batch, and flips to the applied phase", () => {
		useDirectorPlanStore.getState().close();
		useDirectorPlanStore.getState().openCutPanel({ plan: applyPlan });
		expect(useDirectorPlanStore.getState().phase).toBe("review");
		useDirectorPlanStore.getState().markApplied({ batch: BATCH });
		const s = useDirectorPlanStore.getState();
		expect(s.phase).toBe("applied");
		expect(s.appliedHasBatch).toBe(true);
		expect(s.appliedBatch).toBe(BATCH);
		expect(s.abShowing).toBe("with");
		expect(s.plan).not.toBeNull(); // recipe survives apply
		useDirectorPlanStore.getState().close();
	});

	test("markApplied with a null batch records no controllable batch", () => {
		useDirectorPlanStore.getState().close();
		useDirectorPlanStore.getState().openCutPanel({ plan: applyPlan });
		useDirectorPlanStore.getState().markApplied({ batch: null });
		const s = useDirectorPlanStore.getState();
		expect(s.appliedHasBatch).toBe(false);
		expect(s.appliedBatch).toBeNull();
		useDirectorPlanStore.getState().close();
	});

	test("only close clears the applied plan (A/B + toggle + lock do not)", () => {
		useDirectorPlanStore.getState().close();
		useDirectorPlanStore.getState().openCutPanel({ plan: applyPlan });
		useDirectorPlanStore.getState().markApplied({ batch: BATCH });
		useDirectorPlanStore.getState().setAbShowing("without");
		useDirectorPlanStore.getState().toggle("sp-1");
		useDirectorPlanStore.getState().lockApplied();
		expect(useDirectorPlanStore.getState().plan).not.toBeNull(); // still there
		useDirectorPlanStore.getState().close();
		const s = useDirectorPlanStore.getState();
		expect(s.plan).toBeNull();
		expect(s.phase).toBe("review"); // reset for the next run
		expect(s.appliedBatch).toBeNull();
	});

	test("lockApplied moves a live applied phase to applied-locked (and is a no-op otherwise)", () => {
		useDirectorPlanStore.getState().close();
		// No-op while still reviewing.
		useDirectorPlanStore.getState().openCutPanel({ plan: applyPlan });
		useDirectorPlanStore.getState().lockApplied();
		expect(useDirectorPlanStore.getState().phase).toBe("review");
		// Locks once applied (an intervening edit / manual Ctrl+Z is what triggers this).
		useDirectorPlanStore.getState().markApplied({ batch: BATCH });
		useDirectorPlanStore.getState().lockApplied();
		expect(useDirectorPlanStore.getState().phase).toBe("applied-locked");
		useDirectorPlanStore.getState().close();
	});

	test("the premise guard still downgrades sp- rows during post-apply revision", () => {
		useDirectorPlanStore.getState().close();
		useDirectorPlanStore.getState().openCutPanel({ plan: applyPlan });
		useDirectorPlanStore.getState().markApplied({ batch: BATCH });
		// Reject the premise AFTER apply: the still-accepted sp- row must downgrade.
		useDirectorPlanStore.getState().toggle("prem");
		const s = useDirectorPlanStore.getState();
		expect(s.phase).toBe("applied"); // toggle never leaves the applied phase
		expect(s.decisions["sp-1"]).toBe(false);
		expect(s.autoDowngradedIds).toEqual(["sp-1"]);
		useDirectorPlanStore.getState().close();
	});
});

describe("setAll scoping (U8 fix): a bulk toggle respects the active row filter", () => {
	const plan: DirectorPlan = {
		operations: [
			{ id: "a", op: "cut", startSec: 0, endSec: 1, reason: "r", confidence: 0.8 },
			{ id: "b", op: "cut", startSec: 1, endSec: 2, reason: "r", confidence: 0.8 },
			{ id: "c", op: "cut", startSec: 2, endSec: 3, reason: "r", confidence: 0.8 },
		],
	};

	test("with ids, only the passed (visible/filtered) rows flip; hidden rows keep state", () => {
		useDirectorPlanStore.getState().close();
		useDirectorPlanStore.getState().openCutPanel({ plan });
		// Deselect ONLY the filtered subset [a, b]; c is hidden and must stay accepted.
		useDirectorPlanStore.getState().setAll(false, ["a", "b"]);
		const d = useDirectorPlanStore.getState().decisions;
		expect(d.a).toBe(false);
		expect(d.b).toBe(false);
		expect(d.c).toBe(true); // untouched hidden row
		useDirectorPlanStore.getState().close();
	});

	test("without ids, every row flips (unchanged bulk behavior)", () => {
		useDirectorPlanStore.getState().close();
		useDirectorPlanStore.getState().openCutPanel({ plan });
		useDirectorPlanStore.getState().setAll(false);
		const d = useDirectorPlanStore.getState().decisions;
		expect([d.a, d.b, d.c]).toEqual([false, false, false]);
		useDirectorPlanStore.getState().close();
	});
});

describe("run error state (round 12 U3/R4): a failure persists until dismissed or superseded", () => {
	const errPlan: DirectorPlan = {
		operations: [
			{ id: "a", op: "cut", startSec: 0, endSec: 1, reason: "r", confidence: 0.8 },
		],
	};

	test("the store starts with no run error", () => {
		useDirectorPlanStore.getState().close();
		expect(useDirectorPlanStore.getState().runError).toBeNull();
	});

	test("setRunError records stage + message + a timestamp", () => {
		useDirectorPlanStore.getState().close();
		useDirectorPlanStore
			.getState()
			.setRunError({ stage: "Transcribing...", message: "No speech found" });
		const err = useDirectorPlanStore.getState().runError;
		expect(err?.stage).toBe("Transcribing...");
		expect(err?.message).toBe("No speech found");
		expect(err?.at).toBeGreaterThan(0);
		useDirectorPlanStore.getState().clearRunError();
	});

	test("clearRunError dismisses the card", () => {
		useDirectorPlanStore.getState().setRunError({ stage: "s", message: "m" });
		useDirectorPlanStore.getState().clearRunError();
		expect(useDirectorPlanStore.getState().runError).toBeNull();
	});

	test("a successful run (openCutPanel) clears the previous failure", () => {
		useDirectorPlanStore.getState().close();
		useDirectorPlanStore.getState().setRunError({ stage: "s", message: "m" });
		useDirectorPlanStore.getState().openCutPanel({ plan: errPlan });
		expect(useDirectorPlanStore.getState().runError).toBeNull();
		useDirectorPlanStore.getState().close();
	});

	test("close clears it too", () => {
		useDirectorPlanStore.getState().setRunError({ stage: "s", message: "m" });
		useDirectorPlanStore.getState().close();
		expect(useDirectorPlanStore.getState().runError).toBeNull();
	});

	test("setRunError does not disturb an open review (dismiss returns to it)", () => {
		useDirectorPlanStore.getState().close();
		useDirectorPlanStore.getState().openCutPanel({ plan: errPlan });
		useDirectorPlanStore.getState().setRunError({ stage: "s", message: "m" });
		const s = useDirectorPlanStore.getState();
		expect(s.plan?.operations.map((o) => o.id)).toEqual(["a"]);
		expect(s.decisions).toEqual({ a: true });
		useDirectorPlanStore.getState().close();
	});
});
