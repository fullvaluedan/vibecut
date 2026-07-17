/**
 * Revisable apply (U8 + U8 fix). Applying a Director plan no longer discards it: the
 * review panel stays open in an "applied" phase where the user can toggle any row and
 * see the cut revise in place, or flip an A/B preview of the timeline with vs without
 * the applied cuts. This module holds the command-orchestration; the store owns the
 * recipe (plan + decisions) and the panel wires the two together.
 *
 * The invariant: the applied plan is always exactly ONE undoable BatchCommand over
 * the pre-Director timeline. A single Ctrl+Z restores the original, and revising
 * never grows the undo stack, because a revise undoes the prior batch before
 * re-applying rather than stacking a second one.
 *
 * The U8 FIX makes that invariant SAFE against the real editor undo stack. The store
 * flags alone are optimistic: a manual Ctrl+Z, or any timeline edit the user makes
 * during the applied phase, moves the Director batch off the controllable top. So
 * every undo/redo here is GUARDED by a live peek of the stack (`isBatchControllable`);
 * if the captured batch is no longer where a revise/A-B would act, the operation is
 * REFUSED (`{ status: "locked" }`) instead of undoing the wrong command, and the panel
 * transitions to the terminal `applied-locked` phase.
 */

import type { EditorCore } from "@/core";
import type { Command } from "@/commands/base-command";
import {
	applyDirectorPlan,
	applyHighlightPlan,
	type ApplyDirectorPlanResult,
	type ApplyHighlightResult,
	type DirectorApplyEditor,
	type InverseKeepSpan,
} from "./apply-plan";
import type { DirectorOp } from "@framecut/hf-bridge";
import type { WordTiming } from "./cut-utils";
import type { ProtectedSpanSec } from "./coalesce-removal-ranges";
import { useDirectorPlanStore } from "./director-plan-store";

/** The command sink the revisable flow needs: execute + undo/redo + read-only peeks. */
export interface RevisableCommandSink {
	execute: (args: { command: Command }) => void;
	undo: () => void;
	redo: () => void;
	/** Command a call to `undo()` would act on (undo-stack top), or null. */
	peekUndoCommand: () => Command | null;
	/** Command a call to `redo()` would act on (redo-stack top), or null. */
	peekRedoCommand: () => Command | null;
}

/** `DirectorApplyEditor` plus the undo/redo/peek the A/B preview and revise use. */
export interface RevisableEditor extends DirectorApplyEditor {
	command: RevisableCommandSink;
}

/** The applied-phase stack bookkeeping the guard reads (a slice of the store). */
export interface RevisableState {
	/** The captured Director command handle, or null when nothing was applied. */
	appliedBatch: Command | null;
	/** Whether an undoable Director batch is currently applied. */
	appliedHasBatch: boolean;
	/** "with" = batch on the timeline (undo-top); "without" = A/B-undone (redo-top). */
	abShowing: "with" | "without";
}

/** The arguments `applyDirectorPlan` needs, minus the plain-`execute` editor. */
export interface RevisableApplyArgs {
	editor: RevisableEditor;
	ops: readonly DirectorOp[];
	words?: readonly WordTiming[];
	fps?: number;
	protectedSpansSec?: readonly ProtectedSpanSec[];
	rejectedSpansSec?: readonly ProtectedSpanSec[];
}

// --- Reactor suppression ---------------------------------------------------
// The panel registers a command reactor (fires on execute/redo) that locks the
// applied phase when an EXTERNAL edit moves the batch off the controllable top.
// Our OWN revise/A-B execute + redo would otherwise trip that reactor mid-op
// (the store still holds the pre-op batch/showing while the new command runs),
// so we suppress the reactor for the duration of our own stack mutations.
let reactorSuppressDepth = 0;

/** Run `fn` with the applied-phase reactor suppressed (re-entrant safe). */
export function withReactorSuppressed<T>(fn: () => T): T {
	reactorSuppressDepth++;
	try {
		return fn();
	} finally {
		reactorSuppressDepth--;
	}
}

/** True while our own stack mutation is running; the reactor must no-op then. */
export function isReactorSuppressed(): boolean {
	return reactorSuppressDepth > 0;
}

/**
 * Is the captured Director batch still the command our next undo/redo would act on?
 * With nothing applied a revise just executes fresh, so that is trivially fine. With
 * a batch applied it must be the undo-top when showing "with", or the redo-top when
 * showing "without"; if a manual Ctrl+Z or an external edit moved it, this is false
 * and the caller must NOT touch the stack.
 */
export function isBatchControllable(
	editor: RevisableEditor,
	state: RevisableState,
): boolean {
	if (!state.appliedHasBatch) return true;
	if (!state.appliedBatch) return false;
	return state.abShowing === "with"
		? editor.command.peekUndoCommand() === state.appliedBatch
		: editor.command.peekRedoCommand() === state.appliedBatch;
}

/** Outcome of a revise: the fresh apply result, or a refusal to touch a moved batch. */
export type ReviseOutcome =
	| { status: "revised"; result: ApplyDirectorPlanResult }
	| { status: "locked" };

/**
 * Revise an already-applied plan: undo the prior Director batch (only when one is
 * currently applied AND showing "with"), then re-apply with the current decisions,
 * so it stays exactly ONE undoable batch over the pre-Director timeline. GUARDED: if
 * the captured batch is no longer the controllable stack top (manual Ctrl+Z / an
 * external edit), returns `{ status: "locked" }` without touching the stack.
 */
export function reviseAppliedPlan({
	state,
	...args
}: RevisableApplyArgs & { state: RevisableState }): ReviseOutcome {
	if (!isBatchControllable(args.editor, state)) return { status: "locked" };
	// Only undo when the batch is actually on the timeline (showing "with"); in the
	// A/B "without" state it is already undone and the fresh execute clears the redo.
	const undoFirst = state.appliedHasBatch && state.abShowing === "with";
	return withReactorSuppressed(() => {
		if (undoFirst) args.editor.command.undo();
		return { status: "revised", result: applyDirectorPlan(args) };
	});
}

/** Outcome of a Highlight revise: the fresh apply result, or a refusal to touch a
 * moved batch. */
export type ReviseHighlightOutcome =
	| { status: "revised"; result: ApplyHighlightResult }
	| { status: "locked" };

/**
 * The Highlight sibling of `reviseAppliedPlan` (R1: the docked highlight panel gets
 * the same stay-open-after-apply / revise-in-place behavior as DirectorCutPanel).
 * Undoes the prior applied batch (only when one is currently applied AND showing
 * "with"), then re-applies the current accepted keeps via `applyHighlightPlan`, so
 * it stays exactly ONE undoable batch. GUARDED the same way: a moved batch refuses
 * instead of touching the wrong command.
 */
export function reviseAppliedHighlightPlan({
	editor,
	keeps,
	totalSec,
	state,
}: {
	editor: RevisableEditor;
	keeps: readonly InverseKeepSpan[];
	totalSec: number;
	state: RevisableState;
}): ReviseHighlightOutcome {
	if (!isBatchControllable(editor, state)) return { status: "locked" };
	const undoFirst = state.appliedHasBatch && state.abShowing === "with";
	return withReactorSuppressed(() => {
		if (undoFirst) editor.command.undo();
		return { status: "revised", result: applyHighlightPlan({ editor, keeps, totalSec }) };
	});
}

/** Outcome of an A/B toggle: the new showing, or a refusal to touch a moved batch. */
export type AbOutcome =
	| { status: "toggled"; showing: "with" | "without" }
	| { status: "locked" };

/**
 * A/B preview toggle (applied phase): from "with" (cuts on the timeline) undo to
 * "without" (the original), and from "without" redo back to "with". GUARDED: only
 * acts when the captured batch is the relevant stack top, else `{ status: "locked" }`.
 * Never touches plan state, so the panel and its decisions survive any toggles.
 */
export function toggleAbPreview({
	editor,
	state,
}: {
	editor: RevisableEditor;
	state: RevisableState;
}): AbOutcome {
	if (!isBatchControllable(editor, state)) return { status: "locked" };
	if (state.abShowing === "with") {
		withReactorSuppressed(() => editor.command.undo());
		return { status: "toggled", showing: "without" };
	}
	withReactorSuppressed(() => editor.command.redo());
	return { status: "toggled", showing: "with" };
}

// --- Applied-lock reactor ---------------------------------------------------
// Registered (once per editor) by whichever docked panel mounts first.
// DirectorCutPanel and DirectorHighlightPanel share this ONE implementation (R1)
// since the lock condition is mode-agnostic: it reads only the generic
// phase/appliedBatch/appliedHasBatch/abShowing store fields. Fires on
// execute/redo and LOCKS the applied phase the moment an external edit or redo
// moves the applied batch off the controllable stack top. Suppressed during our
// own revise/A-B (see `withReactorSuppressed`) so those never self-lock. A manual
// Ctrl+Z (undo does not fire reactors) is instead caught by the guard inside
// reviseAppliedPlan/reviseAppliedHighlightPlan/toggleAbPreview on the next
// interaction, which refuses to touch the moved batch and locks then.
const reactorRegisteredEditors = new WeakSet<object>();

/** Register the applied-lock reactor for `editor`, at most once. */
export function ensureAppliedLockReactor(editor: EditorCore): void {
	if (reactorRegisteredEditors.has(editor)) return;
	reactorRegisteredEditors.add(editor);
	editor.command.registerReactor(() => {
		if (isReactorSuppressed()) return;
		const s = useDirectorPlanStore.getState();
		if (s.phase !== "applied") return;
		const controllable = isBatchControllable(editor, {
			appliedBatch: s.appliedBatch,
			appliedHasBatch: s.appliedHasBatch,
			abShowing: s.abShowing,
		});
		if (!controllable) s.lockApplied();
	});
}
