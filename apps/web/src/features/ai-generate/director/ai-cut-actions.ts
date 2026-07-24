"use client";

/**
 * Shared AI CUT action handlers (R1/KTD1). The four actions (Auto-assemble, AI
 * Director, Highlight, Remove silences) used to live only inside the toolbar's
 * `AiCutMenu` dropdown. The persistent Director dock's idle state offers the same
 * four actions inline, so the run orchestration (progress toasts, abort wiring, the
 * transcriber-pause flag) lives here ONCE and both surfaces call it. Writing
 * progress into `ai-activity-store` instead of local `useState` is what lets the
 * dock's Running view and the toolbar button share one source of truth.
 *
 * Every action also focuses the Director dock tab immediately (Dan's rule): a
 * click switches to the Director tab right away, and the store's `open*` calls
 * (fired on completion) re-assert it, so a run started while the user was on the
 * Properties tab still lands the review in front of them.
 */

import { toast } from "sonner";
import type { EditorCore } from "@/core";
import { runRemoveSilences } from "@/features/editing/remove-silences";
import { useAiActivityStore } from "@/features/ai-generate/ai-activity-store";
import { usePreferenceStore } from "@/features/ai-generate/preference-store";
import { runDirector } from "./run-director";
import { runAssemble } from "./run-assemble";
import { runHighlight } from "./run-highlight";
import { useDirectorPlanStore } from "./director-plan-store";

const fmtSec = (sec: number) => `${sec.toFixed(1)}s`;

/** True while any AI CUT action is running (the shared re-entrancy guard). */
export function isAiCutBusy(): boolean {
	return useAiActivityStore.getState().label !== null;
}

function beginRun(label: string): AbortController {
	const controller = new AbortController();
	const activity = useAiActivityStore.getState();
	activity.setBusy(true);
	activity.setLabel(label);
	activity.setStage("Starting...");
	activity.setCancel(() => controller.abort());
	const planStore = useDirectorPlanStore.getState();
	// A new run supersedes the previous failure: clear the dock's error card
	// (round 12 U3/R4) so the Running view is what the user sees.
	planStore.clearRunError();
	planStore.setDockTab("director");
	return controller;
}

function endRun(): void {
	const activity = useAiActivityStore.getState();
	activity.setBusy(false);
	activity.setLabel(null);
	activity.setStage(null);
	activity.setCancel(null);
}

/** Remove silences: the generic runner, with the standard progress toast + the
 * self-learning note (noteCutRun). The only action that reports a cut count/removed
 * seconds directly rather than opening a review surface. */
export async function runRemoveSilencesAction({
	editor,
}: {
	editor: EditorCore;
}): Promise<void> {
	if (isAiCutBusy()) return;
	const label = "Remove silences";
	const controller = beginRun(label);
	const lastStage = { current: "starting" };
	const toastId = toast.loading(`${label}...`);
	try {
		const { cuts, removedSec } = await runRemoveSilences({ editor });
		usePreferenceStore.getState().noteCutRun(label, {
			durationTicks: editor.timeline.getTotalDuration() as number,
		});
		if (cuts === 0) {
			toast.info(`${label}: nothing to cut`, { id: toastId });
		} else {
			toast.success(
				`${label}: ${cuts} cut${cuts === 1 ? "" : "s"}, ${fmtSec(removedSec)} removed`,
				{ id: toastId, description: "Ctrl+Z restores everything." },
			);
		}
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		if (message === "Cancelled" || controller.signal.aborted) {
			toast.info(`${label} stopped`, { id: toastId });
		} else {
			console.error(`${label} failed during "${lastStage.current}"`, e);
			toast.error(`${label} failed`, {
				id: toastId,
				duration: 15000,
				description: `While "${lastStage.current}": ${message}`,
			});
		}
	} finally {
		endRun();
	}
}

/** AI Director: plans then opens the docked review (that panel owns apply; this
 * flow announces completion with a one-line toast, round 12 U3/R4). A failure
 * writes a persistent error record into the plan store (the dock renders it as
 * an error card with Retry), so the 15-second toast is no longer the only
 * evidence a run died. */
export async function runDirectorAction({ editor }: { editor: EditorCore }): Promise<void> {
	if (isAiCutBusy()) return;
	const controller = beginRun("AI Director");
	const lastStage = { current: "starting" };
	const toastId = toast.loading("AI Director...");
	// Cancel-rollback fix (U8): captured synchronously from runDirector right after
	// its pre-pass finishes, so a cancel BEFORE the review even opens (the review
	// panel's own rollbackMark never gets set in that case) can still restore the
	// timeline to that point. GUARDED the same way the review panel's Cancel is:
	// only rolls back if nothing besides the pre-pass has touched the undo stack
	// since (the user can keep editing while the run transcribes/plans).
	const rollbackMarks: { current: { mark: number; guardMark: number } | null } = {
		current: null,
	};
	try {
		await runDirector({
			editor,
			onRunStart: (marks) => {
				rollbackMarks.current = marks;
			},
			onProgress: (detail) => {
				lastStage.current = detail;
				useAiActivityStore.getState().setStage(detail);
			},
			signal: controller.signal,
		});
		// The review just opened with a fresh plan (runDirector resolves after
		// openCutPanel), so read the proposed-change count straight from the store.
		const opCount =
			useDirectorPlanStore.getState().plan?.operations.length ?? 0;
		toast.success(
			`Director's cut ready - ${opCount} proposed change${opCount === 1 ? "" : "s"}`,
			{ id: toastId },
		);
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		if (message === "Cancelled" || controller.signal.aborted) {
			const marks = rollbackMarks.current;
			if (marks && editor.command.getMark() === marks.guardMark) {
				editor.command.rollbackTo(marks.mark);
			}
			toast.info("AI Director stopped", { id: toastId });
		} else {
			console.error(`AI Director failed during "${lastStage.current}"`, e);
			// Persist the failure so the dock shows an error card until the user
			// dismisses it or a new run starts (round 12 U3/R4). The toast stays as
			// the immediate signal, but it is no longer the only evidence.
			useDirectorPlanStore.getState().setRunError({
				stage: lastStage.current,
				message,
			});
			toast.error("AI Director failed", {
				id: toastId,
				duration: 15000,
				description: `While "${lastStage.current}": ${message}`,
			});
		}
	} finally {
		endRun();
	}
}

/** Auto-assemble (the headline AI feature): read the WHOLE bin (every retake +
 * unused clip), pick the best spans, and lay a rough cut on a new scene. One
 * undoable command (Ctrl+Z reverts). */
export async function runAutoAssembleAction({ editor }: { editor: EditorCore }): Promise<void> {
	if (isAiCutBusy()) return;
	const controller = beginRun("Auto-assemble");
	const lastStage = { current: "starting" };
	const toastId = toast.loading("Auto-assemble...");
	try {
		const result = await runAssemble({
			editor,
			onProgress: (detail) => {
				lastStage.current = detail;
				useAiActivityStore.getState().setStage(detail);
			},
			signal: controller.signal,
		});
		toast.success(
			`Assembled ${result.placed} clip${result.placed === 1 ? "" : "s"} on a new scene`,
			{
				id: toastId,
				description: result.narrative
					? `${result.narrative}. Review it in the panel; your original timeline is untouched.`
					: "Review it in the panel; your original timeline is untouched.",
			},
		);
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		if (message === "Cancelled" || controller.signal.aborted) {
			toast.info("Auto-assemble stopped", { id: toastId });
		} else {
			console.error(`Auto-assemble failed during "${lastStage.current}"`, e);
			toast.error("Auto-assemble failed", {
				id: toastId,
				duration: 15000,
				description: `While "${lastStage.current}": ${message}`,
			});
		}
	} finally {
		endRun();
	}
}

/** Highlight (keep-only): the inverse of the Director (keep the best parts, cut
 * the rest). Opens the docked review in highlight mode (it owns apply). */
export async function runHighlightAction({
	editor,
	budgetSec,
}: {
	editor: EditorCore;
	budgetSec?: number;
}): Promise<void> {
	if (isAiCutBusy()) return;
	const controller = beginRun("Highlight");
	const lastStage = { current: "starting" };
	const toastId = toast.loading("Highlight...");
	try {
		await runHighlight({
			editor,
			budgetSec,
			onProgress: (detail) => {
				lastStage.current = detail;
				useAiActivityStore.getState().setStage(detail);
			},
			signal: controller.signal,
		});
		toast.dismiss(toastId);
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		if (message === "Cancelled" || controller.signal.aborted) {
			toast.info("Highlight stopped", { id: toastId });
		} else {
			console.error(`Highlight failed during "${lastStage.current}"`, e);
			toast.error("Highlight failed", {
				id: toastId,
				duration: 15000,
				description: `While "${lastStage.current}": ${message}`,
			});
		}
	} finally {
		endRun();
	}
}
