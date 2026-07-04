/**
 * Re-renders an AI clip with a (possibly different) template/variables and
 * swaps the media in place. Shared by the HyperFrames tab and style themes.
 */

import { AddMediaAssetCommand } from "@/commands/media/add-media-asset";
import { UpdateElementsCommand } from "@/commands/timeline/element/update-elements";
import { processMediaAssets } from "@/media/processing";
import { frameRateToFloat } from "@/fps/utils";
import { TICKS_PER_SECOND, mediaTimeFromSeconds } from "@/wasm";
import { getTemplate } from "@framecut/hf-bridge/templates";
import { buildAiAuthHeaders, useAiSettingsStore } from "./store";
import type { EditorCore } from "@/core";
import type { VideoElement } from "@/timeline";

/**
 * Re-renders the clip's comp dir exactly as it is on disk — pulls in any
 * edits made in HyperFrames Studio — and swaps the media in place.
 */
export async function reRenderFromCompDir({
	editor,
	trackId,
	element,
}: {
	editor: EditorCore;
	trackId: string;
	element: VideoElement;
}): Promise<void> {
	const ai = element.framecutAi;
	if (!ai) throw new Error("Not an AI-generated clip");

	const project = editor.project.getActive();
	const fps = Math.round(frameRateToFloat(project.settings.fps)) || 30;
	const res = await fetch("/api/hyperframes/render-comp", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ compId: ai.compId, fps }),
	});
	if (!res.ok) {
		const err = (await res.json().catch(() => null)) as { error?: string } | null;
		throw new Error(err?.error ?? `Render failed (${res.status})`);
	}
	const blob = await res.blob();
	const file = new File([blob], `hf-${ai.templateId}-studio.webm`, {
		type: "video/webm",
	});
	const [processed] = await processMediaAssets({ files: [file] });
	if (!processed) throw new Error("Could not process the rendered video");

	const addAsset = new AddMediaAssetCommand({
		projectId: project.metadata.id,
		asset: processed,
	});
	editor.command.execute({ command: addAsset });
	const assetId = addAsset.getAssetId();
	if (!assetId) throw new Error("Could not store the rendered video");

	const renderedDuration = processed.duration
		? mediaTimeFromSeconds({ seconds: processed.duration })
		: element.duration;
	editor.command.execute({
		command: new UpdateElementsCommand({
			updates: [
				{
					trackId,
					elementId: element.id,
					patch: {
						mediaId: assetId,
						duration: renderedDuration,
						sourceDuration: renderedDuration,
					},
				},
			],
		}),
	});
}

export async function reRenderAiClip({
	editor,
	trackId,
	element,
	templateId,
	variables,
}: {
	editor: EditorCore;
	trackId: string;
	element: VideoElement;
	templateId: string;
	variables: Record<string, string | number | boolean>;
}): Promise<void> {
	const ai = element.framecutAi;
	if (!ai) throw new Error("Not an AI-generated clip");
	const template = getTemplate(templateId);
	if (!template) throw new Error(`Unknown template: ${templateId}`);

	const project = editor.project.getActive();
	const fps = Math.round(frameRateToFloat(project.settings.fps)) || 30;
	const { width, height } = project.settings.canvasSize;
	const elementDurationSec = element.duration / TICKS_PER_SECOND;
	const durationSec = Math.min(
		Math.max(elementDurationSec, template.minDurationSec),
		template.maxDurationSec,
	);

	const res = await fetch("/api/hyperframes/render", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ templateId, durationSec, fps, width, height, variables }),
	});
	if (!res.ok) {
		const err = (await res.json().catch(() => null)) as { error?: string } | null;
		throw new Error(err?.error ?? `Render failed (${res.status})`);
	}
	const compId = res.headers.get("x-framecut-comp-id") ?? ai.compId;
	const blob = await res.blob();
	const file = new File([blob], `hf-${templateId}-restyle.webm`, {
		type: "video/webm",
	});
	const [processed] = await processMediaAssets({ files: [file] });
	if (!processed) throw new Error("Could not process the rendered video");

	const addAsset = new AddMediaAssetCommand({
		projectId: project.metadata.id,
		asset: processed,
	});
	editor.command.execute({ command: addAsset });
	const assetId = addAsset.getAssetId();
	if (!assetId) throw new Error("Could not store the rendered video");

	const durationTime = mediaTimeFromSeconds({ seconds: durationSec });
	editor.command.execute({
		command: new UpdateElementsCommand({
			updates: [
				{
					trackId,
					elementId: element.id,
					patch: {
						mediaId: assetId,
						name: `AI: ${templateId}`,
						duration: durationTime,
						sourceDuration: durationTime,
						framecutAi: { compId, templateId, variables, groupId: ai.groupId },
					},
				},
			],
		}),
	});
}

/**
 * Re-author a skill-authored clip from an edited brief: sends the prompt back
 * through the hyperframes skill (`/api/hyperframes/author`), then swaps the
 * rendered overlay in place and stores the new brief + compId on the clip so
 * the panel keeps showing the live prompt. This is the per-graphic "customize"
 * path — the user edits the prompt and regenerates the same graphic.
 */
export async function regenerateAuthoredClip({
	editor,
	trackId,
	element,
	brief,
}: {
	editor: EditorCore;
	trackId: string;
	element: VideoElement;
	brief: string;
}): Promise<void> {
	const ai = element.framecutAi;
	if (!ai) throw new Error("Not an AI-generated clip");

	const project = editor.project.getActive();
	const fps = Math.round(frameRateToFloat(project.settings.fps)) || 30;
	const { width, height } = project.settings.canvasSize;
	const durationSec = Math.min(
		Math.max(element.duration / TICKS_PER_SECOND, 3),
		10,
	);

	const res = await fetch("/api/hyperframes/author", {
		method: "POST",
		headers: { "content-type": "application/json", ...buildAiAuthHeaders() },
		body: JSON.stringify({ prompt: brief, fps, width, height, durationSec }),
	});
	if (!res.ok) {
		const err = (await res.json().catch(() => null)) as { error?: string } | null;
		throw new Error(err?.error ?? `Regenerate failed (${res.status})`);
	}
	const compId = res.headers.get("x-framecut-comp-id") ?? ai.compId;
	const tokens = Number(res.headers.get("x-framecut-tokens")) || 0;
	if (tokens > 0) useAiSettingsStore.getState().addTokensUsed(tokens);

	const blob = await res.blob();
	const file = new File([blob], "hf-authored-regenerate.webm", {
		type: "video/webm",
	});
	const [processed] = await processMediaAssets({ files: [file] });
	if (!processed) throw new Error("Could not process the rendered video");

	const addAsset = new AddMediaAssetCommand({
		projectId: project.metadata.id,
		asset: processed,
	});
	editor.command.execute({ command: addAsset });
	const assetId = addAsset.getAssetId();
	if (!assetId) throw new Error("Could not store the rendered video");

	const renderedDuration = processed.duration
		? mediaTimeFromSeconds({ seconds: processed.duration })
		: element.duration;
	editor.command.execute({
		command: new UpdateElementsCommand({
			updates: [
				{
					trackId,
					elementId: element.id,
					patch: {
						mediaId: assetId,
						duration: renderedDuration,
						sourceDuration: renderedDuration,
						framecutAi: {
							compId,
							templateId: `authored:${compId}`,
							variables: ai.variables,
							groupId: ai.groupId,
							brief,
						},
					},
				},
			],
		}),
	});
}
