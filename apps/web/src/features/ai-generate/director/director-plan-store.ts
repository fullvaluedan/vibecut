/**
 * State for the Director Review modal (U4): the proposed plan + the user's per-op
 * accept/reject decisions + open state. The decision logic is pure (testable);
 * the zustand store is a thin wrapper the modal subscribes to.
 */

import { create } from "zustand";
import type { DirectorOp, DirectorPlan } from "@framecut/hf-bridge";
import type { WordTiming } from "./cut-utils";
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

/**
 * Toggle with the second-pass premise guard (review F4/X2). A second-pass (`sp-`)
 * cut exists only because compressing the default-accepted removals made two spans
 * adjacent. When the user REJECTS any of those premise removals, that adjacency may
 * no longer exist, so every still-accepted sp- row downgrades to unchecked instead
 * of auto-cutting on a stale premise: re-checking is one click, a wrong auto-cut is
 * lost footage. Default-accepted sp- ops count as premises too (X2): passes 2-3
 * compress over EARLIER sp- removals, so rejecting one invalidates later findings
 * the same way. Re-accepting a premise op does NOT auto-restore (the user decides).
 */
export function toggleWithPremiseGuard({
	operations,
	decisions,
	id,
}: {
	operations: readonly DirectorOp[];
	decisions: OpDecisions;
	id: string;
}): OpDecisions {
	const next = toggleDecision({ decisions, id });
	const op = operations.find((o) => o.id === id);
	const rejectedPremiseOp =
		next[id] === false &&
		op !== undefined &&
		(op.op === "cut" || op.op === "take_select") &&
		op.defaultAccept !== false;
	if (rejectedPremiseOp) {
		for (const o of operations) {
			if (o.id.startsWith("sp-") && next[o.id]) next[o.id] = false;
		}
	}
	return next;
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

/** The review-panel row filter (U8): all rows, or one slice of them. */
export type ReviewRowFilter = "all" | "recommended" | "optin" | "rejected";

/**
 * Pure row filter for the review panel (U8). "recommended" = the default-accepted
 * rows; "optin" = the `defaultAccept:false` rows the user must opt into; "rejected"
 * = anything not currently accepted (a turned-off recommendation or an untouched
 * opt-in). "all" passes everything through. Order is preserved.
 */
export function selectFilteredOps({
	ops,
	decisions,
	filter,
}: {
	ops: readonly DirectorOp[];
	decisions: OpDecisions;
	filter: ReviewRowFilter;
}): DirectorOp[] {
	switch (filter) {
		case "recommended":
			return ops.filter((op) => op.defaultAccept !== false);
		case "optin":
			return ops.filter((op) => op.defaultAccept === false);
		case "rejected":
			return ops.filter((op) => !decisions[op.id]);
		default:
			return [...ops];
	}
}

/**
 * The two guard-span sets `applyDirectorPlan` needs (review F5/X6/RX1), derived in
 * ONE place so the modal and the docked panel can never drift.
 *
 * `protectedSpansSec` (gap protection, F5): every unchecked removal + plan-time
 * keepers. Benign, since it only stops sub-floor gap coalescing from swallowing a
 * span, never deletes an accepted cut.
 *
 * `rejectedSpansSec` (authoritative carve-out, X6): carved OUT of the final ranges,
 * so it must be ONLY genuine user rejections (RX1). An opt-in op the user never
 * checked (`defaultAccept === false`) was never on, and an auto-downgraded sp- row
 * was turned off by the premise guard, not the user; carving either would punch
 * holes in unrelated ACCEPTED wider cuts that legitimately cover them.
 */
export function selectApplyGuardSpans({
	plan,
	decisions,
	protectedSpans,
	autoDowngradedIds = [],
}: {
	plan: DirectorPlan | null;
	decisions: OpDecisions;
	protectedSpans: readonly { startSec: number; endSec: number }[];
	/** Ids the premise guard auto-downgraded (never a user reject). */
	autoDowngradedIds?: readonly string[];
}): {
	protectedSpansSec: { startSec: number; endSec: number }[];
	rejectedSpansSec: { startSec: number; endSec: number }[];
} {
	const auto = new Set(autoDowngradedIds);
	const ops = plan?.operations ?? [];
	const isUncheckedRemoval = (op: DirectorOp): boolean =>
		!decisions[op.id] && (op.op === "cut" || op.op === "take_select");
	const span = (op: DirectorOp) => ({ startSec: op.startSec, endSec: op.endSec });

	const uncheckedSpans = ops.filter(isUncheckedRemoval).map(span);
	const rejectedSpansSec = ops
		.filter(
			(op) => isUncheckedRemoval(op) && op.defaultAccept !== false && !auto.has(op.id),
		)
		.map(span);
	return {
		protectedSpansSec: [...protectedSpans, ...uncheckedSpans],
		rejectedSpansSec,
	};
}

interface DirectorPlanState {
	open: boolean;
	/** "modal" = the cut/highlight review dialog; "panel" = the assemble review in the right inspector. */
	surface: "modal" | "panel";
	/** "cut"/"highlight" = the modal review; "assemble" = the right-panel auto-assemble review. */
	mode: "cut" | "highlight" | "assemble";
	/**
	 * Cut-review lifecycle (U8). "review" = proposing, nothing applied yet. "applied"
	 * = the plan is on the timeline but the panel STAYS OPEN and editable: toggling a
	 * row revises the applied cut in place, and only an explicit dismiss clears it.
	 */
	phase: "review" | "applied";
	/**
	 * A/B preview state (U8, applied phase only). "with" = the applied cuts are on
	 * the timeline; "without" = the Director batch is temporarily undone to preview
	 * the original. Neither clears the plan.
	 */
	abShowing: "with" | "without";
	/**
	 * Whether a Director BatchCommand is currently the top undoable step (U8). False
	 * when the accepted decisions produced no cuts. A revise only undoes first when a
	 * batch is actually applied AND showing, so it never pops the pre-Director step.
	 */
	appliedHasBatch: boolean;
	plan: DirectorPlan | null;
	decisions: OpDecisions;
	/** Ids the premise guard auto-downgraded (not user rejects), so apply never carves
	 * their span out of other accepted cuts (review RX1). */
	autoDowngradedIds: string[];
	/** Transcript words (seconds) backing the apply-time sliver word-guard (2P-U1). */
	words: WordTiming[];
	/** Spans (seconds) apply-time coalescing must never swallow: plan-time keepers +
	 * justify-reverted cuts (review F5). Rejected rows are added at apply time. */
	protectedSpans: { startSec: number; endSec: number }[];
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
		words?: readonly WordTiming[];
		protectedSpans?: readonly { startSec: number; endSec: number }[];
	}) => void;
	/**
	 * Dock the cut review in the right panel (U6): same fresh-plan state as `openWith`
	 * but `surface:'panel'` + `open:false` so it takes over the inspector (like the
	 * assemble panel) instead of popping the modal — persistent + editable while the
	 * user works, surviving deselection.
	 */
	openCutPanel: (args: {
		plan: DirectorPlan;
		nearTies?: readonly NearTieNote[];
		redundancyGroups?: readonly RedundancyReviewGroup[];
		words?: readonly WordTiming[];
		protectedSpans?: readonly { startSec: number; endSec: number }[];
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
	/**
	 * Mark the plan APPLIED (U8): the panel stays open in the applied phase with the
	 * plan + decisions intact. `hasBatch` records whether the apply produced an
	 * undoable Director batch, so a later revise knows whether to undo first.
	 */
	markApplied: (hasBatch: boolean) => void;
	/** Set the A/B preview state (U8). Never clears the plan. */
	setAbShowing: (showing: "with" | "without") => void;
	/** Close and clear. The ONLY thing that discards an applied plan (U8). */
	close: () => void;
}

const CLEARED = {
	open: false,
	surface: "modal" as const,
	mode: "cut" as const,
	phase: "review" as const,
	abShowing: "with" as const,
	appliedHasBatch: false,
	plan: null,
	decisions: {},
	autoDowngradedIds: [],
	words: [],
	protectedSpans: [],
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
	openWith: ({ plan, nearTies, redundancyGroups, words, protectedSpans }) =>
		set({
			...CLEARED,
			open: true,
			mode: "cut",
			plan,
			decisions: initDecisions(plan),
			words: [...(words ?? [])],
			protectedSpans: [...(protectedSpans ?? [])],
			nearTies: [...(nearTies ?? [])],
			redundancyGroups: [...(redundancyGroups ?? [])],
		}),
	// `open` stays FALSE — the panel keys off surface/mode/plan, not `open`, so the
	// still-mounted modal DirectorReviewDialog does NOT also pop over the docked panel.
	openCutPanel: ({ plan, nearTies, redundancyGroups, words, protectedSpans }) =>
		set({
			...CLEARED,
			surface: "panel",
			mode: "cut",
			plan,
			decisions: initDecisions(plan),
			words: [...(words ?? [])],
			protectedSpans: [...(protectedSpans ?? [])],
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
			// Surviving ops keep their decision; a rebuilt op (new id, no prior decision)
			// falls back to its OWN accept default so a sub-threshold (accept-OFF) group
			// stays opt-in across a swap instead of silently flipping to fully accepted.
			const decisions: OpDecisions = {};
			for (const op of operations)
				decisions[op.id] = state.decisions[op.id] ?? op.defaultAccept !== false;
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
		set((state) => {
			const operations = state.plan?.operations ?? [];
			const before = state.decisions;
			const decisions = toggleWithPremiseGuard({ operations, decisions: before, id });
			// Track which ids the premise guard flipped off WITHOUT the user clicking
			// them (RX1), so apply never carves their span out of unrelated accepted
			// cuts. The clicked id is always a user decision; any op the user re-checks
			// leaves the auto set.
			const auto = new Set(state.autoDowngradedIds);
			auto.delete(id);
			for (const op of operations) {
				if (decisions[op.id]) auto.delete(op.id);
				else if (op.id !== id && before[op.id] === true) auto.add(op.id);
			}
			return { decisions, autoDowngradedIds: [...auto] };
		}),
	setAll: (accepted) =>
		set((state) => {
			const ids =
				state.mode === "highlight"
					? state.keeps.map((k) => k.id)
					: (state.plan?.operations ?? []).map((o) => o.id);
			const decisions: OpDecisions = { ...state.decisions };
			for (const id of ids) decisions[id] = accepted;
			// A bulk select-all / deselect-all is an explicit user decision on every
			// row, so nothing remains system-downgraded (RX1).
			return { decisions, autoDowngradedIds: [] };
		}),
	acceptedOps: () => {
		const { plan, decisions } = get();
		return plan ? selectAccepted({ plan, decisions }) : [];
	},
	acceptedKeeps: () => {
		const { keeps, decisions } = get();
		return selectAcceptedKeeps({ keeps, decisions });
	},
	// Applied phase (U8): keep the whole recipe (plan, decisions, guards, words) so a
	// row toggle can revise in place; only `close` clears it.
	markApplied: (hasBatch) =>
		set({ phase: "applied", appliedHasBatch: hasBatch, abShowing: "with" }),
	setAbShowing: (showing) => set({ abShowing: showing }),
	close: () => set({ ...CLEARED }),
}));
