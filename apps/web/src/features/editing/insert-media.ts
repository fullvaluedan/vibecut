/**
 * VibeCut media insertion: Premiere-style behavior where adding a video with
 * audio also separates its audio onto an audio track (waveform visible).
 */

import { AddMediaAssetCommand, BatchCommand } from "@/commands";
import { InsertElementCommand } from "@/commands/timeline/element/insert-element";
import { DEFAULT_NEW_ELEMENT_DURATION } from "@/timeline/creation";
import { buildElementFromMedia } from "@/timeline/element-utils";
import type { EditorCore } from "@/core";
import type { MediaAsset } from "@/media/types";
import { buildSolidColorAsset } from "@/media/solid-color";
import { mediaTimeFromSeconds, type MediaTime } from "@/wasm";

type Placement =
	| { mode: "explicit"; trackId: string }
	| { mode: "auto"; trackType?: "video" | "text" | "audio" | "graphic" | "effect"; insertIndex?: number };

export function insertMediaAsset({
	editor,
	asset,
	startTime,
	placement = { mode: "auto" },
	separateAudio = true,
}: {
	editor: EditorCore;
	asset: MediaAsset;
	startTime: MediaTime;
	placement?: Placement;
	separateAudio?: boolean;
}): { elementId: string | null; trackId: string | null } {
	const duration =
		asset.duration != null
			? mediaTimeFromSeconds({ seconds: asset.duration })
			: DEFAULT_NEW_ELEMENT_DURATION;
	const element = buildElementFromMedia({
		mediaId: asset.id,
		mediaType: asset.type,
		name: asset.name,
		duration,
		startTime,
	});
	const command = new InsertElementCommand({ element, placement });
	editor.command.execute({ command });
	const elementId = command.getElementId() ?? null;
	const trackId = command.getTrackId() ?? null;

	if (
		separateAudio &&
		asset.type === "video" &&
		asset.hasAudio !== false &&
		elementId &&
		trackId
	) {
		editor.timeline.toggleSourceAudioSeparation({ trackId, elementId });
	}

	return { elementId, trackId };
}

/**
 * W7 "Solid color" bin action: one click both creates the synthetic color
 * media asset AND places it at the playhead, as a single undoable step (no
 * creation dialog - mirrors how paste-an-image-from-clipboard batches
 * AddMediaAssetCommand + InsertElementCommand in use-paste-media.ts).
 */
export function insertSolidColorAsset({
	editor,
	projectId,
	canvasSize,
	color,
	startTime,
}: {
	editor: EditorCore;
	projectId: string;
	canvasSize: { width: number; height: number };
	color?: string;
	startTime: MediaTime;
}): { assetId: string; elementId: string | null; trackId: string | null } {
	const asset = buildSolidColorAsset({ color, canvasSize });
	const addAssetCommand = new AddMediaAssetCommand({ projectId, asset });
	const assetId = addAssetCommand.getAssetId();

	const element = buildElementFromMedia({
		mediaId: assetId,
		mediaType: asset.type,
		name: asset.name,
		duration: DEFAULT_NEW_ELEMENT_DURATION,
		startTime,
	});
	const insertCommand = new InsertElementCommand({
		element,
		placement: { mode: "auto" },
	});

	editor.command.execute({
		command: new BatchCommand([addAssetCommand, insertCommand]),
	});

	return {
		assetId,
		elementId: insertCommand.getElementId() ?? null,
		trackId: insertCommand.getTrackId() ?? null,
	};
}
