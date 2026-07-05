"use client";

/**
 * The Director cut REVIEW, docked in the right inspector (U6 / R6). Same body as the
 * "cut" branch of DirectorReviewDialog (accept/reject rows, one swap-to-alternate
 * picker per redundancy group, near-tie notes, Apply N of M) but wrapped in the
 * DirectorPanel shell so it stays open + editable while the user works and survives
 * deselecting all clips. Apply is still one BatchCommand (Ctrl+Z restores everything).
 */

import { Fragment, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useEditor } from "@/editor/use-editor";
import type { EditorCore } from "@/core";
import { applyDirectorPlan } from "../apply-plan";
import {
	isBatchControllable,
	isReactorSuppressed,
	reviseAppliedPlan,
	toggleAbPreview,
	withReactorSuppressed,
} from "../applied-plan";
import {
	selectApplyGuardSpans,
	selectFilteredOps,
	useDirectorPlanStore,
	type ReviewRowFilter,
} from "../director-plan-store";
import { useDirectorTasteStore } from "../taste";
import { describeReviewOp, formatTimecode, formatTimeRange } from "../review-format";

const ROW_FILTERS: { id: ReviewRowFilter; label: string }[] = [
	{ id: "all", label: "All" },
	{ id: "recommended", label: "Recommended" },
	{ id: "optin", label: "Opt-in" },
	{ id: "rejected", label: "Rejected" },
];

// Register (once per editor) a command reactor that LOCKS the applied phase the
// moment an external edit or redo moves the Director batch off the controllable
// stack top. Suppressed during our own revise/A-B so those never self-lock. A
// manual Ctrl+Z (undo does not fire reactors) is caught instead by the guard inside
// reviseAppliedPlan/toggleAbPreview on the next interaction, which refuses to touch
// the moved batch and locks then. Either way the user never loses work.
const reactorRegistered = new WeakSet<object>();
function ensureAppliedReactor(editor: EditorCore): void {
	if (reactorRegistered.has(editor)) return;
	reactorRegistered.add(editor);
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

export function DirectorCutPanel() {
	const editor = useEditor();
	const plan = useDirectorPlanStore((s) => s.plan);
	const decisions = useDirectorPlanStore((s) => s.decisions);
	const nearTies = useDirectorPlanStore((s) => s.nearTies);
	const toggle = useDirectorPlanStore((s) => s.toggle);
	const setAll = useDirectorPlanStore((s) => s.setAll);
	const close = useDirectorPlanStore((s) => s.close);
	const redundancyGroups = useDirectorPlanStore((s) => s.redundancyGroups);
	const swapRedundancyKeeper = useDirectorPlanStore((s) => s.swapRedundancyKeeper);
	const phase = useDirectorPlanStore((s) => s.phase);
	const abShowing = useDirectorPlanStore((s) => s.abShowing);
	const appliedHasBatch = useDirectorPlanStore((s) => s.appliedHasBatch);
	const markApplied = useDirectorPlanStore((s) => s.markApplied);
	const setAbShowing = useDirectorPlanStore((s) => s.setAbShowing);
	const lockApplied = useDirectorPlanStore((s) => s.lockApplied);
	const [rowFilter, setRowFilter] = useState<ReviewRowFilter>("all");

	// Register the applied-phase safety reactor once for this editor.
	useEffect(() => {
		ensureAppliedReactor(editor);
	}, [editor]);

	if (!plan) return null;

	const ops = plan.operations;
	const acceptedCount = ops.filter((op) => decisions[op.id]).length;
	// "applied" covers both the live and the locked applied phases; "locked" disables
	// revise + A/B (the batch is no longer the controllable top of the undo stack).
	const applied = phase === "applied" || phase === "applied-locked";
	const locked = phase === "applied-locked";
	const visibleOps = selectFilteredOps({ ops, decisions, filter: rowFilter });

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
		toast.info("Director: this cut is now part of your timeline", {
			description:
				"You edited or undid since applying, so it can't be revised here anymore. Reopen AI CUT to recut.",
		});
	};

	// Swap-to-alternate (U5b): render ONE keeper dropdown per redundancy group, on the
	// group's first visible row, so a 3-take group with 2 cut rows shows a single picker.
	const groupById = new Map(redundancyGroups.map((g) => [g.groupId, g]));
	const firstOpIdByGroup = new Map<string, string>();
	for (const op of ops) {
		if (op.groupId && !firstOpIdByGroup.has(op.groupId)) {
			firstOpIdByGroup.set(op.groupId, op.id);
		}
	}

	const fpsFloat = (): number => {
		const fps = editor.project.getActive().settings.fps;
		return fps.denominator > 0 && fps.numerator > 0
			? fps.numerator / fps.denominator
			: 30;
	};

	// Read the LIVE recipe (a toggle updates the store before apply/revise runs, so
	// the current-render closure would be stale) and resolve the apply arguments.
	// Rejected rows must survive apply (F5/X6): carved out of the final ranges and
	// shielded from gap coalescing. Shared selector so the modal and this panel can
	// never drift; the premise guard already ran inside `toggle`.
	const resolveApplyArgs = () => {
		const s = useDirectorPlanStore.getState();
		if (!s.plan) return null;
		const accepted = s.plan.operations.filter((op) => s.decisions[op.id]);
		const guards = selectApplyGuardSpans({
			plan: s.plan,
			decisions: s.decisions,
			protectedSpans: s.protectedSpans,
			autoDowngradedIds: s.autoDowngradedIds,
		});
		return {
			editor,
			ops: accepted,
			words: s.words,
			fps: fpsFloat(),
			protectedSpansSec: guards.protectedSpansSec,
			rejectedSpansSec: guards.rejectedSpansSec,
		} as const;
	};

	// First apply from the review phase: run the plan, seed taste once, and stay open
	// in the applied phase (U8). The plan + decisions persist so rows stay revisable.
	const apply = () => {
		const args = resolveApplyArgs();
		if (!args) return;
		const result = applyDirectorPlan(args);
		useDirectorTasteStore.getState().noteReviewDecisions(
			ops.map((op) => ({
				op: op.op,
				category: op.category,
				accepted: Boolean(useDirectorPlanStore.getState().decisions[op.id]),
			})),
		);
		markApplied({ batch: result.appliedCommand });
		if (result.cuts === 0 && result.reorders === 0) {
			toast.info("Director: nothing applied");
		} else {
			const parts: string[] = [];
			if (result.cuts > 0) {
				parts.push(
					`${result.cuts} cut${result.cuts === 1 ? "" : "s"} (${result.removedSec.toFixed(1)}s)`,
				);
			}
			if (result.reorders > 0) {
				parts.push(`${result.reorders} reorder${result.reorders === 1 ? "" : "s"}`);
			}
			toast.success(`Director: ${parts.join(", ")}`, {
				description: "Toggle any row to revise. Ctrl+Z restores everything.",
			});
		}
	};

	// Revise the applied cut in place (U8): undo the prior Director batch and re-apply
	// the current decisions, so it stays ONE undoable batch. GUARDED (U8 fix): if a
	// manual Ctrl+Z / external edit moved the batch off the controllable top, the
	// revise is refused and the phase locks instead of touching the wrong command.
	const revise = () => {
		const args = resolveApplyArgs();
		if (!args) return;
		const outcome = reviseAppliedPlan({ ...args, state: revisableState() });
		if (outcome.status === "locked") {
			notifyLocked();
			return;
		}
		markApplied({ batch: outcome.result.appliedCommand });
	};

	// A row toggle revises live once applied; before apply it just records the choice.
	// In the locked phase revise is disabled (the checkbox is disabled too).
	const handleToggle = (id: string) => {
		toggle(id);
		if (useDirectorPlanStore.getState().phase === "applied") revise();
	};

	// Bulk select/deselect the currently FILTERED visible rows only (U8 fix: never
	// flips hidden rows), then revise live if applied.
	const handleSetAll = (accepted: boolean) => {
		setAll(
			accepted,
			visibleOps.map((op) => op.id),
		);
		if (useDirectorPlanStore.getState().phase === "applied") revise();
	};

	// A/B: undo/redo the batch to preview the timeline without vs with the cuts.
	// GUARDED (U8 fix): a moved batch locks instead of undoing/redoing the wrong one.
	const handleAb = () => {
		const outcome = toggleAbPreview({ editor, state: revisableState() });
		if (outcome.status === "locked") {
			notifyLocked();
			return;
		}
		setAbShowing(outcome.showing);
	};

	// Dismiss is the ONLY thing that clears the plan (U8). If mid A/B "without" AND the
	// batch is still controllable, redo first so the applied cuts (not the previewed
	// original) are what stays; in the locked phase we must not touch the moved stack.
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
			toast.info("Director: review closed", {
				description: "Applied cuts stay on the timeline (Ctrl+Z to undo).",
			});
			return;
		}
		close();
		toast.info("Director: review cancelled", {
			description: "No cuts were applied. Any auto-assembled footage stays (Ctrl+Z to undo).",
		});
	};

	return (
		<div className="panel bg-background flex h-full flex-col overflow-hidden rounded-sm border">
			<div className="border-b p-3">
				<div className="flex items-center justify-between">
					<h2 className="text-sm font-semibold">
						Director&apos;s cut &middot;{" "}
						{locked ? "applied (locked)" : applied ? "applied" : "review"}
					</h2>
					<Button variant="ghost" size="sm" onClick={handleDismiss}>
						Done
					</Button>
				</div>
				<p className="text-muted-foreground text-xs">
					{locked
						? "This cut is now part of your timeline (you edited or undid since applying). Reopen AI CUT to recut. Ctrl+Z still works."
						: applied
							? "Applied. Toggle any row to revise the cut in place, or A/B the original. Ctrl+Z restores everything."
							: "Review each proposed change and apply the ones you want. Ctrl+Z restores everything."}
				</p>
			</div>

			{ops.length === 0 && nearTies.length === 0 ? (
				<p className="text-muted-foreground p-3 text-sm">
					The Director found nothing to change.
				</p>
			) : (
				<>
					<div className="flex flex-wrap items-center gap-2 px-2 pt-2">
						<Button
							variant="ghost"
							size="sm"
							disabled={locked}
							onClick={() => handleSetAll(true)}
						>
							Select all
						</Button>
						<Button
							variant="ghost"
							size="sm"
							disabled={locked}
							onClick={() => handleSetAll(false)}
						>
							Deselect all
						</Button>
						{applied && appliedHasBatch && !locked ? (
							<Button
								variant="outline"
								size="sm"
								className="ml-auto"
								onClick={handleAb}
							>
								{abShowing === "with" ? "Preview original" : "Preview cuts"}
							</Button>
						) : null}
					</div>
					<div className="flex flex-wrap gap-1 px-2 pt-2">
						{ROW_FILTERS.map((f) => (
							<Button
								key={f.id}
								variant={rowFilter === f.id ? "secondary" : "ghost"}
								size="sm"
								onClick={() => setRowFilter(f.id)}
							>
								{f.label}
							</Button>
						))}
					</div>
					<div className="flex-1 space-y-1 overflow-y-auto p-2">
						{visibleOps.length === 0 ? (
							<p className="text-muted-foreground px-1 py-2 text-xs">
								No rows in this filter.
							</p>
						) : null}
						{visibleOps.map((op) => {
							const accepted = Boolean(decisions[op.id]);
							const display = describeReviewOp({ op, accepted });
							// Show the keeper picker once per group, on its first row.
							const swapGroup =
								op.groupId && firstOpIdByGroup.get(op.groupId) === op.id
									? groupById.get(op.groupId)
									: undefined;
							return (
								<Fragment key={op.id}>
									<label
										htmlFor={`director-cut-op-${op.id}`}
										className="hover:bg-accent/40 flex cursor-pointer items-start gap-3 rounded-sm border p-2"
									>
										<Checkbox
											id={`director-cut-op-${op.id}`}
											checked={accepted}
											disabled={locked}
											onCheckedChange={() => handleToggle(op.id)}
											className="mt-1"
										/>
										<span className="text-foreground min-w-0 flex-1 text-sm">
											<span className="bg-secondary mr-2 rounded-sm px-1.5 py-0.5 text-xs font-semibold">
												{display.badge}
											</span>
											{display.categoryBadge ? (
												<span className="bg-primary/15 text-primary mr-2 rounded-sm px-1.5 py-0.5 text-xs font-semibold">
													{display.categoryBadge}
												</span>
											) : null}
											<span className="text-muted-foreground mr-2 text-xs">
												{formatTimeRange({ startSec: op.startSec, endSec: op.endSec })}
											</span>
											{op.reason}
											{display.rejectedHint ? (
												<span className="ml-2 text-xs font-medium text-amber-600 dark:text-amber-500">
													· {display.rejectedHint}
												</span>
											) : null}
										</span>
									</label>
									{swapGroup ? (
										<div className="ml-9 flex items-center gap-2 pb-1 text-xs">
											<span className="text-muted-foreground shrink-0">Keep instead:</span>
											<select
												aria-label="Choose which take to keep"
												className="border-input bg-background text-foreground min-w-0 flex-1 rounded-sm border px-1.5 py-1 text-xs"
												value={swapGroup.keeperLineId}
												onChange={(e) =>
													swapRedundancyKeeper({
														groupId: swapGroup.groupId,
														keeperLineId: e.target.value,
													})
												}
											>
												{swapGroup.members.map((m) => (
													<option key={m.lineId} value={m.lineId}>
														{formatTimecode(m.startSec)} — {m.text.trim().slice(0, 60) || "(take)"}
													</option>
												))}
											</select>
										</div>
									) : null}
								</Fragment>
							);
						})}
						{nearTies.length > 0 ? (
							<div className="border-amber-500/40 bg-amber-500/10 mt-2 space-y-2 rounded-sm border p-2">
								<p className="text-foreground text-sm font-medium">
									Near-identical takes — pick one to cut yourself
								</p>
								<p className="text-muted-foreground text-xs">
									These takes were too close to auto-pick a keeper, so nothing was
									removed. Trim the weaker one manually.
								</p>
								{nearTies.map((note) => (
									<div
										key={`${note.kind}-${note.members[0]?.startSec ?? 0}`}
										className="space-y-0.5 text-xs"
									>
										{note.members.map((m) => (
											<div key={m.startSec} className="text-muted-foreground">
												<span className="text-foreground font-mono">
													{formatTimeRange({ startSec: m.startSec, endSec: m.endSec })}
												</span>{" "}
												&ldquo;{m.text.trim().slice(0, 80)}&rdquo;
											</div>
										))}
									</div>
								))}
							</div>
						) : null}
					</div>
				</>
			)}

			{applied ? (
				<div className="flex items-center justify-between gap-2 border-t p-3">
					<span className="text-muted-foreground text-xs">
						{locked
								? "Cut locked into the timeline"
								: `Applied ${acceptedCount} of ${ops.length}${abShowing === "without" ? " · previewing original" : ""}`}
					</span>
					<Button size="sm" onClick={handleDismiss}>
						Done
					</Button>
				</div>
			) : (
				<div className="flex justify-end gap-2 border-t p-3">
					<Button variant="ghost" size="sm" onClick={handleDismiss}>
						Cancel
					</Button>
					<Button size="sm" onClick={apply} disabled={ops.length === 0}>
						Apply {acceptedCount} of {ops.length}
					</Button>
				</div>
			)}
		</div>
	);
}
