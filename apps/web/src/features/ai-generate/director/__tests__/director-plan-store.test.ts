import { describe, expect, test } from "bun:test";
import {
	initDecisions,
	selectAccepted,
	toggleDecision,
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
