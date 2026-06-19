"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { useEditor } from "@/editor/use-editor";
import { runRemoveSilences } from "@/features/editing/remove-silences";
import { runDirector } from "@/features/ai-generate/director/run-director";
import { runHighlight } from "@/features/ai-generate/director/run-highlight";
import { DirectorReviewDialog } from "@/features/ai-generate/director/components/director-review-dialog";
import { usePreferenceStore } from "@/features/ai-generate/preference-store";
import { useAiActivityStore } from "@/features/ai-generate/ai-activity-store";
import { HugeiconsIcon } from "@hugeicons/react";
import { ScissorIcon } from "@hugeicons/core-free-icons";

const fmtSec = (sec: number) => `${sec.toFixed(1)}s`;

export function AiCutMenu() {
	const editor = useEditor();
	const [busy, setBusy] = useState<string | null>(null);
	const [stage, setStage] = useState<string | null>(null);
	const [highlightOpen, setHighlightOpen] = useState(false);
	const [budgetText, setBudgetText] = useState("");
	const abortRef = useRef<AbortController | null>(null);

	const run = async ({
		label,
		fn,
	}: {
		label: string;
		fn: (helpers: {
			onProgress: (detail: string) => void;
			signal: AbortSignal;
		}) => Promise<{ cuts: number; removedSec: number }>;
	}) => {
		if (busy) return;
		const controller = new AbortController();
		abortRef.current = controller;
		setBusy(label);
		// Pause the background transcriber while AI CUT works the machine.
		useAiActivityStore.getState().setBusy(true);
		setStage("Starting...");
		// Remember the last stage so a failure can say WHERE it died.
		const lastStage = { current: "starting" };
		const toastId = toast.loading(`${label}...`);
		try {
			const { cuts, removedSec } = await fn({
				onProgress: (detail) => {
					lastStage.current = detail;
					setStage(detail);
				},
				signal: controller.signal,
			});
			// Self-learning: a quick Ctrl+Z counts against this run, and the
			// post-cut duration is the baseline the export diff compares to.
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
			abortRef.current = null;
			setBusy(null);
			useAiActivityStore.getState().setBusy(false);
			setStage(null);
		}
	};

	// The Director plans then opens the Review modal — the modal owns apply + the
	// result toast, so this flow has no success toast of its own.
	const runDirectorFlow = async () => {
		if (busy) return;
		const controller = new AbortController();
		abortRef.current = controller;
		setBusy("AI Director");
		useAiActivityStore.getState().setBusy(true);
		setStage("Starting...");
		const lastStage = { current: "starting" };
		const toastId = toast.loading("AI Director...");
		try {
			await runDirector({
				editor,
				onProgress: (detail) => {
					lastStage.current = detail;
					setStage(detail);
				},
				signal: controller.signal,
			});
			toast.dismiss(toastId);
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			if (message === "Cancelled" || controller.signal.aborted) {
				toast.info("AI Director stopped", { id: toastId });
			} else {
				console.error(`AI Director failed during "${lastStage.current}"`, e);
				toast.error("AI Director failed", {
					id: toastId,
					duration: 15000,
					description: `While "${lastStage.current}": ${message}`,
				});
			}
		} finally {
			abortRef.current = null;
			setBusy(null);
			useAiActivityStore.getState().setBusy(false);
			setStage(null);
		}
	};

	// Highlight (keep-only): the inverse of the Director — keep the best parts, cut
	// the rest. Opens the same Review modal in highlight mode (it owns apply).
	const runHighlightFlow = async (budgetSec?: number) => {
		if (busy) return;
		setHighlightOpen(false);
		const controller = new AbortController();
		abortRef.current = controller;
		setBusy("Highlight");
		useAiActivityStore.getState().setBusy(true);
		setStage("Starting...");
		const lastStage = { current: "starting" };
		const toastId = toast.loading("Highlight...");
		try {
			await runHighlight({
				editor,
				budgetSec,
				onProgress: (detail) => {
					lastStage.current = detail;
					setStage(detail);
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
			abortRef.current = null;
			setBusy(null);
			useAiActivityStore.getState().setBusy(false);
			setStage(null);
		}
	};

	const buildHighlight = () => {
		const n = Number(budgetText);
		const budgetSec = budgetText.trim() && Number.isFinite(n) && n > 0 ? n : undefined;
		void runHighlightFlow(budgetSec);
	};

	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						variant="default"
						size="sm"
						className="gap-1.5 rounded-sm font-semibold data-[state=open]:bg-neutral-600 data-[state=open]:text-white"
						disabled={!!busy}
					>
						{busy ? (
							<>
								<Spinner className="size-3.5" /> {stage ?? `${busy}...`}
							</>
						) : (
							<>
								<HugeiconsIcon icon={ScissorIcon} size={14} /> AI CUT
							</>
						)}
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					<DropdownMenuItem onClick={() => void runDirectorFlow()}>
						AI Director — review &amp; cut the whole video
					</DropdownMenuItem>
					<DropdownMenuItem onClick={() => setHighlightOpen(true)}>
						Highlight — keep the best parts
					</DropdownMenuItem>
					<DropdownMenuItem
						onClick={() =>
							void run({
								label: "Remove silences",
								fn: () => runRemoveSilences({ editor }),
							})
						}
					>
						Remove silences
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			<Dialog open={highlightOpen} onOpenChange={setHighlightOpen}>
				<DialogContent className="max-w-sm p-6">
					<DialogTitle>Highlight</DialogTitle>
					<DialogDescription>
						Keep the best parts and cut the rest. Optionally fit a target length — then
						review what it kept before applying.
					</DialogDescription>
					<div className="space-y-1.5 pt-2">
						<label className="text-sm font-medium" htmlFor="highlight-budget">
							Target length (seconds) — optional
						</label>
						<input
							id="highlight-budget"
							type="number"
							min="1"
							value={budgetText}
							onChange={(e) => setBudgetText(e.target.value)}
							placeholder="e.g. 60 — blank keeps all the good parts"
							className="border-input w-full rounded-sm border bg-transparent px-2 py-1 text-sm"
						/>
					</div>
					<div className="flex justify-end gap-2 pt-3">
						<Button variant="ghost" size="sm" onClick={() => setHighlightOpen(false)}>
							Cancel
						</Button>
						<Button size="sm" onClick={buildHighlight} disabled={!!busy}>
							Build highlight
						</Button>
					</div>
				</DialogContent>
			</Dialog>
			{busy && (
				<Button
					variant="destructive"
					size="sm"
					className="ml-1 rounded-sm px-2"
					title="Stop this AI CUT run"
					onClick={() => abortRef.current?.abort()}
				>
					Stop
				</Button>
			)}
			<DirectorReviewDialog />
		</>
	);
}
