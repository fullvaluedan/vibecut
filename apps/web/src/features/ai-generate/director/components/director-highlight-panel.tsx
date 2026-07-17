"use client";

/**
 * The Highlight REVIEW, docked in the persistent Director dock (R1). A docked twin
 * of the old highlight-mode branch of `DirectorReviewDialog` (accept = keep, reject
 * = drop; a live "keeping N of M" preview), but wrapped like `DirectorCutPanel` so
 * it STAYS OPEN + editable after apply instead of closing: toggling a keep row
 * revises the applied cut in place, and an A/B preview flips the timeline with vs
 * without it. Apply is still one undoable command (Ctrl+Z restores everything).
 * The highlight MODAL path is retired: `openHighlight` populates this panel.
 */

import { useEffect } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useEditor } from "@/editor/use-editor";
import { applyHighlightPlan } from "../apply-plan";
import {
	ensureAppliedLockReactor,
	isBatchControllable,
	reviseAppliedHighlightPlan,
	toggleAbPreview,
	withReactorSuppressed,
} from "../applied-plan";
import { useDirectorPlanStore } from "../director-plan-store";
import { formatTimeRange } from "../review-format";
import { formatHighlightPreview } from "../highlight-preview";

export function DirectorHighlightPanel() {
	const editor = useEditor();
	const keeps = useDirectorPlanStore((s) => s.keeps);
	const decisions = useDirectorPlanStore((s) => s.decisions);
	const totalSec = useDirectorPlanStore((s) => s.totalSec);
	const toggle = useDirectorPlanStore((s) => s.toggle);
	const setAll = useDirectorPlanStore((s) => s.setAll);
	const close = useDirectorPlanStore((s) => s.close);
	const phase = useDirectorPlanStore((s) => s.phase);
	const abShowing = useDirectorPlanStore((s) => s.abShowing);
	const appliedHasBatch = useDirectorPlanStore((s) => s.appliedHasBatch);
	const markApplied = useDirectorPlanStore((s) => s.markApplied);
	const setAbShowing = useDirectorPlanStore((s) => s.setAbShowing);
	const lockApplied = useDirectorPlanStore((s) => s.lockApplied);

	// Register the shared applied-phase safety reactor once for this editor (the
	// same one DirectorCutPanel uses; the lock condition is mode-agnostic).
	useEffect(() => {
		ensureAppliedLockReactor(editor);
	}, [editor]);

	if (keeps.length === 0) return null;

	const acceptedKeeps = keeps.filter((k) => decisions[k.id]);
	const keptSec = acceptedKeeps.reduce((acc, k) => acc + (k.endSec - k.startSec), 0);
	const preview = formatHighlightPreview({
		keptCount: acceptedKeeps.length,
		totalCount: keeps.length,
		keptSec,
		totalSec,
	});
	// "applied" covers both the live and the locked applied phases; "locked" disables
	// revise + A/B (the batch is no longer the controllable top of the undo stack).
	const applied = phase === "applied" || phase === "applied-locked";
	const locked = phase === "applied-locked";

	/** The applied-phase stack slice the guard reads (fresh from the store). */
	const revisableState = () => {
		const s = useDirectorPlanStore.getState();
		return {
			appliedBatch: s.appliedBatch,
			appliedHasBatch: s.appliedHasBatch,
			abShowing: s.abShowing,
		};
	};

	const notifyLocked = () => {
		lockApplied();
		toast.info("Highlight: this cut is now part of your timeline", {
			description:
				"You edited or undid since applying, so it can't be revised here anymore. Reopen AI CUT to rehighlight.",
		});
	};

	/** Read the LIVE accepted keeps (a toggle updates the store before apply/revise
	 * runs, so the current-render closure would be stale). */
	const currentAcceptedKeeps = () => {
		const s = useDirectorPlanStore.getState();
		return s.keeps.filter((k) => s.decisions[k.id]);
	};

	// First apply from the review phase: run the inverse removal and stay open in
	// the applied phase (U8-style, mirroring DirectorCutPanel).
	const apply = () => {
		const accepted = currentAcceptedKeeps();
		if (accepted.length === 0) return;
		try {
			const result = applyHighlightPlan({ editor, keeps: accepted, totalSec });
			markApplied({ batch: result.appliedCommand });
			toast.success(
				`Highlight: kept ${accepted.length} span${accepted.length === 1 ? "" : "s"}, removed ${result.removedSec.toFixed(1)}s`,
				{ description: "Toggle any row to revise. Ctrl+Z restores everything." },
			);
		} catch (e) {
			toast.error("Highlight: nothing to keep", {
				description: e instanceof Error ? e.message : undefined,
			});
		}
	};

	// Revise the applied highlight in place: undo the prior batch and re-apply the
	// current accepted keeps, so it stays ONE undoable batch. GUARDED: a moved batch
	// refuses and locks instead of touching the wrong command.
	const revise = () => {
		const accepted = currentAcceptedKeeps();
		// Never auto-remove the whole timeline from a live toggle: leave the last
		// applied cut in place until the user picks at least one keep again.
		if (accepted.length === 0) return;
		const outcome = reviseAppliedHighlightPlan({
			editor,
			keeps: accepted,
			totalSec,
			state: revisableState(),
		});
		if (outcome.status === "locked") {
			notifyLocked();
			return;
		}
		markApplied({ batch: outcome.result.appliedCommand });
	};

	// A row toggle revises live once applied; before apply it just records the choice.
	const handleToggle = (id: string) => {
		toggle(id);
		if (useDirectorPlanStore.getState().phase === "applied") revise();
	};

	const handleSetAll = (accepted: boolean) => {
		setAll(accepted, keeps.map((k) => k.id));
		if (useDirectorPlanStore.getState().phase === "applied") revise();
	};

	// A/B: undo/redo the batch to preview the timeline without vs with the highlight.
	const handleAb = () => {
		const outcome = toggleAbPreview({ editor, state: revisableState() });
		if (outcome.status === "locked") {
			notifyLocked();
			return;
		}
		setAbShowing(outcome.showing);
	};

	// Dismiss is the ONLY thing that clears the plan. If mid A/B "without" AND the
	// batch is still controllable, redo first so the applied highlight (not the
	// previewed original) is what stays; in the locked phase we must not touch the
	// moved stack.
	const handleDismiss = () => {
		const s = useDirectorPlanStore.getState();
		if (s.phase === "applied" || s.phase === "applied-locked") {
			if (
				s.phase === "applied" &&
				s.appliedHasBatch &&
				s.abShowing === "without" &&
				isBatchControllable(editor, revisableState())
			) {
				withReactorSuppressed(() => editor.command.redo());
			}
			close();
			toast.info("Highlight: review closed", {
				description: "Applied cuts stay on the timeline (Ctrl+Z to undo).",
			});
			return;
		}
		close();
		toast.info("Highlight cancelled", {
			description: "Footage was assembled and silences removed. Ctrl+Z to undo.",
		});
	};

	return (
		<div className="panel bg-background flex h-full flex-col overflow-hidden rounded-sm border">
			<div className="border-b p-3">
				<div className="flex items-center justify-between">
					<h2 className="text-sm font-semibold">
						Highlight &middot; {locked ? "applied (locked)" : applied ? "applied" : "review"}
					</h2>
					<Button variant="ghost" size="sm" onClick={handleDismiss}>
						Done
					</Button>
				</div>
				<p className="text-muted-foreground text-xs">
					{locked
						? "This highlight is now part of your timeline (you edited or undid since applying). Reopen AI CUT to rehighlight. Ctrl+Z still works."
						: applied
							? "Applied. Toggle any row to revise the highlight in place, or A/B the original. Ctrl+Z restores everything."
							: `${preview}. Uncheck a span to drop it. Ctrl+Z restores everything.`}
				</p>
			</div>

			<div className="flex flex-wrap items-center gap-2 px-2 pt-2">
				<Button variant="ghost" size="sm" disabled={locked} onClick={() => handleSetAll(true)}>
					Select all
				</Button>
				<Button variant="ghost" size="sm" disabled={locked} onClick={() => handleSetAll(false)}>
					Deselect all
				</Button>
				{applied && appliedHasBatch && !locked ? (
					<Button variant="outline" size="sm" className="ml-auto" onClick={handleAb}>
						{abShowing === "with" ? "Preview original" : "Preview highlight"}
					</Button>
				) : null}
			</div>

			<div className="flex-1 space-y-1 overflow-y-auto p-2">
				{keeps.map((k) => {
					const accepted = Boolean(decisions[k.id]);
					return (
						<label
							key={k.id}
							htmlFor={`director-highlight-${k.id}`}
							className="hover:bg-accent/40 flex cursor-pointer items-start gap-3 rounded-sm border p-2"
						>
							<Checkbox
								id={`director-highlight-${k.id}`}
								checked={accepted}
								disabled={locked}
								onCheckedChange={() => handleToggle(k.id)}
								className="mt-1"
							/>
							<span className="text-foreground min-w-0 flex-1 text-sm">
								<span
									className={`mr-2 rounded-sm px-1.5 py-0.5 text-xs font-semibold ${accepted ? "bg-primary/15 text-primary" : "bg-secondary text-muted-foreground"}`}
								>
									{accepted ? "Keep" : "Drop"}
								</span>
								<span className="text-muted-foreground mr-2 text-xs">
									{formatTimeRange({ startSec: k.startSec, endSec: k.endSec })}
								</span>
								{k.text ? <>&ldquo;{k.text.trim().slice(0, 100)}&rdquo;</> : null}
							</span>
						</label>
					);
				})}
			</div>

			{applied ? (
				<div className="flex items-center justify-between gap-2 border-t p-3">
					<span className="text-muted-foreground text-xs">
						{locked
							? "Highlight locked into the timeline"
							: `${preview}${abShowing === "without" ? " · previewing original" : ""}`}
					</span>
					<Button size="sm" onClick={handleDismiss}>
						Done
					</Button>
				</div>
			) : (
				<div className="flex items-center justify-between gap-2 border-t p-3">
					<span className="text-muted-foreground text-xs">
						{acceptedKeeps.length === 0 ? "Select at least one span to keep" : ""}
					</span>
					<div className="flex gap-2">
						<Button variant="ghost" size="sm" onClick={handleDismiss}>
							Cancel
						</Button>
						<Button size="sm" onClick={apply} disabled={acceptedKeeps.length === 0}>
							Apply highlight
						</Button>
					</div>
				</div>
			)}
		</div>
	);
}
