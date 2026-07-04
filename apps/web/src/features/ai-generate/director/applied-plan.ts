/**
 * Revisable apply (U8). Applying a Director plan no longer discards it: the review
 * panel stays open in an "applied" phase where the user can toggle any row and see
 * the cut revise in place, or flip an A/B preview of the timeline with vs without
 * the applied cuts. This module holds the pure command-orchestration; the store
 * owns the recipe (plan + decisions) and the panel wires the two together.
 *
 * The invariant: the applied plan is always exactly ONE undoable BatchCommand over
 * the pre-Director timeline. A single Ctrl+Z restores the original, and revising
 * never grows the undo stack, because a revise undoes the prior batch before
 * re-applying rather than stacking a second one.
 */

import type { Command } from "@/commands/base-command";
import {
	applyDirectorPlan,
	type ApplyDirectorPlanResult,
	type DirectorApplyEditor,
} from "./apply-plan";
import type { DirectorOp } from "@framecut/hf-bridge";
import type { WordTiming } from "./cut-utils";
import type { ProtectedSpanSec } from "./coalesce-removal-ranges";

/** The command sink the revisable flow needs: `applyDirectorPlan`'s execute + undo/redo. */
export interface RevisableCommandSink {
	execute: (args: { command: Command }) => void;
	undo: () => void;
	redo: () => void;
}

/** `DirectorApplyEditor` plus the undo/redo the A/B preview and revise use. */
export interface RevisableEditor extends DirectorApplyEditor {
	command: RevisableCommandSink;
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

/**
 * Revise an already-applied plan: undo the prior Director batch (only when one is
 * currently on the timeline), then re-apply with the current decisions. `undoFirst`
 * MUST be false when no batch is applied or the batch is currently A/B-previewed
 * OFF (already undone), otherwise the undo would pop the pre-Director step. After
 * this the timeline again holds exactly one Director batch (or none, if the new
 * decisions cut nothing), and the redo stack is cleared by the fresh execute.
 */
export function reviseAppliedPlan({
	undoFirst,
	...args
}: RevisableApplyArgs & { undoFirst: boolean }): ApplyDirectorPlanResult {
	if (undoFirst) args.editor.command.undo();
	return applyDirectorPlan(args);
}

/**
 * A/B preview toggle (applied phase): from "with" (cuts on the timeline) undo to
 * "without" (the original), and from "without" redo back to "with". Returns the new
 * showing so the store can track it. Never touches plan state, so the panel and its
 * decisions survive any number of toggles.
 */
export function toggleAbPreview({
	editor,
	showing,
}: {
	editor: RevisableEditor;
	showing: "with" | "without";
}): "with" | "without" {
	if (showing === "with") {
		editor.command.undo();
		return "without";
	}
	editor.command.redo();
	return "with";
}
