/**
 * "Run through HyperFrames" on a SPECIFIC clip from the timeline (right-click
 * entry). The HyperFrames panel is a PROMPT GENERATOR: the user's selections +
 * active look + direction + the clip's transcript compile into a brief, Claude
 * AUTHORS a custom composition for it (via /api/hyperframes/author — text
 * output, the product writes + renders), and the result lands on a NEW track
 * over the segment, never overwriting the footage (see place-hyperframes-render).
 */

import { toast } from "sonner";
import type { EditorCore } from "@/core";
import type { VideoElement } from "@/timeline";
import { frameRateToFloat } from "@/fps/utils";
import { TICKS_PER_SECOND } from "@/wasm";
import {
	useAiSettingsStore,
	buildAiAuthHeaders,
} from "@/features/ai-generate/store";
import { getStyleById } from "@/features/ai-generate/styles";
import { describeTemplateCatalog } from "@framecut/hf-bridge/templates";
import {
	getCachedTranscript,
	ensureTimelineTranscript,
} from "@/features/transcription/transcript-cache";
import {
	compileHyperframesPrompt,
	type HfSelectionAsset,
} from "@/features/ai-generate/compile-hyperframes-prompt";
import {
	placeHyperframesRender,
	type HyperframesRenderScope,
} from "@/features/ai-generate/place-hyperframes-render";
import { useRunLogStore, logRun } from "@/features/ai-generate/run-log-store";
import type { RunProgress } from "@/features/ai-generate/run-hyperframes";

/** Enabled native templates → selection hints for the author brief. */
function enabledSelections(): HfSelectionAsset[] {
	const disabled = useAiSettingsStore.getState().disabledTemplateIds;
	return describeTemplateCatalog()
		.filter((t) => !disabled.includes(t.id))
		.map((t) => ({
			name: t.id,
			kind: "template" as const,
			title: t.id,
			description: t.whenToUse,
		}));
}

/**
 * The registry assets the user explicitly PICKED for the brief (allow-list),
 * resolved to their titles/descriptions via the registry. Best-effort — a
 * fetch failure just means those picks aren't named in the brief.
 */
async function pickedRegistrySelections(): Promise<HfSelectionAsset[]> {
	const picks = useAiSettingsStore.getState().promptHfAssets;
	if (!picks.length) return [];
	try {
		const res = await fetch("/api/hyperframes/registry");
		if (!res.ok) return [];
		const all = (await res.json()) as {
			name: string;
			type: string;
			title: string;
			description: string;
			tags?: string[];
		}[];
		const want = new Set(picks);
		return all
			.filter((a) => want.has(a.name))
			.map((a) => {
				const kind = a.type.split(":")[1];
				return {
					name: a.name,
					kind: (kind === "block" ||
					kind === "component" ||
					kind === "example"
						? kind
						: "block") as HfSelectionAsset["kind"],
					title: a.title,
					description: a.description,
					// Examples are whole-video templates; flag them so the brief
					// tells the author they REFRAME the footage.
					fullFrame: kind === "example" ? true : undefined,
				};
			});
	} catch {
		return [];
	}
}

/** Segments scoped to [startSec, endSec], offset to 0, as bracketed text. */
function scopeSegments(
	segments: { start: number; end: number; text: string }[],
	startSec: number,
	endSec: number,
): string {
	return segments
		.filter((s) => s.end > startSec && s.start < endSec)
		.map(
			(s) =>
				`[${Math.max(0, s.start - startSec).toFixed(1)}–${Math.max(
					0,
					s.end - startSec,
				).toFixed(1)}] ${s.text.trim()}`,
		)
		.join("\n");
}

/** Does the timeline have any audio worth transcribing? */
function timelineHasAudio(editor: EditorCore): boolean {
	const t = editor.scenes.getActiveScene().tracks;
	if (t.audio.some((tr) => tr.elements.length > 0)) return true;
	return [t.main, ...t.overlay].some((tr) =>
		tr.elements.some(
			(e) => e.type === "video" && e.isSourceAudioEnabled !== false,
		),
	);
}

/**
 * Transcript for the clip so the authored graphic reflects what's SAID in it.
 * Transcribes on demand (cached after the first run) when the timeline has
 * audio; otherwise best-effort from cache. Never blocks authoring — a failure
 * just means the graphic is authored from the selections + look alone.
 */
async function gatherClipTranscript(
	editor: EditorCore,
	startSec: number,
	endSec: number,
): Promise<string> {
	if (timelineHasAudio(editor)) {
		try {
			const { segments } = await ensureTimelineTranscript({
				editor,
				onProgress: (p) => logRun(`${p.phase}: ${p.detail}`),
			});
			return scopeSegments(segments, startSec, endSec);
		} catch (e) {
			logRun(
				`(transcript skipped: ${e instanceof Error ? e.message : String(e)})`,
				"warn",
			);
		}
	}
	return scopeSegments(getCachedTranscript(editor) ?? [], startSec, endSec);
}

let clipRunInFlight = false;

export async function runHyperframesOnClip({
	editor,
	element,
}: {
	editor: EditorCore;
	/** The right-clicked clip. */
	element: VideoElement;
}): Promise<void> {
	// Re-entrancy guard: the context-menu entry has no isRunning gate, so a
	// double-click would fire two concurrent authors (double tokens, duplicate
	// graphic). One at a time.
	if (clipRunInFlight) {
		toast.info("A HyperFrames run is already in progress", {
			description: "Wait for it to finish or cancel it first.",
		});
		return;
	}
	clipRunInFlight = true;
	const startSec = element.startTime / TICKS_PER_SECOND;
	const endSec = (element.startTime + element.duration) / TICKS_PER_SECOND;
	const scope: HyperframesRenderScope = {
		kind: "clip",
		label: element.name?.trim() || "clip",
		startSec,
	};

	const project = editor.project.getActive();
	const fps = Math.round(frameRateToFloat(project.settings.fps)) || 30;
	const { width, height } = project.settings.canvasSize;
	const durationSec = Math.min(Math.max(endSec - startSec, 3), 10);
	const { styleId, hfDirection } = useAiSettingsStore.getState();
	const look = getStyleById(styleId);

	const controller = new AbortController();
	const toastId = toast.loading(
		`HyperFrames is authoring a graphic for "${scope.label}"...`,
		{ action: { label: "Cancel", onClick: () => controller.abort() } },
	);
	useRunLogStore.getState().setOpen(true);
	logRun(`▶ Run through HyperFrames on "${scope.label}"`);
	try {
		const transcript = await gatherClipTranscript(editor, startSec, endSec);
		const registrySelections = await pickedRegistrySelections();
		const prompt = compileHyperframesPrompt({
			selections: [...enabledSelections(), ...registrySelections],
			look: {
				name: look.name,
				description: look.description,
				accent: look.accent,
				fontFamily: look.fontFamily,
			},
			direction: hfDirection,
			scope: { kind: "clip", label: `clip "${scope.label}"`, startSec, endSec },
			transcript,
			canvas: { width, height, fps },
		});
		logRun("Authoring a custom graphic with Claude (this can take ~30–60s)…");
		const res = await fetch("/api/hyperframes/author", {
			method: "POST",
			headers: { "content-type": "application/json", ...buildAiAuthHeaders() },
			body: JSON.stringify({ prompt, fps, width, height, durationSec }),
			signal: controller.signal,
		});
		if (!res.ok) {
			const err = (await res.json().catch(() => null)) as {
				error?: string;
			} | null;
			throw new Error(err?.error ?? `Author failed (${res.status})`);
		}
		const compId = res.headers.get("x-framecut-comp-id") ?? undefined;
		const tokens = Number(res.headers.get("x-framecut-tokens")) || 0;
		if (tokens > 0) useAiSettingsStore.getState().addTokensUsed(tokens);
		logRun("Composition rendered. Placing on a new track…");
		const blob = await res.blob();
		const file = new File([blob], "hf-authored-clip.webm", {
			type: "video/webm",
		});

		const placed = await placeHyperframesRender({
			editor,
			file,
			scope,
			compId,
			templateId: `authored:${compId ?? "clip"}`,
			name: `HyperFrames: ${scope.label}`,
		});

		logRun(
			`✓ landed on a new track over "${scope.label}" at ${placed.startSec.toFixed(1)}s`,
		);
		toast.success(
			`Landed on a new track over "${scope.label}" at ${placed.startSec.toFixed(1)}s`,
			{
				id: toastId,
				description: placed.splitAudio
					? "Sound effects split to a new audio track below."
					: "Edit it in HyperFrames Studio, then re-render.",
			},
		);
	} catch (e) {
		if (controller.signal.aborted) {
			logRun("■ cancelled by user", "warn");
			toast.info("HyperFrames run cancelled", {
				id: toastId,
				description: "Stopped the author; nothing was placed on the timeline.",
			});
			return;
		}
		const message = e instanceof Error ? e.message : String(e);
		logRun(`✗ ${message}`, "error");
		toast.error("HyperFrames run failed", {
			id: toastId,
			description: message,
		});
	} finally {
		clipRunInFlight = false;
	}
}

/**
 * RUN HYPERFRAMES "authored" engine: author ONE custom composition for the
 * WHOLE video — Claude times multiple graphics inside it from the full
 * transcript — and place it on a NEW video track at the start (never
 * overwriting). Shares the button's progress/result shape with runHyperframes
 * so the toolbar button can call either.
 */
export async function runHyperframesWholeTimeline({
	editor,
	onProgress,
	signal,
}: {
	editor: EditorCore;
	onProgress: (p: RunProgress) => void;
	signal?: AbortSignal;
}): Promise<{ placed: number; skipped: string[]; tokensUsed: number }> {
	const project = editor.project.getActive();
	const fps = Math.round(frameRateToFloat(project.settings.fps)) || 30;
	const { width, height } = project.settings.canvasSize;
	const totalSec = editor.timeline.getTotalDuration() / TICKS_PER_SECOND;
	if (totalSec < 1) {
		throw new Error("Add some footage to the timeline first.");
	}
	const durationSec = Math.min(totalSec, 300);
	const { styleId, hfDirection } = useAiSettingsStore.getState();
	const look = getStyleById(styleId);

	useRunLogStore.getState().setOpen(true);
	logRun("▶ RUN HYPERFRAMES — authoring custom graphics for the whole video");

	onProgress({ stage: "transcribing", detail: "Reading the timeline…" });
	const transcript = await gatherClipTranscript(editor, 0, totalSec);
	const registrySelections = await pickedRegistrySelections();
	const prompt = compileHyperframesPrompt({
		selections: [...enabledSelections(), ...registrySelections],
		look: {
			name: look.name,
			description: look.description,
			accent: look.accent,
			fontFamily: look.fontFamily,
		},
		direction: hfDirection,
		scope: {
			kind: "timeline",
			label: "the whole video",
			startSec: 0,
			endSec: totalSec,
		},
		transcript,
		canvas: { width, height, fps },
	});

	onProgress({
		stage: "rendering",
		detail: "Claude is authoring the graphics…",
		effectIndex: 1,
		effectCount: 1,
	});
	logRun("Authoring graphics with Claude (this can take ~30–90s)…");
	const res = await fetch("/api/hyperframes/author", {
		method: "POST",
		headers: { "content-type": "application/json", ...buildAiAuthHeaders() },
		body: JSON.stringify({ prompt, fps, width, height, durationSec }),
		signal,
	});
	if (!res.ok) {
		const err = (await res.json().catch(() => null)) as { error?: string } | null;
		throw new Error(err?.error ?? `Author failed (${res.status})`);
	}
	const compId = res.headers.get("x-framecut-comp-id") ?? undefined;
	const tokens = Number(res.headers.get("x-framecut-tokens")) || 0;
	if (tokens > 0) useAiSettingsStore.getState().addTokensUsed(tokens);

	onProgress({
		stage: "placing",
		detail: "Placing on a new track…",
		effectIndex: 1,
		effectCount: 1,
	});
	logRun("Composition rendered. Placing on a new video track at the start…");
	const blob = await res.blob();
	const file = new File([blob], "hf-authored-timeline.webm", {
		type: "video/webm",
	});
	await placeHyperframesRender({
		editor,
		file,
		scope: { kind: "timeline", label: "the whole video", startSec: 0 },
		compId,
		templateId: `authored:${compId ?? "timeline"}`,
		name: "HyperFrames: whole video",
	});
	logRun("✓ landed on a new video track at 0.0s");
	onProgress({ stage: "done", detail: "Placed 1 authored graphic." });
	return { placed: 1, skipped: [], tokensUsed: tokens };
}
