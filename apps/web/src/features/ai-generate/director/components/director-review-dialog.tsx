"use client";

/**
 * The Director Review modal (U4) — the keystone gate (RF1). Lists every proposed
 * op with a type badge, its reason, and a per-op accept/reject checkbox (all
 * accepted by default); "Apply accepted" applies only the checked ops as one
 * undoable step and records the decisions for the taste seed (U6). Rendered once
 * at the editor root; driven by `useDirectorPlanStore`.
 */

import { toast } from "sonner";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useEditor } from "@/editor/use-editor";
import type { DirectorOp } from "@framecut/hf-bridge";
import { applyDirectorPlan } from "../apply-plan";
import { useDirectorPlanStore } from "../director-plan-store";
import { useDirectorTasteStore } from "../taste";

const OP_BADGE: Record<DirectorOp["op"], string> = {
	cut: "Cut",
	take_select: "Take",
	reorder: "Reorder",
	keep: "Keep",
};

export function DirectorReviewDialog() {
	const editor = useEditor();
	const open = useDirectorPlanStore((s) => s.open);
	const plan = useDirectorPlanStore((s) => s.plan);
	const decisions = useDirectorPlanStore((s) => s.decisions);
	const toggle = useDirectorPlanStore((s) => s.toggle);
	const close = useDirectorPlanStore((s) => s.close);

	const ops = plan?.operations ?? [];
	const acceptedCount = ops.filter((op) => decisions[op.id]).length;

	const apply = () => {
		if (!plan) return;
		const accepted = ops.filter((op) => decisions[op.id]);
		const result = applyDirectorPlan({ editor, ops: accepted });
		// Seed the taste signal from every reviewed decision (accepted or not).
		useDirectorTasteStore.getState().noteReviewDecisions(
			ops.map((op) => ({ op: op.op, accepted: Boolean(decisions[op.id]) })),
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
				if (!isOpen) close();
			}}
		>
			<DialogContent className="max-w-2xl">
				<DialogTitle>Director&apos;s cut — review</DialogTitle>
				{ops.length === 0 ? (
					<p className="text-muted-foreground py-6 text-sm">
						The Director found nothing to change.
					</p>
				) : (
					<div className="-mx-1 max-h-[60vh] space-y-1 overflow-y-auto px-1">
						{ops.map((op) => (
							<label
								key={op.id}
								className="hover:bg-accent/40 flex cursor-pointer items-start gap-3 rounded-sm border p-2"
							>
								<input
									type="checkbox"
									checked={Boolean(decisions[op.id])}
									onChange={() => toggle(op.id)}
									className="mt-1"
								/>
								<span className="text-foreground min-w-0 flex-1 text-sm">
									<span className="bg-secondary mr-2 rounded-sm px-1.5 py-0.5 text-xs font-semibold">
										{OP_BADGE[op.op]}
									</span>
									<span className="text-muted-foreground mr-2 text-xs">
										{op.startSec.toFixed(1)}–{op.endSec.toFixed(1)}s
									</span>
									{op.reason}
								</span>
							</label>
						))}
					</div>
				)}
				<div className="flex justify-end gap-2 pt-2">
					<Button variant="ghost" size="sm" onClick={close}>
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
