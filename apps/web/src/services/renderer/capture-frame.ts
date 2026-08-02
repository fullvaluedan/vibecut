import { videoCache } from "@/services/video-cache/service";

/**
 * T18.1 freeze frame: grab one decoded video frame as a standalone PNG File,
 * via the SAME `videoCache.getFrameAt` the preview canvas and export both
 * already use for this mediaId (services/renderer/resolve.ts) - so "the
 * frame you see at the playhead" and "the frame that gets frozen" can never
 * drift apart.
 */
export async function captureVideoFrameAsFile({
	mediaId,
	file,
	sourceTimeSeconds,
	name,
}: {
	mediaId: string;
	file: File;
	sourceTimeSeconds: number;
	name: string;
}): Promise<{ file: File; width: number; height: number } | null> {
	const frame = await videoCache.getFrameAt({
		mediaId,
		file,
		time: sourceTimeSeconds,
	});
	if (!frame) {
		return null;
	}

	const width = frame.canvas.width;
	const height = frame.canvas.height;
	const canvas = new OffscreenCanvas(width, height);
	const ctx = canvas.getContext("2d");
	if (!ctx) {
		return null;
	}
	ctx.drawImage(frame.canvas, 0, 0, width, height);

	const blob = await canvas.convertToBlob({ type: "image/png" });
	return {
		file: new File([blob], name, { type: "image/png" }),
		width,
		height,
	};
}
