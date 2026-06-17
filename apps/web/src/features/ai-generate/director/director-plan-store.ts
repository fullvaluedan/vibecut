/**
 * State for the Director Review modal (U4): the proposed plan + the user's per-op
 * accept/reject decisions + open state. The decision logic is pure (testable);
 * the zustand store is a thin wrapper the modal subscribes to.
 */

import { create } from "zustand";
import type { DirectorOp, DirectorPlan } from "@framecut/hf-bridge";

/** Map of op id -> accepted. Absent or true means accepted (default). */
export type OpDecisions = Record<string, boolean>;

/** Every op starts ACCEPTED — the user opts ops out, not in. */
export function initDecisions(plan: DirectorPlan): OpDecisions {
	const decisions: OpDecisions = {};
	for (const op of plan.operations) {
		decisions[op.id] = true;
	}
	return decisions;
}

/** Flip one op's accept/reject (immutably). */
export function toggleDecision({
	decisions,
	id,
}: {
	decisions: OpDecisions;
	id: string;
}): OpDecisions {
	return { ...decisions, [id]: !decisions[id] };
}

/** The accepted ops, in plan order. */
export function selectAccepted({
	plan,
	decisions,
}: {
	plan: DirectorPlan;
	decisions: OpDecisions;
}): DirectorOp[] {
	return plan.operations.filter((op) => decisions[op.id]);
}

interface DirectorPlanState {
	open: boolean;
	plan: DirectorPlan | null;
	decisions: OpDecisions;
	/** Open the modal with a fresh plan (all ops accepted). */
	openWith: (plan: DirectorPlan) => void;
	/** Flip one op's accept/reject. */
	toggle: (id: string) => void;
	/** The currently-accepted ops. */
	acceptedOps: () => DirectorOp[];
	/** Close and clear. */
	close: () => void;
}

export const useDirectorPlanStore = create<DirectorPlanState>((set, get) => ({
	open: false,
	plan: null,
	decisions: {},
	openWith: (plan) => set({ open: true, plan, decisions: initDecisions(plan) }),
	toggle: (id) =>
		set((state) => ({ decisions: toggleDecision({ decisions: state.decisions, id }) })),
	acceptedOps: () => {
		const { plan, decisions } = get();
		return plan ? selectAccepted({ plan, decisions }) : [];
	},
	close: () => set({ open: false, plan: null, decisions: {} }),
}));
