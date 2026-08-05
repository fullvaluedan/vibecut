"use client";

import { useCallback, useState } from "react";
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
import { EnhanceAudioDialog } from "./enhance-audio-dialog";

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
	const [activeTask, setActiveTask] = useState<ClearvoiceEnhanceTask | null>(
		null,
	);
	const [runNonce, setRunNonce] = useState(0);

	const openTask = (task: ClearvoiceEnhanceTask) => {
		setActiveTask(task);
		setRunNonce((n) => n + 1);
	};

	const start = useCallback(
		async (args: { signal: AbortSignal; onProgress: (progress: { doneChunks: number; totalChunks: number }) => void }) =>
			enhanceClipQuality({
				editor,
				trackId,
				element,
				task: activeTask ?? "denoise",
				onProgress: args.onProgress,
				signal: args.signal,
			}),
		[editor, trackId, element, activeTask],
	);
	const close = useCallback(() => setActiveTask(null), []);

	return (
		<>
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
							onClick={() => openTask(task)}
							title={CLEARVOICE_ENHANCE_OPTIONS[task].description}
						>
							{CLEARVOICE_ENHANCE_OPTIONS[task].label}
						</Button>
					))}
					<p className="text-muted-foreground text-[0.65rem]">
						Processed locally through ClearVoice (ClearerVoice-Studio).
						Models download on first use; the result replaces this clip&apos;s
						audio in one undo step.
					</p>
				</SectionContent>
			</Section>
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
