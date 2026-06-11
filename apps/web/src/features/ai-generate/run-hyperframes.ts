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
import { decodeAudioToFloat32 } from "@/media/audio";
import { extractTimelineAudio } from "@/media/mediabunny";
import { processMediaAssets } from "@/media/processing";
import { transcriptionService } from "@/services/transcription/service";
import { DEFAULT_TRANSCRIPTION_SAMPLE_RATE } from "@/transcription/audio";
import { frameRateToFloat } from "@/fps/utils";
import {
	TICKS_PER_SECOND,
	ZERO_MEDIA_TIME,
	mediaTimeFromSeconds,
} from "@/wasm";
import { generateUUID } from "@/utils/id";
import { buildAiAuthHeaders, useAiSettingsStore } from "@/features/ai-generate/store";
import { getStyleById } from "@/features/ai-generate/styles";

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

/** Finds an existing overlay video track that holds only AI-generated clips. */
function findAiTrackId(editor: EditorCore): string | null {
	const tracks = editor.scenes.getActiveScene().tracks;
	const existing = tracks.overlay.find(
		(t) =>
			t.type === "video" &&
			t.elements.length > 0 &&
			t.elements.every((el) => el.type === "video" && el.framecutAi),
	);
	return existing?.id ?? null;
}

export async function runHyperframes({
	editor,
	onProgress,
}: {
	editor: EditorCore;
	onProgress: (p: RunProgress) => void;
}): Promise<{ placed: number; skipped: string[] }> {
	const project = editor.project.getActive();
	const projectId = project.metadata.id;
	const fps = Math.round(frameRateToFloat(project.settings.fps)) || 30;
	const { width, height } = project.settings.canvasSize;
	const totalDuration = editor.timeline.getTotalDuration();
	const totalDurationSec = totalDuration / TICKS_PER_SECOND;

	if (totalDurationSec < 1) {
		throw new Error("Add some footage to the timeline first.");
	}

	// 1. Transcribe the timeline's audio (all client-side).
	onProgress({ stage: "extracting", detail: "Extracting timeline audio..." });
	const audioBlob = await extractTimelineAudio({
		tracks: editor.scenes.getActiveScene().tracks,
		mediaAssets: editor.media.getAssets(),
		totalDuration,
	});
	const { samples } = await decodeAudioToFloat32({
		audioBlob,
		sampleRate: DEFAULT_TRANSCRIPTION_SAMPLE_RATE,
	});
	const transcript = await transcriptionService.transcribe({
		audioData: samples,
		onProgress: (p) => {
			if (p.status === "loading-model") {
				onProgress({
					stage: "loading-model",
					detail: `Downloading speech model (one-time): ${Math.round(p.progress)}%`,
					progress: p.progress / 100,
				});
			} else if (p.status === "transcribing") {
				onProgress({ stage: "transcribing", detail: "Listening to your video..." });
			}
		},
	});
	if (!transcript.segments.length) {
		throw new Error(
			"No speech found in the timeline audio — HyperFrames plans effects from the transcript.",
		);
	}

	// 2. Ask Claude (the director) for an effect plan.
	onProgress({ stage: "planning", detail: "Claude is planning your effects..." });
	const planRes = await fetch("/api/hyperframes/plan", {
		method: "POST",
		headers: { "content-type": "application/json", ...buildAiAuthHeaders() },
		body: JSON.stringify({
			segments: transcript.segments,
			totalDurationSec,
		}),
	});
	if (!planRes.ok) {
		const err = (await planRes.json().catch(() => null)) as { error?: string } | null;
		throw new Error(err?.error ?? `Planning failed (${planRes.status})`);
	}
	const plan = (await planRes.json()) as { items: PlannedEffect[] };
	if (!plan.items.length) {
		throw new Error("Claude found no moments that need an effect. Try longer footage.");
	}

	// 3. Render each effect locally, then place all clips in one batch.
	// The active style theme colors every effect unless the planner chose one.
	const themeAccent = getStyleById(useAiSettingsStore.getState().styleId).accent;
	for (const item of plan.items) {
		if (item.variables.accent === undefined) {
			item.variables.accent = themeAccent;
		}
	}
	const groupId = generateUUID();
	const skipped: string[] = [];
	let placed = 0;

	const existingTrackId = findAiTrackId(editor);
	const addTrackCommand = existingTrackId
		? null
		: new AddTrackCommand({ type: "video", index: 0 });
	const trackId = existingTrackId ?? addTrackCommand!.getTrackId();
	const insertCommands: InsertElementCommand[] = [];

	for (let i = 0; i < plan.items.length; i++) {
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

			onProgress({
				stage: "placing",
				detail: `Placing ${item.templateId} on the timeline...`,
				effectIndex: i + 1,
				effectCount: plan.items.length,
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

			const durationTime = mediaTimeFromSeconds({ seconds: item.durationSec });
			insertCommands.push(
				new InsertElementCommand({
					element: {
						type: "video",
						mediaId: assetId,
						name: `AI: ${item.templateId}`,
						startTime: mediaTimeFromSeconds({ seconds: item.startSec }),
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
					placement: { mode: "explicit", trackId },
				}),
			);
			placed += 1;
		} catch (e) {
			skipped.push(
				`${item.templateId} @ ${item.startSec.toFixed(1)}s: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
	}

	if (insertCommands.length) {
		const commands = addTrackCommand
			? [addTrackCommand, ...insertCommands]
			: insertCommands;
		editor.command.execute({ command: new BatchCommand(commands) });
	} else {
		placed = 0;
	}

	onProgress({ stage: "done", detail: `Placed ${placed} effects.` });
	return { placed, skipped };
}
