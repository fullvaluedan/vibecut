"use client";

import { useCallback, useState } from "react";
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
	enhanceSelectedAudio,
	resolveEnhanceTargetFromSelection,
	type ClearvoiceEnhanceTask,
} from "../clearvoice-enhance";
import { EnhanceAudioDialog } from "./enhance-audio-dialog";

/**
 * Toolbar button next to AI CUT: "Enhance audio". Disabled until exactly one
 * audio-bearing clip is selected (a linked video + separated-audio pair counts
 * as one). Same shared flow as the Audio tab section.
 */
export function EnhanceAudioMenu() {
	const editor = useEditor();
	const [activeTask, setActiveTask] = useState<ClearvoiceEnhanceTask | null>(
		null,
	);
	const [runNonce, setRunNonce] = useState(0);

	const canEnhance =
		!("error" in resolveEnhanceTargetFromSelection({ editor }));

	const openTask = (task: ClearvoiceEnhanceTask) => {
		setActiveTask(task);
		setRunNonce((n) => n + 1);
	};

	const start = useCallback(
		async (args: { signal: AbortSignal; onProgress: (progress: { doneChunks: number; totalChunks: number }) => void }) =>
			enhanceSelectedAudio({
				editor,
				task: activeTask ?? "denoise",
				onProgress: args.onProgress,
				signal: args.signal,
			}),
		[editor, activeTask],
	);
	const close = useCallback(() => setActiveTask(null), []);

	const button = (
		<Button
			variant="outline"
			size="sm"
			className="gap-1.5 rounded-sm font-semibold"
			disabled={!canEnhance}
			aria-label="Enhance audio of the selected clip"
		>
			<HugeiconsIcon icon={AudioWave01Icon} size={14} />
			Enhance audio
		</Button>
	);

	return (
		<>
			<DropdownMenu>
				{canEnhance ? (
					<DropdownMenuTrigger asChild>{button}</DropdownMenuTrigger>
				) : (
					<Tooltip>
						<TooltipTrigger asChild>{button}</TooltipTrigger>
						<TooltipContent side="bottom">
							Select an audio or video clip first to enhance its audio.
						</TooltipContent>
					</Tooltip>
				)}
				<DropdownMenuContent align="end">
					{CLEARVOICE_ENHANCE_TASK_ORDER.map((task) => (
						<DropdownMenuItem key={task} onClick={() => openTask(task)}>
							{CLEARVOICE_ENHANCE_OPTIONS[task].label}
							<span className="text-muted-foreground ml-2 text-xs">
								{CLEARVOICE_ENHANCE_OPTIONS[task].description}
							</span>
						</DropdownMenuItem>
					))}
				</DropdownMenuContent>
			</DropdownMenu>
			{activeTask ? (
				<EnhanceAudioDialog
					key={runNonce}
					task={activeTask}
					start={start}
					onClose={close}
				/>
			) : null}
		</>
	);
}
