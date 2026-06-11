"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
	TooltipProvider,
} from "@/components/ui/tooltip";
import { useEditor } from "@/editor/use-editor";
import {
	runHyperframes,
	type RunProgress,
} from "@/features/ai-generate/run-hyperframes";
import { HugeiconsIcon } from "@hugeicons/react";
import { MagicWand05Icon } from "@hugeicons/core-free-icons";
import { cn } from "@/utils/ui";

export function RunHyperframesButton() {
	const editor = useEditor();
	const [progress, setProgress] = useState<RunProgress | null>(null);
	const isRunning =
		progress !== null && progress.stage !== "done" && progress.stage !== "error";

	const handleRun = async () => {
		if (isRunning) return;
		try {
			const result = await runHyperframes({
				editor,
				onProgress: setProgress,
			});
			if (result.placed > 0) {
				toast.success(
					`HyperFrames placed ${result.placed} effect${result.placed === 1 ? "" : "s"} on the timeline`,
					result.skipped.length
						? {
								description: `${result.skipped.length} skipped: ${result.skipped[0]}`,
								duration: 10000,
							}
						: undefined,
				);
			} else {
				toast.error("HyperFrames could not place any effects", {
					description: result.skipped[0] ?? "Unknown reason — see console.",
					duration: 10000,
				});
			}
			if (result.skipped.length) {
				console.warn("HyperFrames skipped effects:", result.skipped);
			}
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			toast.error("HyperFrames run failed", { description: message });
			setProgress({ stage: "error", detail: message });
		} finally {
			setTimeout(() => setProgress(null), 1500);
		}
	};

	const renderProgressFraction = () => {
		if (!progress) return 0;
		switch (progress.stage) {
			case "extracting":
				return 0.05;
			case "loading-model":
				return 0.05 + 0.15 * (progress.progress ?? 0);
			case "transcribing":
				return 0.3;
			case "planning":
				return 0.45;
			case "rendering": {
				const i = progress.effectIndex ?? 1;
				const n = Math.max(progress.effectCount ?? 1, 1);
				return 0.5 + 0.5 * ((i - 1) / n);
			}
			case "placing": {
				const i = progress.effectIndex ?? 1;
				const n = Math.max(progress.effectCount ?? 1, 1);
				return 0.5 + 0.5 * ((i - 0.5) / n);
			}
			case "done":
				return 1;
			default:
				return 0;
		}
	};

	const stageLabel = (() => {
		if (!progress) return null;
		switch (progress.stage) {
			case "extracting":
				return "Reading audio";
			case "loading-model":
				return "Loading speech model";
			case "transcribing":
				return "Transcribing";
			case "planning":
				return "Claude is planning";
			case "rendering":
				return `Rendering ${progress.effectIndex ?? 1}/${progress.effectCount ?? 1}`;
			case "placing":
				return `Placing ${progress.effectIndex ?? 1}/${progress.effectCount ?? 1}`;
			default:
				return null;
		}
	})();
	const percent = Math.round(renderProgressFraction() * 100);

	return (
		<TooltipProvider delayDuration={300}>
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						variant="default"
						size="sm"
						disabled={isRunning}
						onClick={handleRun}
						className={cn(
							"relative gap-1.5 overflow-hidden rounded-sm font-semibold",
							isRunning && "opacity-90",
						)}
					>
						{isRunning && (
							<span
								className="absolute inset-y-0 left-0 bg-foreground/15 transition-[width] duration-300"
								style={{ width: `${percent}%` }}
							/>
						)}
						<HugeiconsIcon icon={MagicWand05Icon} size={14} />
						{isRunning && stageLabel
							? `${stageLabel}... ${percent}%`
							: "RUN HYPERFRAMES"}
					</Button>
				</TooltipTrigger>
				<TooltipContent className="max-w-72">
					{isRunning && progress ? (
						<div className="flex w-56 flex-col gap-1.5">
							<span className="text-xs">{progress.detail}</span>
							<Progress value={renderProgressFraction() * 100} />
						</div>
					) : (
						"Transcribe the timeline and let Claude add HyperFrames motion graphics"
					)}
				</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	);
}
