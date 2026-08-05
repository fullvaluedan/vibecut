"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import {
	CLEARVOICE_ENHANCE_OPTIONS,
	type ClearvoiceEnhanceTask,
	type EnhanceProgressListener,
} from "../clearvoice-enhance";

export interface EnhanceAudioStartArgs {
	signal: AbortSignal;
	onProgress: EnhanceProgressListener;
}

/**
 * Enhancement-job dialog: live per-chunk progress + a Cancel button. The
 * parent REMOUNTS this dialog per run (key), so state starts fresh every time
 * and the effect runs exactly once for the job's lifetime.
 */
export function EnhanceAudioDialog({
	task,
	start,
	onClose,
}: {
	task: ClearvoiceEnhanceTask;
	start: (args: EnhanceAudioStartArgs) => Promise<{
		assetName: string;
		mode: "replaced" | "inserted";
	}>;
	onClose: () => void;
}) {
	const [doneChunks, setDoneChunks] = useState(0);
	const [totalChunks, setTotalChunks] = useState(0);
	const controllerRef = useRef<AbortController | null>(null);
	// React 18/19 dev-mode StrictMode double-invokes effects; the guard keeps
	// exactly ONE job per dialog mount. The job is NOT aborted on unmount:
	// closing the dialog (Escape) lets it finish in the background, and only
	// the Cancel button stops it.
	const startedRef = useRef(false);

	useEffect(() => {
		if (startedRef.current) return;
		startedRef.current = true;
		const controller = new AbortController();
		controllerRef.current = controller;
		const toastId = toast.loading(
			`${CLEARVOICE_ENHANCE_OPTIONS[task].label}...`,
		);

		start({
			signal: controller.signal,
			onProgress: (progress) => {
				setDoneChunks(progress.doneChunks);
				setTotalChunks(progress.totalChunks);
			},
		})
			.then(({ assetName }) => {
				toast.success("Enhanced audio ready", {
					id: toastId,
					description: `${assetName} is now this clip's audio. Ctrl+Z restores the original.`,
				});
				onClose();
			})
			.catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				if (message === "Cancelled") {
					toast.info("Enhancement cancelled", {
						id: toastId,
						description: "The clip's audio was left unchanged.",
					});
				} else {
					toast.error(`${CLEARVOICE_ENHANCE_OPTIONS[task].label} failed`, {
						id: toastId,
						description: message,
					});
				}
				onClose();
			});
		// The parent remounts this dialog per run (key), so task/start/onClose
		// are stable for the job's lifetime; re-running the effect on a parent
		// re-render would restart the job.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [task]);

	const cancel = () => controllerRef.current?.abort();
	const percent =
		totalChunks > 0
			? Math.min(100, Math.round((doneChunks / totalChunks) * 100))
			: 0;

	return (
		<Dialog open>
			<DialogContent className="max-w-sm p-6">
				<DialogTitle>Enhance audio (AI)</DialogTitle>
				<DialogDescription>
					{CLEARVOICE_ENHANCE_OPTIONS[task].label} is running. You can keep
					editing - the result replaces this clip&apos;s audio when it finishes.
				</DialogDescription>
				<div className="space-y-2 pt-2">
					<Progress value={percent} />
					<p className="text-muted-foreground text-xs">
						{totalChunks > 0
							? `Processing ${doneChunks} of ${totalChunks} segments (${percent}%)`
							: "Starting up..."}
					</p>
				</div>
				<div className="flex justify-end pt-3">
					<Button variant="destructive" size="sm" onClick={cancel}>
						Cancel
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
