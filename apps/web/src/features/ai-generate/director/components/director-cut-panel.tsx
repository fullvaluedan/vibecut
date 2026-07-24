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
import { mediaTimeFromSeconds } from "@/wasm";
import { applyDirectorPlan } from "../apply-plan";
import {
	ensureAppliedLockReactor,
	reviseAppliedPlan,
	toggleAbPreview,
} from "../applied-plan";
import {
	selectApplyGuardSpans,
	selectFilteredOps,
	useDirectorPlanStore,
	type OpDecisions,
	type ReviewRowFilter,
} from "../director-plan-store";
import { useDirectorTasteStore } from "../taste";
import {
	appendRunRecord,
	readRunLedger,
	recordApplyDecisions,
	recordPostApplyRevisions,
	type RunLedgerRecord,
} from "../run-ledger";
import { describeReviewOp, formatTimecode, formatTimeRange } from "../review-format";

const ROW_FILTERS: { id: ReviewRowFilter; label: string }[] = [
	{ id: "all", label: "All" },
	{ id: "recommended", label: "Recommended" },
	{ id: "optin", label: "Opt-in" },
	{ id: "rejected", label: "Rejected" },
];

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
	const seekPreRollSec = useDirectorPlanStore((s) => s.seekPreRollSec);
	const setSeekPreRollSec = useDirectorPlanStore((s) => s.setSeekPreRollSec);
	const abShowing = useDirectorPlanStore((s) => s.abShowing);
	const appliedHasBatch = useDirectorPlanStore((s) => s.appliedHasBatch);
	const markApplied = useDirectorPlanStore((s) => s.markApplied);
	const setAbShowing = useDirectorPlanStore((s) => s.setAbShowing);
	const lockApplied = useDirectorPlanStore((s) => s.lockApplied);
	const [rowFilter, setRowFilter] = useState<ReviewRowFilter>("all");

	// Register the applied-phase safety reactor once for this editor.
	useEffect(() => {
		ensureAppliedLockReactor(editor);
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

	// Jump the playhead to just before a cut and play, so the transition INTO the
	// cut is watchable (round 9). Lead-in comes from the slider (1-10s).
	const previewCut = (startSec: number) => {
		editor.playback.seek({
			time: mediaTimeFromSeconds({
				seconds: Math.max(0, startSec - seekPreRollSec),
			}),
		});
		editor.playback.play();
	};

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

	// Run ledger (taste v2): the project write helper shared by apply (a fresh
	// record) and a post-apply revision (an update to the latest record).
	// `updater` gets the CURRENT project ledger fresh (never a stale closure -
	// this panel is docked and long-lived) and returns the next one; a no-op
	// updater (same array reference back, e.g. nothing actually reversed) skips
	// the project write entirely.
	const persistRunLedger = (
		updater: (ledger: RunLedgerRecord[]) => RunLedgerRecord[],
	) => {
		const project = editor.project.getActive();
		const currentLedger = readRunLedger({ project });
		const nextLedger = updater(currentLedger);
		if (nextLedger === currentLedger) return;
		editor.project.setActiveProject({
			project: {
				...project,
				runLedger: nextLedger,
				metadata: { ...project.metadata, updatedAt: new Date() },
			},
		});
		editor.save.markDirty();
	};

	// A row un-checked AFTER it was already applied (the round-9 persistent
	// review makes this observable) is a stronger "the Director over-cut here"
	// signal than a pre-apply toggle, so the run ledger tracks it separately.
	// `before` is the decisions snapshot from immediately before the toggle
	// that triggered this.
	const recordLedgerRevisions = (before: OpDecisions) => {
		const after = useDirectorPlanStore.getState().decisions;
		persistRunLedger((ledger) =>
			recordPostApplyRevisions({ ledger, operations: ops, before, after }),
		);
	};

	// First apply from the review phase: run the plan, seed taste once, and stay open
	// in the applied phase (U8). The plan + decisions persist so rows stay revisable.
	const apply = () => {
		const args = resolveApplyArgs();
		if (!args) return;
		const result = applyDirectorPlan(args);
		const decisionsAtApply = useDirectorPlanStore.getState().decisions;
		useDirectorTasteStore.getState().noteReviewDecisions(
			ops.map((op) => ({
				op: op.op,
				category: op.category,
				accepted: Boolean(decisionsAtApply[op.id]),
			})),
		);
		// Run ledger (taste v2): fold the apply-time decisions onto the proposal
		// snapshot `openCutPanel` captured, then persist it onto the project so
		// the signal survives closing VibeCut (taste.ts's opStats above are
		// session/device-local; this is per-project and durable).
		const pendingRunRecord = useDirectorPlanStore.getState().pendingRunRecord;
		if (pendingRunRecord) {
			const record = recordApplyDecisions({
				record: pendingRunRecord,
				operations: ops,
				decisions: decisionsAtApply,
			});
			persistRunLedger((ledger) => appendRunRecord({ ledger, record }));
		}
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
	// In the locked phase revise is disabled (the checkbox is disabled too). A toggle
	// that starts already-applied is a post-apply revision (run ledger, taste v2):
	// snapshot decisions BEFORE the flip so recordLedgerRevisions can tell an
	// un-check apart from a re-check.
	const handleToggle = (id: string) => {
		const wasApplied = phase === "applied";
		const before = decisions;
		toggle(id);
		if (useDirectorPlanStore.getState().phase === "applied") revise();
		if (wasApplied) recordLedgerRevisions(before);
	};

	// Bulk select/deselect the currently FILTERED visible rows only (U8 fix: never
	// flips hidden rows), then revise live if applied. Same post-apply-revision
	// tracking as handleToggle above.
	const handleSetAll = (accepted: boolean) => {
		const wasApplied = phase === "applied";
		const before = decisions;
		setAll(
			accepted,
			visibleOps.map((op) => op.id),
		);
		if (useDirectorPlanStore.getState().phase === "applied") revise();
		if (wasApplied) recordLedgerRevisions(before);
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

	// Cancel is review-phase only (round 9: there is no Done, the applied review
	// PERSISTS until the next AI CUT run replaces it). Discards the un-applied
	// plan AND rolls back any pre-review mutation (the assemble-if-empty /
	// chronological-reorder pre-pass in run-director.ts) in one step, so Cancel
	// restores EXACTLY the pre-run timeline (U8 fix, it used to leave that
	// mutation in place with N+1 separate undo entries). GUARDED: this panel is
	// docked (non-modal), so the user can keep editing the timeline while it's
	// open; the rollback only fires if nothing else has touched the undo stack
	// since the pre-pass finished (rollbackGuardMark), so Cancel can never also
	// undo the user's own subsequent edits.
	const handleCancel = () => {
		const { rollbackMark, rollbackGuardMark } = useDirectorPlanStore.getState();
		const rolledBack =
			rollbackMark !== null &&
			rollbackGuardMark !== null &&
			editor.command.getMark() === rollbackGuardMark;
		if (rolledBack) editor.command.rollbackTo(rollbackMark);
		close();
		toast.info("Director: cancelled", {
			description: rolledBack
				? "Nothing was changed. Your timeline is exactly as it was before this run."
				: "The plan was discarded. You made other timeline edits during this run, so Ctrl+Z still walks those back as usual.",
		});
	};

	return (
		<div className="panel bg-background flex h-full flex-col overflow-hidden rounded-sm border">
			<div className="border-b p-3">
				<h2 className="text-sm font-semibold">
					Director&apos;s cut &middot;{" "}
					{locked ? "applied (locked)" : applied ? "applied" : "review"}
				</h2>
				<p className="text-muted-foreground text-xs">
					{locked
						? "This cut is now part of your timeline (you edited or undid since applying). Reopen AI CUT to recut. Ctrl+Z still works."
						: applied
							? "Applied. Toggle any row to revise the cut in place, or A/B the original. Click a timestamp to play into that cut. Ctrl+Z restores everything."
							: "Review each proposed change and apply the ones you want. Click a timestamp to play into that cut. Ctrl+Z restores everything."}
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
					<div className="flex items-center gap-2 px-3 pt-2">
						<span className="text-muted-foreground shrink-0 text-xs">
							Lead-in {seekPreRollSec}s
						</span>
						<input
							type="range"
							min={1}
							max={10}
							step={1}
							value={seekPreRollSec}
							aria-label="Seconds played before a cut when a timestamp is clicked"
							className="min-w-0 flex-1"
							onChange={(e) => setSeekPreRollSec(Number(e.target.value))}
						/>
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
											<button
												type="button"
												title={`Play from ${seekPreRollSec}s before this cut`}
												className="text-muted-foreground hover:text-foreground mr-2 cursor-pointer text-xs underline decoration-dotted underline-offset-2"
												onClick={(e) => {
													// A button inside the row label: never toggle the checkbox.
													e.preventDefault();
													e.stopPropagation();
													previewCut(op.startSec);
												}}
											>
												{formatTimeRange({ startSec: op.startSec, endSec: op.endSec })}
											</button>
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
				<div className="flex items-center gap-2 border-t p-3">
					<span className="text-muted-foreground text-xs">
						{locked
								? "Cut locked into the timeline"
								: `Applied ${acceptedCount} of ${ops.length}${abShowing === "without" ? " · previewing original" : ""} · stays open, a new AI CUT run replaces it`}
					</span>
				</div>
			) : (
				<div className="flex justify-end gap-2 border-t p-3">
					<Button variant="ghost" size="sm" onClick={handleCancel}>
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
