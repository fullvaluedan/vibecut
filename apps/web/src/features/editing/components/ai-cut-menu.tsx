"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { NumberField } from "@/components/ui/number-field";
import { Spinner } from "@/components/ui/spinner";
import { useEditor } from "@/editor/use-editor";
import {
	runAutoAssembleAction,
	runDirectorAction,
	runHighlightAction,
	runRemoveSilencesAction,
} from "@/features/ai-generate/director/ai-cut-actions";
import { useAiActivityStore } from "@/features/ai-generate/ai-activity-store";
import {
	HIDE_AUTO_ASSEMBLE_ACTION,
	HIDE_HIGHLIGHT_ACTION,
} from "@/features/editing/surface-flags";
import { HugeiconsIcon } from "@hugeicons/react";
import { ScissorIcon } from "@hugeicons/core-free-icons";

/**
 * The AI CUT toolbar dropdown. Shows exactly two entries (roadmap D2): "AI CUT"
 * (the Director run) and "Remove silences". Auto-assemble and Highlight are
 * hidden behind `surface-flags.ts`, not deleted - their menu items and the
 * Highlight dialog stay in this file, just unreachable while the flags are on.
 * All four actions' run orchestration (progress toasts, abort wiring, the
 * transcriber-pause flag) lives in `ai-cut-actions.ts` and writes into
 * `ai-activity-store` (R1/KTD1); this component just renders the shared
 * label/stage/cancel, so it and the persistent Director dock's Running view
 * can never drift out of sync.
 */
export function AiCutMenu() {
	const editor = useEditor();
	const label = useAiActivityStore((s) => s.label);
	const stage = useAiActivityStore((s) => s.stage);
	const [highlightOpen, setHighlightOpen] = useState(false);
	const [budgetText, setBudgetText] = useState("");

	const buildHighlight = () => {
		const n = Number(budgetText);
		const budgetSec = budgetText.trim() && Number.isFinite(n) && n > 0 ? n : undefined;
		setHighlightOpen(false);
		void runHighlightAction({ editor, budgetSec });
	};

	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						variant="default"
						size="sm"
						className="gap-1.5 rounded-sm font-semibold data-[state=open]:bg-neutral-600 data-[state=open]:text-white"
						disabled={!!label}
					>
						{label ? (
							<>
								<Spinner className="size-3.5" /> {stage ?? `${label}...`}
							</>
						) : (
							<>
								<HugeiconsIcon icon={ScissorIcon} size={14} /> AI CUT
							</>
						)}
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					{!HIDE_AUTO_ASSEMBLE_ACTION && (
						<DropdownMenuItem onClick={() => void runAutoAssembleAction({ editor })}>
							Auto-assemble: build a cut from all my clips
						</DropdownMenuItem>
					)}
					<DropdownMenuItem onClick={() => void runDirectorAction({ editor })}>
						AI CUT: review and cut the whole video
					</DropdownMenuItem>
					{!HIDE_HIGHLIGHT_ACTION && (
						<DropdownMenuItem onClick={() => setHighlightOpen(true)}>
							Highlight: keep the best parts
						</DropdownMenuItem>
					)}
					<DropdownMenuItem onClick={() => void runRemoveSilencesAction({ editor })}>
						Remove silences
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			<Dialog open={highlightOpen} onOpenChange={setHighlightOpen}>
				<DialogContent className="max-w-sm p-6">
					<DialogTitle>Highlight</DialogTitle>
					<DialogDescription>
						Keep the best parts and cut the rest. Optionally fit a target length — then
						review what it kept before applying.
					</DialogDescription>
					<div className="space-y-1.5 pt-2">
						<label className="text-sm font-medium" htmlFor="highlight-budget">
							Target length (seconds) — optional
						</label>
						<NumberField
							id="highlight-budget"
							allowExpressions={false}
							min={1}
							value={budgetText}
							onChange={(e) => setBudgetText(e.target.value)}
							placeholder="e.g. 60 — blank keeps all the good parts"
						/>
					</div>
					<div className="flex justify-end gap-2 pt-3">
						<Button variant="ghost" size="sm" onClick={() => setHighlightOpen(false)}>
							Cancel
						</Button>
						<Button size="sm" onClick={buildHighlight} disabled={!!label}>
							Build highlight
						</Button>
					</div>
				</DialogContent>
			</Dialog>
			{label && (
				<Button
					variant="destructive"
					size="sm"
					className="ml-1 rounded-sm px-2"
					title="Stop this AI CUT run"
					onClick={() => useAiActivityStore.getState().cancel?.()}
				>
					Stop
				</Button>
			)}
		</>
	);
}
