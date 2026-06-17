"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
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
