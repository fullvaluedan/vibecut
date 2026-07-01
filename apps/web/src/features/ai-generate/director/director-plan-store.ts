/**
 * State for the Director Review modal (U4): the proposed plan + the user's per-op
 * accept/reject decisions + open state. The decision logic is pure (testable);
 * the zustand store is a thin wrapper the modal subscribes to.
 */

import { create } from "zustand";
import type { DirectorOp, DirectorPlan } from "@framecut/hf-bridge";
import type { NearTieNote } from "./redundancy";
import type { HighlightPreview } from "./highlight-preview";
import type { AssemblyDraft, DraftSpan } from "./assembly-draft";
import { applyKeeperSwap, type RedundancyReviewGroup } from "./redundancy-apply";

/** Map of op id -> accepted. Absent or true means accepted (default). */
export type OpDecisions = Record<string, boolean>;

/** One keep span shown as a row in Highlight mode (accept = keep, reject = drop). */
export interface HighlightKeepRow {
	id: string;
	startSec: number;
	endSec: number;
	/** A transcript snippet for the span, when available. */
	text?: string;
}

/** Assign stable ids to the keep spans, all accepted by default. */
export function initKeepRows(keeps: readonly { startSec: number; endSec: number; text?: string }[]): HighlightKeepRow[] {
	return keeps.map((k, i) => ({ id: `keep-${i}`, startSec: k.startSec, endSec: k.endSec, text: k.text }));
}

/** The accepted keep rows (the spans that survive into the highlight), in order. */
export function selectAcceptedKeeps({
	keeps,
	decisions,
}: {
	keeps: readonly HighlightKeepRow[];
	decisions: OpDecisions;
}): HighlightKeepRow[] {
	return keeps.filter((k) => decisions[k.id]);
}

/**
 * Ops start ACCEPTED — the user opts ops out, not in — EXCEPT ops flagged
 * `defaultAccept: false` (lower-confidence, higher-recall candidates), which start
 * unchecked so nothing new is auto-applied (#5/R4).
 */
export function initDecisions(plan: DirectorPlan): OpDecisions {
	const decisions: OpDecisions = {};
	for (const op of plan.operations) {
		decisions[op.id] = op.defaultAccept !== false;
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
	/** "modal" = the cut/highlight review dialog; "panel" = the assemble review in the right inspector. */
	surface: "modal" | "panel";
	/** "cut"/"highlight" = the modal review; "assemble" = the right-panel auto-assemble review. */
	mode: "cut" | "highlight" | "assemble";
	plan: DirectorPlan | null;
	decisions: OpDecisions;
	/** Near-tie clusters with no decisive keeper — informational, for manual resolution (U7). */
	nearTies: NearTieNote[];
	/** Redundancy groups (keeper + all takes) backing the review's swap-to-alternate (U5b). */
	redundancyGroups: RedundancyReviewGroup[];
	/** Highlight mode: the keep rows, the preview stats, and the timeline length. */
	keeps: HighlightKeepRow[];
	preview: HighlightPreview | null;
	totalSec: number;
	/** Assemble mode: the editable rough-cut draft (ordered spans + swap alternates). */
	draft: AssemblyDraft | null;
	/** Open the auto-assemble REVIEW in the right panel with a fresh draft. */
	openAssemble: (args: { draft: AssemblyDraft }) => void;
	/** Replace the draft's spans (after a drop / re-include / swap) — the panel re-projects the timeline. */
	applyDraftEdit: (spans: DraftSpan[]) => void;
	/** Close the assemble panel, leaving the assembled cut on the timeline. */
	closeAssemble: () => void;
	/** Open the cut-review modal with a fresh plan (all ops accepted) + any near-tie notes + redundancy groups. */
	openWith: (args: {
		plan: DirectorPlan;
		nearTies?: readonly NearTieNote[];
		redundancyGroups?: readonly RedundancyReviewGroup[];
	}) => void;
	/** Swap a redundancy group's keeper: rebuild that group's cut ops for the chosen take (U5b). */
	swapRedundancyKeeper: (args: { groupId: string; keeperLineId: string }) => void;
	/** Open the Highlight modal (KTD9): keep rows accepted by default, with preview + totalSec. */
	openHighlight: (args: {
		keeps: readonly { startSec: number; endSec: number; text?: string }[];
		preview: HighlightPreview;
		totalSec: number;
	}) => void;
	/** Flip one op/keep-row's accept/reject. */
	toggle: (id: string) => void;
	/** Set every row's decision at once (bulk select-all / deselect-all). */
	setAll: (accepted: boolean) => void;
	/** The currently-accepted ops (cut mode). */
	acceptedOps: () => DirectorOp[];
	/** The currently-accepted keep rows (highlight mode). */
	acceptedKeeps: () => HighlightKeepRow[];
	/** Close and clear. */
	close: () => void;
}

const CLEARED = {
	open: false,
	surface: "modal" as const,
	mode: "cut" as const,
	plan: null,
	decisions: {},
	nearTies: [],
	redundancyGroups: [],
	keeps: [],
	preview: null,
	totalSec: 0,
	draft: null,
};

export const useDirectorPlanStore = create<DirectorPlanState>((set, get) => ({
	...CLEARED,
	// `open` stays FALSE — the panel keys off surface/mode/draft, not `open`, so
	// the still-mounted modal DirectorReviewDialog (which renders on `open`) does
	// NOT pop a spurious "nothing to change" dialog over the assemble panel.
	openAssemble: ({ draft }) =>
		set({ ...CLEARED, surface: "panel", mode: "assemble", draft }),
	applyDraftEdit: (spans) =>
		set((state) =>
			state.draft ? { draft: { ...state.draft, spans } } : {},
		),
	closeAssemble: () => set({ ...CLEARED }),
	openWith: ({ plan, nearTies, redundancyGroups }) =>
		set({
			...CLEARED,
			open: true,
			mode: "cut",
			plan,
			decisions: initDecisions(plan),
			nearTies: [...(nearTies ?? [])],
			redundancyGroups: [...(redundancyGroups ?? [])],
		}),
	swapRedundancyKeeper: ({ groupId, keeperLineId }) =>
		set((state) => {
			if (!state.plan) return {};
			const group = state.redundancyGroups.find((g) => g.groupId === groupId);
			if (!group || group.keeperLineId === keeperLineId) return {}; // unknown / no-op
			const operations = applyKeeperSwap({
				operations: state.plan.operations,
				group,
				newKeeperLineId: keeperLineId,
			});
			// New (rebuilt) ops default to accepted; surviving ops keep their decision.
			const decisions: OpDecisions = {};
			for (const op of operations) decisions[op.id] = state.decisions[op.id] ?? true;
			return {
				plan: { ...state.plan, operations },
				decisions,
				redundancyGroups: state.redundancyGroups.map((g) =>
					g.groupId === groupId ? { ...g, keeperLineId } : g,
				),
			};
		}),
	openHighlight: ({ keeps, preview, totalSec }) => {
		const rows = initKeepRows(keeps);
		const decisions: OpDecisions = {};
		for (const row of rows) decisions[row.id] = true;
		set({ ...CLEARED, open: true, mode: "highlight", keeps: rows, decisions, preview, totalSec });
	},
	toggle: (id) =>
		set((state) => ({ decisions: toggleDecision({ decisions: state.decisions, id }) })),
	setAll: (accepted) =>
		set((state) => {
			const ids =
				state.mode === "highlight"
					? state.keeps.map((k) => k.id)
					: (state.plan?.operations ?? []).map((o) => o.id);
			const decisions: OpDecisions = { ...state.decisions };
			for (const id of ids) decisions[id] = accepted;
			return { decisions };
		}),
	acceptedOps: () => {
		const { plan, decisions } = get();
		return plan ? selectAccepted({ plan, decisions }) : [];
	},
	acceptedKeeps: () => {
		const { keeps, decisions } = get();
		return selectAcceptedKeeps({ keeps, decisions });
	},
	close: () => set({ ...CLEARED }),
}));
