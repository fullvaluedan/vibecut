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
import {
	runFullCleanup,
	runRemoveRepeats,
	runYouTubeCut,
} from "@/features/editing/remove-repeats";
import { runAutocut } from "@/features/editing/autocut";
import { usePreferenceStore } from "@/features/ai-generate/preference-store";
import { HugeiconsIcon } from "@hugeicons/react";
import { ScissorIcon } from "@hugeicons/core-free-icons";

const fmtSec = (sec: number) => `${sec.toFixed(1)}s`;

export function AiCutMenu() {
	const editor = useEditor();
	const [busy, setBusy] = useState<string | null>(null);
	const [stage, setStage] = useState<string | null>(null);
	const abortRef = useRef<AbortController | null>(null);

	const run = async (
		label: string,
		fn: (helpers: {
			onProgress: (detail: string) => void;
			signal: AbortSignal;
		}) => Promise<{ cuts: number; removedSec: number }>,
	) => {
		if (busy) return;
		const controller = new AbortController();
		abortRef.current = controller;
		setBusy(label);
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
					<DropdownMenuItem
						onClick={() =>
							void run("AI Cut", ({ onProgress, signal }) =>
								runYouTubeCut({ editor, onProgress, signal }),
							)
						}
					>
						AI Cut — assemble + edit like a YouTube video
					</DropdownMenuItem>
					<DropdownMenuItem
						onClick={() =>
							void run("Remove silences", () => runRemoveSilences({ editor }))
						}
					>
						Remove silences
					</DropdownMenuItem>
					<DropdownMenuItem
						onClick={() =>
							void run("Remove repeats", ({ onProgress, signal }) =>
								runRemoveRepeats({ editor, onProgress, signal }),
							)
						}
					>
						Remove repeats (retakes)
					</DropdownMenuItem>
					<DropdownMenuItem
						onClick={() =>
							void run("Full cleanup", ({ onProgress, signal }) =>
								runFullCleanup({ editor, onProgress, signal }),
							)
						}
					>
						Full cleanup (silences + stutters + repeats + tangents)
					</DropdownMenuItem>
					<DropdownMenuItem
						onClick={() =>
							void run("Autocut", async () => {
								const r = await runAutocut({ editor });
								return { cuts: r.cuts, removedSec: r.removedSec };
							})
						}
					>
						Autocut (assemble + clean)
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
		</>
	);
}
