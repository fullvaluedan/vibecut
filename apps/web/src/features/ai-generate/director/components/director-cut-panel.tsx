"use client";

/**
 * The Director cut REVIEW, docked in the right inspector (U6 / R6). Same body as the
 * "cut" branch of DirectorReviewDialog (accept/reject rows, one swap-to-alternate
 * picker per redundancy group, near-tie notes, Apply N of M) but wrapped in the
 * DirectorPanel shell so it stays open + editable while the user works and survives
 * deselecting all clips. Apply is still one BatchCommand (Ctrl+Z restores everything).
 */

import { Fragment } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useEditor } from "@/editor/use-editor";
import { applyDirectorPlan } from "../apply-plan";
import { useDirectorPlanStore } from "../director-plan-store";
import { useDirectorTasteStore } from "../taste";
import { describeReviewOp, formatTimecode, formatTimeRange } from "../review-format";

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
	const words = useDirectorPlanStore((s) => s.words);
	const protectedSpans = useDirectorPlanStore((s) => s.protectedSpans);

	if (!plan) return null;

	const ops = plan.operations;
	const acceptedCount = ops.filter((op) => decisions[op.id]).length;

	// Swap-to-alternate (U5b): render ONE keeper dropdown per redundancy group, on the
	// group's first visible row, so a 3-take group with 2 cut rows shows a single picker.
	const groupById = new Map(redundancyGroups.map((g) => [g.groupId, g]));
	const firstOpIdByGroup = new Map<string, string>();
	for (const op of ops) {
		if (op.groupId && !firstOpIdByGroup.has(op.groupId)) {
			firstOpIdByGroup.set(op.groupId, op.id);
		}
	}

	// Dismissing the panel does NOT roll back the timeline: run-director already ran
	// assemble + remove-silences (each its own command) BEFORE opening this. Signpost
	// that it's reversible.
	const handleCancel = () => {
		close();
		toast.info("Director: review cancelled", {
			description: "Footage was assembled and silences removed — Ctrl+Z to undo.",
		});
	};

	const apply = () => {
		const accepted = ops.filter((op) => decisions[op.id]);
		const fps = editor.project.getActive().settings.fps;
		const fpsFloat =
			fps.denominator > 0 && fps.numerator > 0 ? fps.numerator / fps.denominator : 30;
		// A REJECTED row's span must survive apply-time coalescing (review F5): its gap
		// between two accepted cuts would otherwise be swallowed, deleting exactly what
		// the user chose to keep. Plan-time keepers ride along from the store.
		const protectedSpansSec = [
			...protectedSpans,
			...ops
				.filter((op) => !decisions[op.id] && (op.op === "cut" || op.op === "take_select"))
				.map((op) => ({ startSec: op.startSec, endSec: op.endSec })),
		];
		const result = applyDirectorPlan({
			editor,
			ops: accepted,
			words,
			fps: fpsFloat,
			protectedSpansSec,
		});
		// Seed the taste signal from every reviewed decision (accepted or not).
		useDirectorTasteStore.getState().noteReviewDecisions(
			ops.map((op) => ({
				op: op.op,
				category: op.category,
				accepted: Boolean(decisions[op.id]),
			})),
		);
		close();
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
				description: "Ctrl+Z restores everything.",
			});
		}
	};

	return (
		<div className="panel bg-background flex h-full flex-col overflow-hidden rounded-sm border">
			<div className="border-b p-3">
				<div className="flex items-center justify-between">
					<h2 className="text-sm font-semibold">Director&apos;s cut — review</h2>
					<Button variant="ghost" size="sm" onClick={handleCancel}>
						Done
					</Button>
				</div>
				<p className="text-muted-foreground text-xs">
					Review each proposed change and apply the ones you want — Ctrl+Z
					restores everything.
				</p>
			</div>

			{ops.length === 0 && nearTies.length === 0 ? (
				<p className="text-muted-foreground p-3 text-sm">
					The Director found nothing to change.
				</p>
			) : (
				<>
					<div className="flex gap-2 px-2 pt-2">
						<Button variant="ghost" size="sm" onClick={() => setAll(true)}>
							Select all
						</Button>
						<Button variant="ghost" size="sm" onClick={() => setAll(false)}>
							Deselect all
						</Button>
					</div>
					<div className="flex-1 space-y-1 overflow-y-auto p-2">
						{ops.map((op) => {
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
											onCheckedChange={() => toggle(op.id)}
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

			<div className="flex justify-end gap-2 border-t p-3">
				<Button variant="ghost" size="sm" onClick={handleCancel}>
					Cancel
				</Button>
				<Button size="sm" onClick={apply} disabled={ops.length === 0}>
					Apply {acceptedCount} of {ops.length}
				</Button>
			</div>
		</div>
	);
}
