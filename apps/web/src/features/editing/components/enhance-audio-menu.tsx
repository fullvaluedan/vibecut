"use client";

import { useState } from "react";
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
	enhanceSelectedAudio,
	resolveEnhanceTargetFromSelection,
	type ClearvoiceEnhanceTask,
} from "../clearvoice-enhance";

/**
 * Toolbar button next to AI CUT: "Enhance audio". Disabled until exactly one
 * audio-bearing clip is selected (a linked video + separated-audio pair counts
 * as one). Same shared flow as the Audio tab section.
 */
export function EnhanceAudioMenu() {
	const editor = useEditor();
	const [busy, setBusy] = useState<ClearvoiceEnhanceTask | null>(null);

	const canEnhance =
		!("error" in resolveEnhanceTargetFromSelection({ editor }));

	const run = async (task: ClearvoiceEnhanceTask) => {
		if (busy) return;
		setBusy(task);
		const toastId = toast.loading(
			`${CLEARVOICE_ENHANCE_OPTIONS[task].label}...`,
		);
		try {
			const { assetName } = await enhanceSelectedAudio({ editor, task });
			toast.success("Enhanced audio ready", {
				id: toastId,
				description: `${assetName} is now the selected clip's audio. Ctrl+Z restores the original.`,
			});
		} catch (e) {
			toast.error(`${CLEARVOICE_ENHANCE_OPTIONS[task].label} failed`, {
				id: toastId,
				description: e instanceof Error ? e.message : String(e),
			});
		} finally {
			setBusy(null);
		}
	};

	const disabled = busy !== null || !canEnhance;

	const button = (
		<Button
			variant="outline"
			size="sm"
			className="gap-1.5 rounded-sm font-semibold"
			disabled={disabled}
			aria-label="Enhance audio of the selected clip"
		>
			<HugeiconsIcon icon={AudioWave01Icon} size={14} />
			{busy ? "Enhancing..." : "Enhance audio"}
		</Button>
	);

	return (
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
					<DropdownMenuItem
						key={task}
						disabled={!!busy}
						onClick={() => void run(task)}
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
