/**
 * RUN HYPERFRAMES orchestrator: transcribe the timeline, ask Claude to plan
 * overlay effects, render each one locally to transparent WebM, and place
 * the results on a dedicated "HyperFrames" overlay track.
 */

import type { EditorCore } from "@/core";
import { AddMediaAssetCommand } from "@/commands/media/add-media-asset";
import {
	AddTrackCommand,
	BatchCommand,
	InsertElementCommand,
} from "@/commands";
import { processMediaAssets } from "@/media/processing";
import { ensureTimelineTranscript } from "@/features/transcription/transcript-cache";
import { frameRateToFloat } from "@/fps/utils";
import {
	TICKS_PER_SECOND,
	ZERO_MEDIA_TIME,
	mediaTimeFromSeconds,
} from "@/wasm";
import { generateUUID } from "@/utils/id";
import { buildAiAuthHeaders, useAiSettingsStore } from "@/features/ai-generate/store";
import { usePreferenceStore } from "@/features/ai-generate/preference-store";
import { getStyleById } from "@/features/ai-generate/styles";
import { buildAiLanes, claimLane } from "@/features/ai-generate/placement";
import { getMotionTemplate } from "@/features/motion-templates/templates";
import { describeTemplateCatalog } from "@framecut/hf-bridge/templates";

export interface RunProgress {
	stage:
		| "extracting"
		| "loading-model"
		| "transcribing"
		| "planning"
		| "rendering"
		| "placing"
		| "done"
		| "error";
	detail: string;
	/** 0..1 within the current stage where known. */
	progress?: number;
	/** rendering stage: which effect of how many. */
	effectIndex?: number;
	effectCount?: number;
}

export interface PlannedEffect {
	id: string;
	templateId: string;
	startSec: number;
	durationSec: number;
	variables: Record<string, string | number | boolean>;
	reason: string;
}

export async function runHyperframes({
	editor,
	onProgress,
	signal,
}: {
	editor: EditorCore;
	onProgress: (p: RunProgress) => void;
	/** Abort to stop the run between stages (Stop button). */
	signal?: AbortSignal;
}): Promise<{ placed: number; skipped: string[]; tokensUsed: number }> {
	const throwIfCancelled = () => {
		if (signal?.aborted) throw new Error("Cancelled");
	};
	/**
	 * Some stages (model download, transcription, local decode) can't be
	 * cancelled internally — racing them against the abort signal means
	 * Stop always returns control immediately, even mid-download.
	 */
	const abortable = <T>(promise: Promise<T>): Promise<T> => {
		if (!signal) return promise;
		return Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				const onAbort = () => reject(new Error("Cancelled"));
				if (signal.aborted) onAbort();
				else signal.addEventListener("abort", onAbort, { once: true });
			}),
		]);
	};
	const project = editor.project.getActive();
	const projectId = project.metadata.id;
	const fps = Math.round(frameRateToFloat(project.settings.fps)) || 30;
	const { width, height } = project.settings.canvasSize;
	const totalDuration = editor.timeline.getTotalDuration();
	const totalDurationSec = totalDuration / TICKS_PER_SECOND;

	if (totalDurationSec < 1) {
		throw new Error("Add some footage to the timeline first.");
	}

	// 1. Get the timeline transcript — instant when the background
	// transcriber has already cached this exact timeline state.
	onProgress({ stage: "extracting", detail: "Getting the transcript..." });
	const { segments, fromCache } = await abortable(
		ensureTimelineTranscript({
			editor,
			signal,
			onProgress: (p) =>
				onProgress({
					stage:
						p.phase === "extracting"
							? "extracting"
							: p.phase === "transcribing"
								? "transcribing"
								: "loading-model",
					detail: p.detail,
					progress: p.progress,
				}),
		}),
	);
	if (fromCache) {
		onProgress({
			stage: "transcribing",
			detail: "Using the cached transcript...",
		});
	}
	if (!segments.length) {
		throw new Error(
			"No speech found in the timeline audio — HyperFrames plans effects from the transcript.",
		);
	}

	throwIfCancelled();

	// 2. Ask Claude (the director) for an effect plan, restricted to the
	// templates checked in the HyperFrames panel.
	const { disabledTemplateIds, hfDirection } = useAiSettingsStore.getState();
	const allowedTemplateIds = describeTemplateCatalog()
		.map((t) => t.id)
		.filter((id) => !disabledTemplateIds.includes(id));
	if (!allowedTemplateIds.length) {
		throw new Error(
			"All templates are unchecked in the HyperFrames panel — check at least one.",
		);
	}
	onProgress({ stage: "planning", detail: "Claude is planning your effects..." });
	const activeLook = getStyleById(useAiSettingsStore.getState().styleId);
	const planRes = await fetch("/api/hyperframes/plan", {
		method: "POST",
		headers: { "content-type": "application/json", ...buildAiAuthHeaders() },
		signal,
		body: JSON.stringify({
			segments,
			totalDurationSec,
			allowedTemplateIds,
			direction: hfDirection,
			preferences: usePreferenceStore.getState().buildPreferenceNotes(),
			// Bias the planner toward templates/pacing that fit the chosen look.
			look: { name: activeLook.name, description: activeLook.description },
		}),
	});
	if (!planRes.ok) {
		const err = (await planRes.json().catch(() => null)) as { error?: string } | null;
		throw new Error(err?.error ?? `Planning failed (${planRes.status})`);
	}
	const plan = (await planRes.json().catch(() => null)) as {
		items?: PlannedEffect[];
		usage?: { inputTokens: number; outputTokens: number } | null;
	} | null;
	if (!plan || !Array.isArray(plan.items)) {
		throw new Error("Planning returned an unexpected response — try again.");
	}
	const tokensUsed = plan.usage
		? plan.usage.inputTokens + plan.usage.outputTokens
		: 0;
	if (tokensUsed > 0) {
		useAiSettingsStore.getState().addTokensUsed(tokensUsed);
	}
	if (!plan.items.length) {
		throw new Error("Claude found no moments that need an effect. Try longer footage.");
	}

	// 3. Render each effect locally, then place all clips in one batch.
	// The active style/look colors and sets the typeface of every effect
	// (unless the planner chose its own accent).
	const themeStyle = getStyleById(useAiSettingsStore.getState().styleId);
	const themeAccent = themeStyle.accent;
	for (const item of plan.items) {
		if (item.variables.accent === undefined) {
			item.variables.accent = themeAccent;
		}
	}
	const groupId = generateUUID();
	const skipped: string[] = [];
	let placed = 0;

	// 3a. Instant engine: place native motion-template elements directly —
	// no Chrome render, no media import, fully editable afterwards, and
	// nothing for ffmpeg to burn in at export.
	if (useAiSettingsStore.getState().hfEngine === "native") {
		onProgress({
			stage: "placing",
			detail: "Placing instant effects...",
			effectIndex: plan.items.length,
			effectCount: plan.items.length,
		});
		const canvasSize = editor.project.getActive().settings.canvasSize;
		plan.items.sort((a, b) => a.startSec - b.startSec);
		const commands: InsertElementCommand[] = [];
		const placedTemplateIds: string[] = [];
		for (const item of plan.items) {
			const template = getMotionTemplate(item.templateId);
			if (!template) {
				skipped.push(`${item.templateId}: no native version yet`);
				continue;
			}
			const elements = template.build({
				startTime: mediaTimeFromSeconds({ seconds: item.startSec }),
				durationSec: item.durationSec,
				variables: item.variables,
				accent: String(item.variables.accent ?? themeAccent),
				fontFamily: themeStyle.fontFamily,
				canvasSize,
				// One edit-group PER planned effect — sharing the run-wide id would
				// make Template Controls treat the whole run as a single template.
				groupId: generateUUID(),
				fromAi: true,
			});
			for (const element of elements) {
				commands.push(
					new InsertElementCommand({ element, placement: { mode: "auto" } }),
				);
			}
			placedTemplateIds.push(item.templateId);
		}
		let nativePlaced = 0;
		if (commands.length) {
			editor.command.execute({ command: new BatchCommand(commands) });
			// Trust nothing: count what ACTUALLY landed on the timeline instead of
			// the number of templates we tried to build. Returning the attempted
			// count made a no-op look like success ("Placed N") with nothing added.
			const after = editor.scenes.getActiveScene().tracks;
			const onTimeline = new Set(
				[after.main, ...after.overlay, ...after.audio].flatMap((t) =>
					t.elements.map((el) => el.id),
				),
			);
			nativePlaced = commands.filter((c) =>
				onTimeline.has(c.getElementId() ?? ""),
			).length;
		}
		usePreferenceStore.getState().noteTemplatesPlaced(placedTemplateIds);
		// Never fail silently: if nothing landed, say why.
		if (nativePlaced === 0 && skipped.length === 0) {
			skipped.push(
				plan.items.length === 0
					? "the planner found no moments that fit a template"
					: "the planner returned effects but none could be placed on the timeline",
			);
		}
		return { placed: nativePlaced, skipped, tokensUsed };
	}

	// Rendering takes minutes — the user may click around (even into another
	// scene) while it runs. Collect everything first, place at the end.
	const originSceneId = editor.scenes.getActiveScene().id;
	const rendered: Array<{
		item: PlannedEffect;
		assetId: string;
		compId: string;
	}> = [];
	// Stable packing: place earlier effects first so lanes fill predictably.
	plan.items.sort((a, b) => a.startSec - b.startSec);

	for (let i = 0; i < plan.items.length; i++) {
		throwIfCancelled();
		const item = plan.items[i];
		onProgress({
			stage: "rendering",
			detail: `Rendering ${item.templateId} (${i + 1} of ${plan.items.length})`,
			effectIndex: i + 1,
			effectCount: plan.items.length,
		});

		try {
			const renderRes = await fetch("/api/hyperframes/render", {
				method: "POST",
				headers: { "content-type": "application/json" },
				signal,
				body: JSON.stringify({
					templateId: item.templateId,
					durationSec: item.durationSec,
					fps,
					width,
					height,
					variables: item.variables,
				}),
			});
			if (!renderRes.ok) {
				const err = (await renderRes.json().catch(() => null)) as {
					error?: string;
				} | null;
				throw new Error(err?.error ?? `render ${renderRes.status}`);
			}
			const compId = renderRes.headers.get("x-framecut-comp-id") ?? "unknown";
			const blob = await renderRes.blob();
			const file = new File([blob], `hf-${item.templateId}-${i + 1}.webm`, {
				type: "video/webm",
			});

			// Derive metadata + thumbnail the same way normal imports do.
			const [processed] = await processMediaAssets({ files: [file] });
			if (!processed) throw new Error("could not process rendered video");

			const addAsset = new AddMediaAssetCommand({
				projectId,
				asset: processed,
			});
			editor.command.execute({ command: addAsset });
			const assetId = addAsset.getAssetId();
			if (!assetId) throw new Error("could not store rendered video");

			rendered.push({ item, assetId, compId });
		} catch (e) {
			skipped.push(
				`${item.templateId} @ ${item.startSec.toFixed(1)}s: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
	}

	throwIfCancelled();

	if (rendered.length) {
		onProgress({
			stage: "placing",
			detail: "Placing effects on the timeline...",
			effectIndex: rendered.length,
			effectCount: plan.items.length,
		});

		// If the user wandered into another scene during the run, place the
		// effects in the scene the run started from, then come back.
		const sceneAtPlacement = editor.scenes.getActiveScene().id;
		if (sceneAtPlacement !== originSceneId) {
			await editor.scenes.switchToScene({ sceneId: originSceneId });
		}

		const lanes = buildAiLanes(editor);
		const insertCommands = rendered.map(({ item, assetId, compId }) => {
			const durationTime = mediaTimeFromSeconds({ seconds: item.durationSec });
			const startTime = mediaTimeFromSeconds({ seconds: item.startSec });
			const lane = claimLane({
				lanes,
				start: startTime,
				end: startTime + durationTime,
			});
			return new InsertElementCommand({
				element: {
					type: "video",
					mediaId: assetId,
					name: `AI: ${item.templateId}`,
					startTime,
					duration: durationTime,
					trimStart: ZERO_MEDIA_TIME,
					trimEnd: ZERO_MEDIA_TIME,
					sourceDuration: durationTime,
					isSourceAudioEnabled: false,
					params: {},
					framecutAi: {
						compId,
						templateId: item.templateId,
						variables: item.variables,
						groupId,
					},
				},
				placement: { mode: "explicit", trackId: lane.trackId },
			});
		});
		const addTrackCommands = lanes
			.map((l) => l.addCommand)
			.filter((c): c is AddTrackCommand => c !== null);
		editor.command.execute({
			command: new BatchCommand([...addTrackCommands, ...insertCommands]),
		});

		// Trust nothing: count what actually landed on the timeline. Anything
		// missing is reported instead of silently claiming success.
		const after = editor.scenes.getActiveScene().tracks;
		const onTimeline = new Set(
			after.overlay.flatMap((t) => t.elements.map((el) => el.id)),
		);
		for (const cmd of insertCommands) {
			if (onTimeline.has(cmd.getElementId())) {
				placed += 1;
			} else {
				skipped.push(
					"a rendered effect could not be placed on the timeline (it is still in your media bin)",
				);
			}
		}

		// Self-learning: remember which templates landed, so later deletions
		// can be read as "the user doesn't like this one".
		usePreferenceStore
			.getState()
			.noteTemplatesPlaced(rendered.map(({ item }) => item.templateId));

		if (sceneAtPlacement !== originSceneId) {
			await editor.scenes.switchToScene({ sceneId: sceneAtPlacement });
		}
	}

	onProgress({ stage: "done", detail: `Placed ${placed} effects.` });
	return { placed, skipped, tokensUsed };
}
