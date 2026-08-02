/**
 * T19.2 eyedropper: fetch the DECODED SOURCE frame of one clip at the
 * playhead, as raw RGBA the picker can index into.
 *
 * Video goes through `videoCache.getFrameAt`, exactly like
 * `services/renderer/capture-frame.ts` does for freeze frame, so the pixels
 * the picker samples are the same pixels the renderer hands the shader. The
 * clip-time -> source-time math below is copied from `freeze-frame.ts` for the
 * same reason it exists there: trim + retime (including reverse and speed
 * curves) must be honoured or the picked colour comes from the wrong frame.
 */

import type { MediaAsset } from "@/media/types";
import { getSourceTimeAtClipTime } from "@/retime";
import { videoCache } from "@/services/video-cache/service";
import type { TimelineElement } from "@/timeline";
import { isRetimableElement } from "@/timeline";
import {
	addMediaTime,
	type MediaTime,
	mediaTimeToSeconds,
	roundMediaTime,
	subMediaTime,
} from "@/wasm";

export interface DecodedSourceFrame {
	data: Uint8ClampedArray;
	width: number;
	height: number;
	/** Kept so the magnifier can draw a scaled crop without re-decoding. */
	source: CanvasImageSource;
}

/** Mirrors freeze-frame.ts's clip-time -> source-time conversion. */
export function resolveSourceTimeSeconds({
	element,
	currentTime,
}: {
	element: TimelineElement;
	currentTime: MediaTime;
}): number {
	const clipTime = subMediaTime({ a: currentTime, b: element.startTime });
	const retime = isRetimableElement(element) ? element.retime : undefined;
	const trimStart = "trimStart" in element ? element.trimStart : (0 as MediaTime);
	const sourceTimeTicks = addMediaTime({
		a: trimStart,
		b: roundMediaTime({
			time: getSourceTimeAtClipTime({
				clipTime,
				retime,
				clipDuration: element.duration,
			}),
		}),
	});
	return mediaTimeToSeconds({ time: sourceTimeTicks });
}

function readCanvasPixels({
	source,
	width,
	height,
}: {
	source: CanvasImageSource;
	width: number;
	height: number;
}): DecodedSourceFrame | null {
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext("2d", { willReadFrequently: true });
	if (!context) {
		return null;
	}
	context.drawImage(source, 0, 0, width, height);
	try {
		const imageData = context.getImageData(0, 0, width, height);
		return { data: imageData.data, width, height, source };
	} catch {
		// A tainted canvas (cross-origin media) cannot be read back. Refuse
		// rather than returning zeroed pixels the user would pick black from.
		return null;
	}
}

/**
 * The decoded frame behind a clip at the playhead, or null when this element
 * has no readable source (a text/graphic layer, an undecodable video, a
 * cross-origin image).
 */
export async function getDecodedSourceFrame({
	element,
	mediaAsset,
	currentTime,
}: {
	element: TimelineElement;
	mediaAsset: MediaAsset | undefined;
	currentTime: MediaTime;
}): Promise<DecodedSourceFrame | null> {
	if (!mediaAsset?.file) {
		return null;
	}

	if (element.type === "video") {
		const frame = await videoCache.getFrameAt({
			mediaId: element.mediaId,
			file: mediaAsset.file,
			time: resolveSourceTimeSeconds({ element, currentTime }),
		});
		if (!frame) {
			return null;
		}
		return readCanvasPixels({
			source: frame.canvas,
			width: frame.canvas.width,
			height: frame.canvas.height,
		});
	}

	if (element.type === "image") {
		const bitmap = await createImageBitmap(mediaAsset.file).catch(() => null);
		if (!bitmap) {
			return null;
		}
		return readCanvasPixels({
			source: bitmap,
			width: bitmap.width,
			height: bitmap.height,
		});
	}

	return null;
}
