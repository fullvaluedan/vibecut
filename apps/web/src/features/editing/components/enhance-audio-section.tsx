"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
	Section,
	SectionContent,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import { Button } from "@/components/ui/button";
import { useEditor } from "@/editor/use-editor";
import type { AudioElement, VideoElement } from "@/timeline";
import {
	CLEARVOICE_ENHANCE_OPTIONS,
	CLEARVOICE_ENHANCE_TASK_ORDER,
	enhanceClipQuality,
	type ClearvoiceEnhanceTask,
} from "../clearvoice-enhance";

/**
 * The Audio tab's AI quality section: one button per ClearVoice task. Runs the
 * shared `enhanceClipQuality` flow (extract -> service -> replace, one undo).
 */
export function EnhanceAudioSection({
	element,
	trackId,
}: {
	element: AudioElement | VideoElement;
	trackId: string;
}) {
	const editor = useEditor();
	const [busy, setBusy] = useState<ClearvoiceEnhanceTask | null>(null);

	const run = async (task: ClearvoiceEnhanceTask) => {
		if (busy) return;
		setBusy(task);
		const toastId = toast.loading(
			`${CLEARVOICE_ENHANCE_OPTIONS[task].label}...`,
		);
		try {
			const { assetName } = await enhanceClipQuality({
				editor,
				trackId,
				element,
				task,
			});
			toast.success("Enhanced audio ready", {
				id: toastId,
				description: `${assetName} is now this clip's audio. Ctrl+Z restores the original.`,
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

	return (
		<Section>
			<SectionHeader>
				<SectionTitle className="flex-1">Enhance audio (AI)</SectionTitle>
			</SectionHeader>
			<SectionContent className="flex flex-col gap-1.5 px-3 pb-3">
				{CLEARVOICE_ENHANCE_TASK_ORDER.map((task) => (
					<Button
						key={task}
						variant="outline"
						size="sm"
						disabled={!!busy}
						onClick={() => void run(task)}
						title={CLEARVOICE_ENHANCE_OPTIONS[task].description}
					>
						{busy === task
							? "Working..."
							: CLEARVOICE_ENHANCE_OPTIONS[task].label}
					</Button>
				))}
				<p className="text-muted-foreground text-[0.65rem]">
					Processed locally through ClearVoice (ClearerVoice-Studio).
					Models download on first use; the result replaces this clip&apos;s
					audio in one undo step.
				</p>
			</SectionContent>
		</Section>
	);
}
