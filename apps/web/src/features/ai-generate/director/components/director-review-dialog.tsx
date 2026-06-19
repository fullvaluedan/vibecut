"use client";

/**
 * The Director Review modal (U4) — the keystone gate (RF1). Lists every proposed
 * op with a type badge, its reason, and a per-op accept/reject checkbox (all
 * accepted by default); "Apply accepted" applies only the checked ops as one
 * undoable step and records the decisions for the taste seed (U6). Rendered once
 * at the editor root; driven by `useDirectorPlanStore`.
 */

import { toast } from "sonner";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useEditor } from "@/editor/use-editor";
import { applyDirectorPlan } from "../apply-plan";
import { useDirectorPlanStore } from "../director-plan-store";
import { useDirectorTasteStore } from "../taste";
import { describeReviewOp } from "../review-format";

export function DirectorReviewDialog() {
	const editor = useEditor();
	const open = useDirectorPlanStore((s) => s.open);
	const plan = useDirectorPlanStore((s) => s.plan);
	const decisions = useDirectorPlanStore((s) => s.decisions);
	const nearTies = useDirectorPlanStore((s) => s.nearTies);
	const toggle = useDirectorPlanStore((s) => s.toggle);
	const close = useDirectorPlanStore((s) => s.close);

	const ops = plan?.operations ?? [];
	const acceptedCount = ops.filter((op) => decisions[op.id]).length;

	// Cancelling/dismissing the modal does NOT roll back the timeline: run-director
	// already ran assemble + remove-silences (each its own command) BEFORE opening
	// this modal, so the footage is laid out and silences are cut. Signpost that
	// it's reversible rather than leaving the user with a silently-mutated timeline.
	// (One-undo rollback-on-cancel is a follow-up — see docs/TO-VERIFY.md.)
	const handleCancel = () => {
		close();
		toast.info("Director: review cancelled", {
			description:
				"Footage was assembled and silences removed — Ctrl+Z to undo.",
		});
	};

	const apply = () => {
		if (!plan) return;
		const accepted = ops.filter((op) => decisions[op.id]);
		const result = applyDirectorPlan({ editor, ops: accepted });
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
				parts.push(
					`${result.reorders} reorder${result.reorders === 1 ? "" : "s"}`,
				);
			}
			toast.success(`Director: ${parts.join(", ")}`, {
				description: "Ctrl+Z restores everything.",
			});
		}
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(isOpen) => {
				if (!isOpen) handleCancel();
			}}
		>
			<DialogContent className="max-w-2xl p-6">
				<DialogTitle>Director&apos;s cut — review</DialogTitle>
				<DialogDescription>
					Review each proposed change and apply the ones you want — Ctrl+Z
					restores everything.
				</DialogDescription>
				{ops.length === 0 && nearTies.length === 0 ? (
					<p className="text-muted-foreground py-6 text-sm">
						The Director found nothing to change.
					</p>
				) : (
					<div className="-mx-1 max-h-[60vh] space-y-1 overflow-y-auto px-1">
						{ops.map((op) => {
							const accepted = Boolean(decisions[op.id]);
							const display = describeReviewOp({ op, accepted });
							return (
								<label
									key={op.id}
									htmlFor={`director-op-${op.id}`}
									className="hover:bg-accent/40 flex cursor-pointer items-start gap-3 rounded-sm border p-2"
								>
									<Checkbox
										id={`director-op-${op.id}`}
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
											{op.startSec.toFixed(1)}–{op.endSec.toFixed(1)}s
										</span>
										{op.reason}
										{display.rejectedHint ? (
											<span className="ml-2 text-xs font-medium text-amber-600 dark:text-amber-500">
												· {display.rejectedHint}
											</span>
										) : null}
									</span>
								</label>
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
													{m.startSec.toFixed(1)}–{m.endSec.toFixed(1)}s
												</span>{" "}
												&ldquo;{m.text.trim().slice(0, 80)}&rdquo;
											</div>
										))}
									</div>
								))}
							</div>
						) : null}
					</div>
				)}
				<div className="flex justify-end gap-2 pt-2">
					<Button variant="ghost" size="sm" onClick={handleCancel}>
						Cancel
					</Button>
					<Button size="sm" onClick={apply} disabled={ops.length === 0}>
						Apply {acceptedCount} of {ops.length}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
