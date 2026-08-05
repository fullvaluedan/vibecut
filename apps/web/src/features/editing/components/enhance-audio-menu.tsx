"use client";

import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { HugeiconsIcon } from "@hugeicons/react";
import { AudioWave01Icon } from "@hugeicons/core-free-icons";
import { useEditor } from "@/editor/use-editor";
import {
	CLEARVOICE_ENHANCE_OPTIONS,
	CLEARVOICE_ENHANCE_TASK_ORDER,
	resolveEnhanceTargetFromSelection,
	startEnhanceSelectedAudio,
	type ClearvoiceEnhanceTask,
} from "../clearvoice-enhance";
import { useEnhanceJobStore } from "../enhance-job-store";

/**
 * Toolbar button next to AI CUT: "Enhance audio". While a job runs (started
 * here or from the Audio tab) the button shows the running state and progress
 * lives inline in the Audio panel - no modal, no blocking.
 */
export function EnhanceAudioMenu() {
	const editor = useEditor();
	const jobActive = useEnhanceJobStore((s) => s.active);
	const label = useEnhanceJobStore((s) => s.label);
	const doneChunks = useEnhanceJobStore((s) => s.doneChunks);
	const totalChunks = useEnhanceJobStore((s) => s.totalChunks);

	const canEnhance =
		!("error" in resolveEnhanceTargetFromSelection({ editor }));

	const run = (task: ClearvoiceEnhanceTask) => {
		void startEnhanceSelectedAudio({ editor, task }).catch((error: unknown) => {
			toast.error(`${CLEARVOICE_ENHANCE_OPTIONS[task].label} failed`, {
				description: error instanceof Error ? error.message : String(error),
			});
		});
	};

	const percent =
		totalChunks > 0
			? Math.min(100, Math.round((doneChunks / totalChunks) * 100))
			: 0;

	const button = (
		<Button
			variant="outline"
			size="sm"
			className="gap-1.5 rounded-sm font-semibold"
			disabled={jobActive || !canEnhance}
			aria-label="Enhance audio of the selected clip"
		>
			<HugeiconsIcon icon={AudioWave01Icon} size={14} />
			{jobActive
				? `${label}${percent > 0 ? ` ${percent}%` : ""}`
				: "Enhance audio"}
		</Button>
	);

	return (
		<DropdownMenu>
			{canEnhance && !jobActive ? (
				<DropdownMenuTrigger asChild>{button}</DropdownMenuTrigger>
			) : (
				<Tooltip>
					<TooltipTrigger asChild>{button}</TooltipTrigger>
					<TooltipContent side="bottom">
						{jobActive
							? "An enhancement is running - watch its progress in the Audio panel."
							: "Select an audio or video clip first to enhance its audio."}
					</TooltipContent>
				</Tooltip>
			)}
			<DropdownMenuContent align="end">
				{CLEARVOICE_ENHANCE_TASK_ORDER.map((task) => (
					<DropdownMenuItem
						key={task}
						disabled={jobActive}
						onClick={() => run(task)}
					>
						{CLEARVOICE_ENHANCE_OPTIONS[task].label}
						<span className="text-muted-foreground ml-2 text-xs">
							{CLEARVOICE_ENHANCE_OPTIONS[task].description}
						</span>
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
