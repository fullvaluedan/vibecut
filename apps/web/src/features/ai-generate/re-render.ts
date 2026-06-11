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
import type { EditorCore } from "@/core";
import type { VideoElement } from "@/timeline";

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
