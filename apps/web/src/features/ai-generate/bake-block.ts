/**
 * Bake library — client side. Renders a HyperFrames registry block to a cached
 * transparent WebM (server bakes once, reuses forever) and drops it onto an AI
 * overlay lane at the playhead. The clip carries `framecutAi.registryBlock`, so
 * it rides the same alpha-preview + export-burn path as cinematic AI clips and
 * the properties panel shows it a re-bake action instead of a template swap.
 */

import type { EditorCore } from "@/core";
import { AddMediaAssetCommand } from "@/commands/media/add-media-asset";
import { AddTrackCommand, BatchCommand, InsertElementCommand } from "@/commands";
import { processMediaAssets } from "@/media/processing";
import { buildAiLanes, claimLane } from "@/features/ai-generate/placement";
import { frameRateToFloat } from "@/fps/utils";
import { ZERO_MEDIA_TIME, mediaTimeFromSeconds } from "@/wasm";
import { generateUUID } from "@/utils/id";

export interface BakeResult {
	cached: boolean;
	title: string;
	durationSec: number;
}

/** Bakes a registry block and places it at the playhead. Returns bake info. */
export async function bakeAndPlaceBlock({
	editor,
	name,
}: {
	editor: EditorCore;
	name: string;
}): Promise<BakeResult> {
	const project = editor.project.getActive();
	const projectId = project.metadata.id;
	const fps = Math.round(frameRateToFloat(project.settings.fps)) || 30;

	const res = await fetch("/api/hyperframes/bake", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ name, fps }),
	});
	if (!res.ok) {
		const err = (await res.json().catch(() => null)) as { error?: string } | null;
		throw new Error(err?.error ?? `Bake failed (${res.status})`);
	}

	const bakeKey = res.headers.get("x-framecut-bake-key") ?? name;
	const cached = res.headers.get("x-framecut-cached") === "1";
	const durationSec = Number(res.headers.get("x-framecut-duration")) || 5;
	const title = decodeURIComponent(
		res.headers.get("x-framecut-title") ?? name,
	);

	// Place at scale 1 / position 0. The overlay preview layer and the export
	// compositor both contain-fit the block into the canvas (see overlay-rect.ts
	// / computeVisualTransform) — so scale 1 already means "fit, centered." A
	// transform here would DOUBLE-apply that fit. The user can move/scale it
	// afterward like any clip.

	const blob = await res.blob();
	const file = new File([blob], `hf-block-${name}.webm`, { type: "video/webm" });
	const [processed] = await processMediaAssets({ files: [file] });
	if (!processed) throw new Error("Could not process the baked block");

	const addAsset = new AddMediaAssetCommand({ projectId, asset: processed });
	editor.command.execute({ command: addAsset });
	const assetId = addAsset.getAssetId();
	if (!assetId) throw new Error("Could not store the baked block");

	const durationTime = mediaTimeFromSeconds({ seconds: durationSec });
	const startTime = editor.playback.getCurrentTime();
	const lanes = buildAiLanes(editor);
	const lane = claimLane({
		lanes,
		start: startTime,
		end: startTime + durationTime,
	});

	const insert = new InsertElementCommand({
		element: {
			type: "video",
			mediaId: assetId,
			name: `Block: ${title}`,
			startTime,
			duration: durationTime,
			trimStart: ZERO_MEDIA_TIME,
			trimEnd: ZERO_MEDIA_TIME,
			sourceDuration: durationTime,
			isSourceAudioEnabled: false,
			params: {},
			framecutAi: {
				compId: bakeKey,
				templateId: `registry:${name}`,
				variables: {},
				groupId: generateUUID(),
				registryBlock: name,
			},
		},
		placement: { mode: "explicit", trackId: lane.trackId },
	});
	const addTrackCommands = lanes
		.map((l) => l.addCommand)
		.filter((c): c is AddTrackCommand => c !== null);
	editor.command.execute({
		command: new BatchCommand([...addTrackCommands, insert]),
	});

	return { cached, title, durationSec };
}
