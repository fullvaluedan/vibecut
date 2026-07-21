/**
 * State for the Director review (U4): the proposed plan + the user's per-op
 * accept/reject decisions. The decision logic is pure (testable); the zustand
 * store is a thin wrapper the persistent Director dock panels subscribe to.
 */

import { create } from "zustand";
import type { Command } from "@/commands/base-command";
import type { DirectorOp, DirectorPlan } from "@framecut/hf-bridge";
import type { WordTiming } from "./cut-utils";
import type { NearTieNote } from "./redundancy";
import type { HighlightPreview } from "./highlight-preview";
import type { AssemblyDraft, DraftSpan } from "./assembly-draft";
import { applyKeeperSwap, type RedundancyReviewGroup } from "./redundancy-apply";

/** Map of op id -> accepted. Absent or true means accepted (default). */
export type OpDecisions = Record<string, boolean>;

/**
 * A failed Director run (round 12 U3/R4). Before this, a failure showed only a
 * 15-second toast and the dock reverted to idle, so a user who looked away saw
 * nothing, ever. The dock now renders this record as a persistent error card
 * (stage + plain-language message + Retry) until a new run starts, a run
 * completes, or the user dismisses it.
 */
export interface DirectorRunError {
	/** The progress stage the run died in (e.g. "Transcribing..."). */
	stage: string;
	/** Plain-language failure message (never a raw stack trace). */
	message: string;
	/** When it failed (epoch ms), so the card can say when. */
	at: number;
}

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
	/**
	 * Which tab of the persistent Director dock is focused (R1/KTD1). The dock's
	 * visibility is no longer gated on a transient `surface` flag: "properties" and
	 * "director" are both always mounted, and this just picks which one shows. Every
	 * `open*` call below re-asserts "director" on run completion, and every AI CUT
	 * action click does the same immediately (see `ai-cut-actions.ts`); while a run
	 * is in flight and the user has switched away, the dock shell shows a badge
	 * instead of forcing focus back.
	 */
	dockTab: "properties" | "director";
	/** "cut"/"highlight" = the docked review; "assemble" = the docked auto-assemble review. */
	mode: "cut" | "highlight" | "assemble";
	/**
	 * Cut-review lifecycle (U8). "review" = proposing, nothing applied yet. "applied"
	 * = the plan is on the timeline but the panel STAYS OPEN and editable: toggling a
	 * row revises the applied cut in place, and only an explicit dismiss clears it.
	 * "applied-locked" (U8 fix) = the applied batch is no longer the controllable top
	 * of the undo stack (the user made an intervening edit or a manual Ctrl+Z), so
	 * revise + A/B are disabled and only Dismiss remains: the AI cut is now just part
	 * of the user's timeline, which is the correct, expected behavior.
	 */
	phase: "review" | "applied" | "applied-locked";
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
	/**
	 * The applied Director command handle (U8 fix). The revisable flow verifies this
	 * is still the stack top a revise / A/B would act on BEFORE it undoes/redoes, so
	 * an intervening manual Ctrl+Z or timeline edit can never make it touch the wrong
	 * command. Null before apply and when the decisions cut nothing.
	 */
	appliedBatch: Command | null;
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
	/** The last failed run (round 12 U3/R4), rendered as a persistent error card in
	 * the dock. Null when the last run succeeded, was dismissed, or none ran yet. */
	runError: DirectorRunError | null;
	/**
	 * Cancel-rollback fix (U8): the undo-stack mark from before the Director run's
	 * pre-pass mutations (assemble-if-empty, chronological reorder). The docked
	 * cut panel's Cancel button rolls the timeline back to this mark in one step,
	 * so cancelling restores exactly the pre-run state instead of leaving those
	 * mutations behind. Set only by `openCutPanel` (cut mode); null in
	 * highlight/assemble mode and cleared by `close`/every new run.
	 */
	rollbackMark: number | null;
	/**
	 * The safety companion to `rollbackMark` (see `run-director.ts`'s
	 * `onRunStart`): the undo-stack height right after the pre-pass finished.
	 * Cancel only rolls back to `rollbackMark` when the undo stack is STILL at
	 * exactly this height - the docked panel is non-modal, so the user can keep
	 * editing while the run works or while the panel sits open, and a rollback
	 * must never also undo THEIR edits.
	 */
	rollbackGuardMark: number | null;
	/** Record a failed run (the catch in ai-cut-actions.ts). `at` is stamped here. */
	setRunError: (args: { stage: string; message: string }) => void;
	/** Dismiss the error card (also cleared by every new run and every open*). */
	clearRunError: () => void;
	/** Focus a dock tab directly (the tab header click handler). */
	setDockTab: (tab: "properties" | "director") => void;
	/** Open the auto-assemble REVIEW, docked (auto-focuses the Director tab). */
	openAssemble: (args: { draft: AssemblyDraft }) => void;
	/** Replace the draft's spans (after a drop / re-include / swap) — the panel re-projects the timeline. */
	applyDraftEdit: (spans: DraftSpan[]) => void;
	/** Close the assemble panel, leaving the assembled cut on the timeline. */
	closeAssemble: () => void;
	/**
	 * Dock the cut review (U6): a fresh plan (all ops accepted) + any near-tie
	 * notes + redundancy groups, rendered inside the persistent Director dock.
	 * Persistent + editable while the user works, surviving deselection.
	 * Auto-focuses the Director dock tab (R1).
	 */
	openCutPanel: (args: {
		plan: DirectorPlan;
		nearTies?: readonly NearTieNote[];
		redundancyGroups?: readonly RedundancyReviewGroup[];
		words?: readonly WordTiming[];
		protectedSpans?: readonly { startSec: number; endSec: number }[];
		/** The pre-run undo-stack mark (see `rollbackMark` above); omitted means
		 * there's nothing to roll back to (Cancel just discards the plan). */
		rollbackMark?: number | null;
		/** The safety companion mark (see `rollbackGuardMark` above). */
		rollbackGuardMark?: number | null;
	}) => void;
	/** Swap a redundancy group's keeper: rebuild that group's cut ops for the chosen take (U5b). */
	swapRedundancyKeeper: (args: { groupId: string; keeperLineId: string }) => void;
	/**
	 * Open the Highlight review, docked (R1: the highlight modal is retired). This
	 * populates the persistent Director dock the same way `openCutPanel` does,
	 * instead of popping a modal). Keep rows accepted by default, with preview +
	 * totalSec. Auto-focuses the Director dock tab.
	 */
	openHighlight: (args: {
		keeps: readonly { startSec: number; endSec: number; text?: string }[];
		preview: HighlightPreview;
		totalSec: number;
	}) => void;
	/** Flip one op/keep-row's accept/reject. */
	toggle: (id: string) => void;
	/**
	 * Set rows' decisions at once (bulk select-all / deselect-all). Without `ids`
	 * this flips every row; with `ids` it flips ONLY those rows (U8 fix: the panel
	 * passes the currently-FILTERED visible ids so a bulk toggle never flips hidden
	 * rows). Cleared ids leave the auto-downgraded set (only the flipped rows become
	 * explicit).
	 */
	setAll: (accepted: boolean, ids?: readonly string[]) => void;
	/** The currently-accepted ops (cut mode). */
	acceptedOps: () => DirectorOp[];
	/** The currently-accepted keep rows (highlight mode). */
	acceptedKeeps: () => HighlightKeepRow[];
	/**
	 * Mark the plan APPLIED (U8): the panel stays open in the applied phase with the
	 * plan + decisions intact. `batch` is the executed Director command handle (null
	 * when the decisions cut nothing); `appliedHasBatch` is derived from it. Resets
	 * the phase to a live "applied" and A/B to "with".
	 */
	markApplied: (args: { batch: Command | null }) => void;
	/** Set the A/B preview state (U8). Never clears the plan. */
	setAbShowing: (showing: "with" | "without") => void;
	/**
	 * Lock the applied phase (U8 fix): the batch is no longer controllable (an
	 * intervening edit / manual Ctrl+Z moved it), so disable revise + A/B. Only
	 * Dismiss remains. No-op unless currently in the live "applied" phase.
	 */
	lockApplied: () => void;
	/** Close and clear. The ONLY thing that discards an applied plan (U8). */
	close: () => void;
	/**
	 * Seconds of lead-in when a review row jumps the playhead (round 9): a click
	 * seeks to (cut start - this) so the transition INTO the cut is watchable.
	 * Session preference: lives OUTSIDE the CLEARED reset, so open/close/new-run
	 * cycles preserve it.
	 */
	seekPreRollSec: number;
	/** Set the jump lead-in, clamped to the slider's 1-10s band. */
	setSeekPreRollSec: (sec: number) => void;
}

const CLEARED = {
	dockTab: "properties" as const,
	mode: "cut" as const,
	phase: "review" as const,
	abShowing: "with" as const,
	appliedHasBatch: false,
	appliedBatch: null,
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
	runError: null,
	rollbackMark: null,
	rollbackGuardMark: null,
};

export const useDirectorPlanStore = create<DirectorPlanState>((set, get) => ({
	...CLEARED,
	seekPreRollSec: 1,
	setSeekPreRollSec: (sec) =>
		set({ seekPreRollSec: Math.max(1, Math.min(10, Math.round(sec))) }),
	setRunError: ({ stage, message }) =>
		set({ runError: { stage, message, at: Date.now() } }),
	clearRunError: () => set({ runError: null }),
	setDockTab: (tab) => set({ dockTab: tab }),
	openAssemble: ({ draft }) =>
		set({ ...CLEARED, mode: "assemble", draft, dockTab: "director" }),
	applyDraftEdit: (spans) =>
		set((state) =>
			state.draft ? { draft: { ...state.draft, spans } } : {},
		),
	closeAssemble: () => set({ ...CLEARED }),
	openCutPanel: ({
		plan,
		nearTies,
		redundancyGroups,
		words,
		protectedSpans,
		rollbackMark,
		rollbackGuardMark,
	}) =>
		set({
			...CLEARED,
			mode: "cut",
			plan,
			decisions: initDecisions(plan),
			words: [...(words ?? [])],
			protectedSpans: [...(protectedSpans ?? [])],
			nearTies: [...(nearTies ?? [])],
			redundancyGroups: [...(redundancyGroups ?? [])],
			dockTab: "director",
			rollbackMark: rollbackMark ?? null,
			rollbackGuardMark: rollbackGuardMark ?? null,
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
				// KTD5: word-refine the rebuilt cuts so a swapped keeper's edges land on
				// word gaps like the main chain (the store has words but not the envelope,
				// so energy-snap is skipped here — refinement still removes mid-word landings).
				words: state.words,
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
		// Docks the same way `openCutPanel` does (R1: the highlight modal is retired).
		set({
			...CLEARED,
			mode: "highlight",
			keeps: rows,
			decisions,
			preview,
			totalSec,
			dockTab: "director",
		});
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
	setAll: (accepted, ids) =>
		set((state) => {
			const targetIds =
				ids ??
				(state.mode === "highlight"
					? state.keeps.map((k) => k.id)
					: (state.plan?.operations ?? []).map((o) => o.id));
			const decisions: OpDecisions = { ...state.decisions };
			for (const id of targetIds) decisions[id] = accepted;
			// A bulk toggle is an explicit user decision on each row it touches, so
			// those rows are no longer system-downgraded (RX1). Rows OUTSIDE the target
			// set keep whatever downgrade state they had (a filtered bulk toggle must
			// not silently re-arm hidden auto-downgraded rows).
			const target = new Set(targetIds);
			return {
				decisions,
				autoDowngradedIds: state.autoDowngradedIds.filter((id) => !target.has(id)),
			};
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
	markApplied: ({ batch }) =>
		set({
			phase: "applied",
			appliedBatch: batch,
			appliedHasBatch: batch !== null,
			abShowing: "with",
		}),
	setAbShowing: (showing) => set({ abShowing: showing }),
	lockApplied: () =>
		set((state) => (state.phase === "applied" ? { phase: "applied-locked" } : {})),
	close: () => set({ ...CLEARED }),
}));

// Dev convenience (mirrors window.__vibeEditor in core/index.ts): lets console
// sessions and automated smoke checks drive the review dock directly.
if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") {
	(
		window as unknown as { __directorPlanStore?: typeof useDirectorPlanStore }
	).__directorPlanStore = useDirectorPlanStore;
}
