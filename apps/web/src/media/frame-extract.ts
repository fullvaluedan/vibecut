/**
 * Reusable, cancellable frame sampler for the Director's vision input (U1).
 *
 * `extractFrames` decodes specific source times into downscaled JPEG data URLs
 * (the model's image blocks); `pickSceneCandidates` proposes sample times by a
 * coarse cadence refined with a cheap luma-histogram scene detector, so vision
 * only sees one representative frame per scene (KTD3). The decode mirrors
 * `readVideoFile`/`renderThumbnailDataUrl` (mediabunny `VideoSampleSink` +
 * canvas); the sizing/clamping/scene math lives in the wasm-free `./frame-sampling`.
 *
 * Browser-only (WebCodecs + canvas), so it is verified live, not under `bun test`;
 * its pure helpers are unit-tested separately.
 */

import { ALL_FORMATS, BlobSource, Input, VideoSampleSink } from "mediabunny";
import type { MediaAsset } from "@/media/types";
import {
	cadenceSampleTimes,
	clampSampleTimes,
	DEFAULT_MAX_LONG_EDGE,
	FRAME_JPEG_QUALITY,
	frameSize,
	lumaHistogram,
	pickSceneStartTimes,
	SCENE_SAMPLE_EDGE,
	throwIfAborted,
	type FrameSample,
} from "./frame-sampling";

export type { FrameSample } from "./frame-sampling";

/** Create a sized 2D canvas and run `draw` into it; willReadFrequently for pixel reads. */
function drawToCanvas({
	draw,
	srcWidth,
	srcHeight,
	maxLongEdge,
}: {
	draw: (ctx: CanvasRenderingContext2D, width: number, height: number) => void;
	srcWidth: number;
	srcHeight: number;
	maxLongEdge: number;
}): HTMLCanvasElement {
	const size = frameSize({ width: srcWidth, height: srcHeight, maxLongEdge });
	const canvas = document.createElement("canvas");
	canvas.width = Math.max(1, size.width);
	canvas.height = Math.max(1, size.height);
	const ctx = canvas.getContext("2d", { willReadFrequently: true });
	if (!ctx) {
		throw new Error("Could not get 2D canvas context");
	}
	draw(ctx, canvas.width, canvas.height);
	return canvas;
}

/**
 * Decode `timesSec` from an asset into downscaled JPEG frames. Times past the end
 * clamp to the last frame; an image asset returns one frame regardless of times;
 * audio returns none. Aborting via `signal` rejects with `Cancelled` and decodes
 * no further frames.
 */
export async function extractFrames({
	asset,
	timesSec,
	signal,
	maxLongEdge = DEFAULT_MAX_LONG_EDGE,
}: {
	asset: MediaAsset;
	timesSec: readonly number[];
	signal?: AbortSignal;
	/** Long-edge cap for the returned frames (default 768px). */
	maxLongEdge?: number;
}): Promise<FrameSample[]> {
	throwIfAborted(signal);

	if (asset.type === "audio") {
		return [];
	}

	if (asset.type === "image") {
		const bitmap = await createImageBitmap(asset.file);
		try {
			const canvas = drawToCanvas({
				draw: (ctx, width, height) => ctx.drawImage(bitmap, 0, 0, width, height),
				srcWidth: bitmap.width,
				srcHeight: bitmap.height,
				maxLongEdge,
			});
			return [{ timeSec: 0, dataUrl: canvas.toDataURL("image/jpeg", FRAME_JPEG_QUALITY) }];
		} finally {
			bitmap.close();
		}
	}

	const input = new Input({ source: new BlobSource(asset.file), formats: ALL_FORMATS });
	try {
		const videoTrack = await input.getPrimaryVideoTrack();
		if (!videoTrack) {
			return [];
		}
		const durationSec = asset.duration ?? (await input.computeDuration());
		const clamped = clampSampleTimes({ timesSec, durationSec });
		const sink = new VideoSampleSink(videoTrack);
		const frames: FrameSample[] = [];

		for (const timeSec of clamped) {
			throwIfAborted(signal);
			const sample = await sink.getSample(timeSec);
			if (!sample) continue;
			try {
				const canvas = drawToCanvas({
					draw: (ctx, width, height) => sample.draw(ctx, 0, 0, width, height),
					srcWidth: videoTrack.displayWidth,
					srcHeight: videoTrack.displayHeight,
					maxLongEdge,
				});
				frames.push({
					timeSec,
					dataUrl: canvas.toDataURL("image/jpeg", FRAME_JPEG_QUALITY),
				});
			} finally {
				sample.close();
			}
		}
		return frames;
	} finally {
		input.dispose();
	}
}

/**
 * Propose scene-start sample times: probe at a coarse cadence, compute a tiny
 * luma histogram per probe, and keep the cadence times where the histogram delta
 * spikes (a likely cut). Non-video assets yield `[0]`. Cancellable via `signal`.
 */
export async function pickSceneCandidates({
	asset,
	signal,
	cadenceSec,
	threshold,
}: {
	asset: MediaAsset;
	signal?: AbortSignal;
	/** Coarse cadence in seconds (default 2s). */
	cadenceSec?: number;
	/** Histogram-delta threshold for a scene cut (default 0.35). */
	threshold?: number;
}): Promise<number[]> {
	if (asset.type !== "video") {
		return [0];
	}

	const durationSec = asset.duration ?? 0;
	const times = cadenceSampleTimes({ durationSec, intervalSec: cadenceSec });

	const input = new Input({ source: new BlobSource(asset.file), formats: ALL_FORMATS });
	try {
		const videoTrack = await input.getPrimaryVideoTrack();
		if (!videoTrack) {
			return [0];
		}
		const sink = new VideoSampleSink(videoTrack);
		const histograms: number[][] = [];
		const keptTimes: number[] = [];

		for (const timeSec of times) {
			throwIfAborted(signal);
			const sample = await sink.getSample(timeSec);
			if (!sample) continue;
			try {
				const canvas = drawToCanvas({
					draw: (ctx, width, height) => sample.draw(ctx, 0, 0, width, height),
					srcWidth: videoTrack.displayWidth,
					srcHeight: videoTrack.displayHeight,
					maxLongEdge: SCENE_SAMPLE_EDGE,
				});
				const ctx = canvas.getContext("2d", { willReadFrequently: true });
				if (!ctx) continue;
				const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
				histograms.push(lumaHistogram({ rgba: data }));
				keptTimes.push(timeSec);
			} finally {
				sample.close();
			}
		}

		return pickSceneStartTimes({ histograms, times: keptTimes, threshold });
	} finally {
		input.dispose();
	}
}
