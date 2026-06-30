"use client";

import { useRef, useState } from "react";
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
import { useRunLogStore, logRun } from "@/features/ai-generate/run-log-store";
import { RunLogPanel } from "@/features/ai-generate/components/run-log-panel";
import {
	runHyperframesWholeTimeline,
	runHyperframesVariants,
} from "@/features/ai-generate/run-hyperframes-scoped";
import { useAiSettingsStore } from "@/features/ai-generate/store";
import { describeTemplateCatalog } from "@framecut/hf-bridge/templates";
import { resolveHfRunEngine } from "@/features/ai-generate/run-engine";
import { useAiActivityStore } from "@/features/ai-generate/ai-activity-store";
import {
	VariantPickerDialog,
	useVariantPickerStore,
} from "@/features/ai-generate/components/variant-picker-dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TICKS_PER_SECOND } from "@/wasm";
import type { EditorCore } from "@/core";

/**
 * Bounding [startSec, endSec] of the selected video clips, or null when nothing
 * runnable is selected — drives "Run Selected Video ONLY".
 */
function selectedVideoRange(
	editor: EditorCore,
): { startSec: number; endSec: number } | null {
	const refs = editor.selection.getSelectedElements();
	if (!refs.length) return null;
	const ids = new Set(refs.map((r) => r.elementId));
	const scene = editor.scenes.getActiveScene();
	let lo = Number.POSITIVE_INFINITY;
	let hi = Number.NEGATIVE_INFINITY;
	for (const track of [scene.tracks.main, ...scene.tracks.overlay]) {
		for (const el of track.elements) {
			if (el.type === "video" && ids.has(el.id)) {
				lo = Math.min(lo, el.startTime);
				hi = Math.max(hi, el.startTime + el.duration);
			}
		}
	}
	if (!Number.isFinite(lo) || hi <= lo) return null;
	return { startSec: lo / TICKS_PER_SECOND, endSec: hi / TICKS_PER_SECOND };
}

export function RunHyperframesButton() {
	const editor = useEditor();
	const [progress, setProgress] = useState<RunProgress | null>(null);
	const abortRef = useRef<AbortController | null>(null);
	const engine = useAiSettingsStore((s) => s.hfEngine);
	// Drafts persist after the picker closes — surface a re-open affordance so a
	// closed picker (and the tokens/render time it cost) is recoverable.
	const draftCount = useVariantPickerStore((s) => s.versions?.length ?? 0);
	const showPicker = useVariantPickerStore((s) => s.show);
	const isRunning =
		progress !== null &&
		progress.stage !== "done" &&
		progress.stage !== "error";

	const handleRun = async (range?: { startSec: number; endSec: number }) => {
		if (isRunning) return;
		const controller = new AbortController();
		abortRef.current = controller;
		useAiActivityStore.getState().setBusy(true);
		useRunLogStore.getState().setOpen(true);
		logRun(
			range ? "▶ RUN HYPERFRAMES — selected section" : "▶ RUN HYPERFRAMES started",
		);
		try {
			const onProgress = (p: RunProgress) => {
				setProgress(p);
				const pct =
					p.progress != null ? ` (${Math.round(p.progress * 100)}%)` : "";
				logRun(`${p.stage}: ${p.detail}${pct}`);
			};
			let result: { placed: number; skipped: string[]; tokensUsed: number };
			if (range) {
				// "Run Selected Video ONLY" — always the authored (skill) path; it
				// supports a sub-range, the native template engine does not.
				result = await runHyperframesWholeTimeline({
					editor,
					onProgress,
					signal: controller.signal,
					range,
				});
			} else {
				const { hfEngine, disabledTemplateIds, hfDirection, promptHfAssets } =
					useAiSettingsStore.getState();
				const allowedTemplateCount = describeTemplateCatalog().filter(
					(t) => !disabledTemplateIds.includes(t.id),
				).length;
				const decision = resolveHfRunEngine({
					engine: hfEngine,
					allowedTemplateCount,
					hasDirection: hfDirection.trim().length > 0,
					pickedAssetCount: promptHfAssets.length,
				});
				if ("error" in decision) {
					throw new Error(decision.error);
				}
				if (decision.fellBackToAuthored) {
					logRun(
						"No template checked: using the Authored engine to render your style/picks (in-browser, slower than native).",
						"warn",
					);
				}
				result =
					decision.engine === "authored"
						? await runHyperframesWholeTimeline({
								editor,
								onProgress,
								signal: controller.signal,
							})
						: await runHyperframes({
								editor,
								onProgress,
								signal: controller.signal,
							});
			}
			logRun(
				result.placed > 0
					? `✓ placed ${result.placed} effect(s)${result.skipped.length ? `, ${result.skipped.length} skipped` : ""}`
					: `✗ ${result.skipped[0] ?? "nothing placed"}`,
				result.placed > 0 ? "info" : "warn",
			);
			if (result.placed > 0) {
				const tokenNote = result.tokensUsed
					? `Used ~${result.tokensUsed.toLocaleString()} Claude tokens.`
					: "";
				toast.success(
					`HyperFrames placed ${result.placed} effect${result.placed === 1 ? "" : "s"} on the timeline`,
					result.skipped.length
						? {
								description:
									`${result.skipped.length} skipped: ${result.skipped[0]} ${tokenNote}`.trim(),
								duration: 10000,
							}
						: tokenNote
							? { description: tokenNote, duration: 8000 }
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
			if (message === "Cancelled" || abortRef.current?.signal.aborted) {
				logRun("■ run stopped by user", "warn");
				toast.info("HyperFrames run stopped", {
					description:
						"Anything already rendered is in your media bin; nothing was placed.",
				});
				setProgress(null);
			} else {
				logRun(`✗ failed: ${message}`, "error");
				toast.error("HyperFrames run failed", { description: message });
				setProgress({ stage: "error", detail: message });
			}
		} finally {
			abortRef.current = null;
			useAiActivityStore.getState().setBusy(false);
			setTimeout(() => setProgress(null), 1500);
		}
	};

	const handleRunSelected = () => {
		if (isRunning) return;
		const range = selectedVideoRange(editor);
		if (!range) {
			toast.info("Select a clip in the timeline first", {
				description:
					'Click a video clip (or a few), then choose "Run Selected Video ONLY".',
			});
			return;
		}
		void handleRun(range);
	};

	const handleRunVersions = async () => {
		if (isRunning) return;
		const controller = new AbortController();
		abortRef.current = controller;
		useAiActivityStore.getState().setBusy(true);
		useRunLogStore.getState().setOpen(true);
		logRun("▶ RUN HYPERFRAMES — generating 3 versions");
		try {
			const onProgress = (p: RunProgress) => {
				setProgress(p);
				logRun(`${p.stage}: ${p.detail}`);
			};
			const { versions } = await runHyperframesVariants({
				editor,
				count: 3,
				onProgress,
				signal: controller.signal,
			});
			useVariantPickerStore.getState().open(versions);
			toast.success(
				`${versions.length} version${versions.length === 1 ? "" : "s"} ready — pick one`,
			);
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			if (message === "Cancelled" || abortRef.current?.signal.aborted) {
				logRun("■ versions run stopped by user", "warn");
				toast.info("HyperFrames versions stopped");
				setProgress(null);
			} else {
				logRun(`✗ failed: ${message}`, "error");
				toast.error("Could not generate versions", { description: message });
				setProgress({ stage: "error", detail: message });
			}
		} finally {
			abortRef.current = null;
			useAiActivityStore.getState().setBusy(false);
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
				return (progress.progress ?? 0) >= 1
					? "Initializing speech model"
					: "Downloading speech model";
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
		<div className="flex items-center gap-1">
			<div className="flex items-center">
			<TooltipProvider delayDuration={300}>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							variant="default"
							size="sm"
							disabled={isRunning}
							onClick={() => handleRun()}
							className={cn(
								"relative gap-1.5 overflow-hidden rounded-l-sm rounded-r-none font-semibold",
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
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						variant="default"
						size="sm"
						disabled={isRunning}
						className="rounded-l-none rounded-r-sm border-l border-background/25 px-1.5"
						title="Run options"
					>
						<span aria-hidden className="text-[10px] leading-none">
							▾
						</span>
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					<DropdownMenuItem onClick={() => handleRun()}>
						Run Entire Timeline
					</DropdownMenuItem>
					<DropdownMenuItem onClick={handleRunSelected}>
						Run Selected Video ONLY
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			</div>
			{isRunning && (
				<Button
					variant="destructive"
					size="sm"
					className="rounded-sm px-2"
					title="Stop this HyperFrames run"
					onClick={() => abortRef.current?.abort()}
				>
					Stop
				</Button>
			)}
			{engine === "authored" && (
				<TooltipProvider delayDuration={300}>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="outline"
								size="sm"
								disabled={isRunning}
								onClick={handleRunVersions}
								className="rounded-sm"
							>
								Versions ×3
							</Button>
						</TooltipTrigger>
						<TooltipContent className="max-w-72">
							Generate 3 distinct versions of the whole video and pick the one
							you like. Renders one at a time (light on your machine) — slower
							than a single run, but easy on resources.
						</TooltipContent>
					</Tooltip>
				</TooltipProvider>
			)}
			{draftCount > 0 && (
				<TooltipProvider delayDuration={300}>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="secondary"
								size="sm"
								onClick={showPicker}
								className="rounded-sm"
							>
								Versions (ready) ▸
							</Button>
						</TooltipTrigger>
						<TooltipContent className="max-w-72">
							Reopen your {draftCount} generated version
							{draftCount === 1 ? "" : "s"} to review and pick one — they stay
							here until you apply or discard them.
						</TooltipContent>
					</Tooltip>
				</TooltipProvider>
			)}
			<RunLogPanel />
			<VariantPickerDialog />
		</div>
	);
}
