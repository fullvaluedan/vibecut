"use client";

import { toast } from "sonner";
import {
	Section,
	SectionContent,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useEditor } from "@/editor/use-editor";
import type { AudioElement, VideoElement } from "@/timeline";
import {
	CLEARVOICE_ENHANCE_OPTIONS,
	CLEARVOICE_ENHANCE_TASK_ORDER,
	startEnhanceClipQuality,
	type ClearvoiceEnhanceTask,
} from "../clearvoice-enhance";
import { useEnhanceJobStore } from "../enhance-job-store";

/**
 * The Audio tab's AI quality section. Runs enhancement INLINE (progress bar +
 * Cancel) so the user keeps editing; the job state is app-global, so this
 * section reflects a job started from the toolbar too. No success alert - the
 * finished/cancelled/failed status is a short inline line instead.
 */
export function EnhanceAudioSection({
	element,
	trackId,
}: {
	element: AudioElement | VideoElement;
	trackId: string;
}) {
	const editor = useEditor();
	const jobActive = useEnhanceJobStore((s) => s.active);
	const label = useEnhanceJobStore((s) => s.label);
	const doneChunks = useEnhanceJobStore((s) => s.doneChunks);
	const totalChunks = useEnhanceJobStore((s) => s.totalChunks);
	const outcome = useEnhanceJobStore((s) => s.outcome);
	const message = useEnhanceJobStore((s) => s.message);
	const abort = useEnhanceJobStore((s) => s.abort);

	const run = (task: ClearvoiceEnhanceTask) => {
		void startEnhanceClipQuality({ editor, trackId, element, task }).catch(
			(error: unknown) => {
				toast.error(`${CLEARVOICE_ENHANCE_OPTIONS[task].label} failed`, {
					description: error instanceof Error ? error.message : String(error),
				});
			},
		);
	};

	const percent =
		totalChunks > 0
			? Math.min(100, Math.round((doneChunks / totalChunks) * 100))
			: 0;

	return (
		<Section>
			<SectionHeader>
				<SectionTitle className="flex-1">Enhance audio (AI)</SectionTitle>
			</SectionHeader>
			<SectionContent className="flex flex-col gap-1.5 px-3 pb-3">
				{jobActive ? (
					<div className="flex flex-col gap-1.5">
						<Progress value={percent} />
						<p className="text-muted-foreground text-[0.65rem]">
							{label} -{" "}
							{totalChunks > 0
								? `processing ${doneChunks} of ${totalChunks} segments (${percent}%). You can keep editing.`
								: "starting up..."}
						</p>
						<Button
							variant="destructive"
							size="sm"
							className="self-start"
							onClick={() => abort?.()}
						>
							Cancel
						</Button>
					</div>
				) : (
					<>
						{CLEARVOICE_ENHANCE_TASK_ORDER.map((task) => (
							<Button
								key={task}
								variant="outline"
								size="sm"
								onClick={() => run(task)}
								title={CLEARVOICE_ENHANCE_OPTIONS[task].description}
							>
								{CLEARVOICE_ENHANCE_OPTIONS[task].label}
							</Button>
						))}
						<p className="text-muted-foreground text-[0.65rem]">
							Processed locally through ClearVoice (ClearerVoice-Studio).
							Balance voices evens out quiet and loud speakers. Models
							download on first use.
						</p>
					</>
				)}
				{outcome && !jobActive ? (
					<p
						className={
							outcome === "failed"
								? "text-destructive text-[0.65rem]"
								: "text-muted-foreground text-[0.65rem]"
						}
					>
						{outcome === "done"
							? "Enhanced audio ready - Ctrl+Z restores the original."
							: outcome === "cancelled"
								? "Cancelled - the clip&apos;s audio was left unchanged."
								: (message ?? "Enhancement failed.")}
					</p>
				) : null}
			</SectionContent>
		</Section>
	);
}
