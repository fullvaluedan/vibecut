"use client";

/**
 * The Director dock's state router (R1/U1): the single entry point the dock shell
 * mounts for its "director" tab. Idle shows the four AI CUT actions inline; a
 * running action shows its live stage text + Stop; a resolved run shows whichever
 * review body applies (cut, auto-assemble, or highlight, including the applied /
 * applied-locked phases, which those panels render themselves). Busy always wins
 * over a stale prior session: a NEW run in flight must show the Running view even
 * if a previous plan/draft/keeps are still sitting in the store waiting to be
 * replaced by this run's completion.
 */

import { HugeiconsIcon } from "@hugeicons/react";
import { ScissorIcon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useEditor } from "@/editor/use-editor";
import { useAiActivityStore } from "@/features/ai-generate/ai-activity-store";
import {
	runAutoAssembleAction,
	runDirectorAction,
	runHighlightAction,
	runRemoveSilencesAction,
} from "../ai-cut-actions";
import { useDirectorPlanStore, type DirectorRunError } from "../director-plan-store";
import { DirectorPanel } from "./director-panel";
import { DirectorCutPanel } from "./director-cut-panel";
import { DirectorHighlightPanel } from "./director-highlight-panel";

function RunningView({ label, stage }: { label: string; stage: string | null }) {
	return (
		<div className="panel bg-background flex h-full flex-col items-center justify-center gap-3 overflow-hidden rounded-sm border p-6 text-center">
			<Spinner className="size-5" />
			<p className="text-foreground text-sm font-medium">{label}</p>
			<p className="text-muted-foreground text-xs">{stage ?? "Working..."}</p>
			<Button
				variant="destructive"
				size="sm"
				onClick={() => useAiActivityStore.getState().cancel?.()}
			>
				Stop
			</Button>
		</div>
	);
}

/**
 * Persistent error card (round 12 U3/R4): a failed Director run used to show
 * only a 15-second toast, then the dock reverted to idle - a user who looked
 * away saw nothing, ever. The failure now stays on screen until the user
 * retries, dismisses it, or starts any new run. The message is the run's own
 * plain-language error (never a stack trace); Retry re-runs the AI Director.
 */
function RunErrorView({ runError }: { runError: DirectorRunError }) {
	const editor = useEditor();
	return (
		<div className="panel bg-background flex h-full flex-col items-center justify-center gap-3 overflow-hidden rounded-sm border p-6 text-center">
			<p className="text-destructive text-sm font-medium">AI Director hit a problem</p>
			<p className="text-muted-foreground text-xs">
				Stopped during "{runError.stage}" at{" "}
				{new Date(runError.at).toLocaleTimeString()}
			</p>
			<p className="text-foreground text-xs">{runError.message}</p>
			<div className="flex items-center gap-2">
				<Button size="sm" onClick={() => void runDirectorAction({ editor })}>
					Retry
				</Button>
				<Button
					variant="outline"
					size="sm"
					onClick={() => useDirectorPlanStore.getState().clearRunError()}
				>
					Dismiss
				</Button>
			</div>
		</div>
	);
}

/**
 * Idle state: the four AI CUT actions inline (R1). Reuses the exact handlers the
 * toolbar's AiCutMenu dropdown calls, so behavior (toasts, abort, taste seeding)
 * never drifts between the two surfaces. Highlight runs with no target-length
 * budget from here (the toolbar dropdown still offers that prompt): the docked
 * fast path is "keep all the good parts".
 */
function IdleActions() {
	const editor = useEditor();
	return (
		<div className="panel bg-background flex h-full flex-col gap-2 overflow-hidden rounded-sm border p-3">
			<div className="flex items-center gap-2 pb-1">
				<HugeiconsIcon icon={ScissorIcon} size={16} />
				<h2 className="text-sm font-semibold">AI CUT</h2>
			</div>
			<p className="text-muted-foreground text-xs pb-1">
				Let AI cut your footage, then review before anything lands.
			</p>
			<Button
				variant="outline"
				size="sm"
				className="justify-start"
				onClick={() => void runAutoAssembleAction({ editor })}
			>
				Auto-assemble: build a cut from all my clips
			</Button>
			<Button
				variant="outline"
				size="sm"
				className="justify-start"
				onClick={() => void runDirectorAction({ editor })}
			>
				AI Director: review &amp; cut the whole video
			</Button>
			<Button
				variant="outline"
				size="sm"
				className="justify-start"
				onClick={() => void runHighlightAction({ editor })}
			>
				Highlight: keep the best parts
			</Button>
			<Button
				variant="outline"
				size="sm"
				className="justify-start"
				onClick={() => void runRemoveSilencesAction({ editor })}
			>
				Remove silences
			</Button>
		</div>
	);
}

export function DirectorDock() {
	const label = useAiActivityStore((s) => s.label);
	const stage = useAiActivityStore((s) => s.stage);
	const mode = useDirectorPlanStore((s) => s.mode);
	const plan = useDirectorPlanStore((s) => s.plan);
	const draft = useDirectorPlanStore((s) => s.draft);
	const keeps = useDirectorPlanStore((s) => s.keeps);
	const runError = useDirectorPlanStore((s) => s.runError);

	if (label) return <RunningView label={label} stage={stage} />;
	// A failed run outranks any stale prior review (round 12 U3/R4): the user must
	// see the failure, not last session's plan. Dismiss returns to whatever is under it.
	if (runError) return <RunErrorView runError={runError} />;
	if (mode === "assemble" && draft) return <DirectorPanel />;
	if (mode === "cut" && plan) return <DirectorCutPanel />;
	if (mode === "highlight" && keeps.length > 0) return <DirectorHighlightPanel />;
	return <IdleActions />;
}
