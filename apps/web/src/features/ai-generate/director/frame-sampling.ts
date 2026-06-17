/**
 * Pure frame-sampling math for the Director's tiered perception (U1).
 *
 * Split out from `frame-extract.ts` (which owns the mediabunny/canvas decode) so
 * the algorithmically interesting parts — downscale sizing, time clamping, the
 * coarse sampling cadence, and luma-histogram scene detection — are unit-testable
 * under `bun test` without WebCodecs/canvas. The browser shell composes these.
 */

/** Default long-edge cap for sampled frames sent to the vision model (KTD3). */
export const DEFAULT_MAX_LONG_EDGE = 768;
/** Coarse cadence (seconds) for scene-candidate probing; tuned against real footage. */
export const DEFAULT_CADENCE_SEC = 2;
/** Tiny long edge for the throwaway frames decoded only to compute histograms. */
export const SCENE_SAMPLE_EDGE = 64;
/** Luma histogram bucket count. */
export const DEFAULT_HISTOGRAM_BINS = 16;
/** Adjacent-frame histogram delta (0..1) above which a local max is a scene cut. */
export const DEFAULT_SCENE_THRESHOLD = 0.35;
/** JPEG quality for the data-URL frames. */
export const FRAME_JPEG_QUALITY = 0.8;

/** A sampled frame: a downscaled JPEG data URL at a source time (seconds). */
export interface FrameSample {
	timeSec: number;
	dataUrl: string;
}

/** Throw the project-standard cancellation error when the signal is aborted. */
export function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw new Error("Cancelled");
	}
}

/**
 * Downscale dimensions so the long edge is at most `maxLongEdge`, preserving
 * aspect ratio. Never upscales; degenerate inputs collapse to 0×0.
 */
export function frameSize({
	width,
	height,
	maxLongEdge = DEFAULT_MAX_LONG_EDGE,
}: {
	width: number;
	height: number;
	maxLongEdge?: number;
}): { width: number; height: number } {
	if (width <= 0 || height <= 0) {
		return { width: 0, height: 0 };
	}
	const longEdge = Math.max(width, height);
	if (longEdge <= maxLongEdge) {
		return { width: Math.round(width), height: Math.round(height) };
	}
	const scale = maxLongEdge / longEdge;
	return {
		width: Math.max(1, Math.round(width * scale)),
		height: Math.max(1, Math.round(height * scale)),
	};
}

/**
 * Clamp requested sample times into `[0, durationSec]`. A time past the end maps
 * to the duration (the decoder returns the last frame there) rather than throwing.
 */
export function clampSampleTimes({
	timesSec,
	durationSec,
}: {
	timesSec: readonly number[];
	durationSec: number;
}): number[] {
	const max = Math.max(0, durationSec);
	return timesSec.map((t) => {
		// NaN is undefined intent → frame 0; ±Infinity flows through the clamp
		// (a time "past the end" lands on the last frame, like any large value).
		if (Number.isNaN(t)) return 0;
		return Math.min(Math.max(0, t), max);
	});
}

/**
 * Coarse cadence sample times: `0, interval, 2·interval, …` strictly inside the
 * duration. Always yields at least `[0]` so even a still/short clip is probed.
 */
export function cadenceSampleTimes({
	durationSec,
	intervalSec = DEFAULT_CADENCE_SEC,
}: {
	durationSec: number;
	intervalSec?: number;
}): number[] {
	const times = [0];
	if (intervalSec <= 0 || durationSec <= 0) {
		return times;
	}
	for (let t = intervalSec; t < durationSec; t += intervalSec) {
		times.push(Math.round(t * 1000) / 1000);
	}
	return times;
}

/**
 * Luma histogram (Rec.601) over RGBA pixel bytes, `bins` buckets, counts
 * normalized so the histogram sums to 1 (empty input → all-zero histogram).
 */
export function lumaHistogram({
	rgba,
	bins = DEFAULT_HISTOGRAM_BINS,
}: {
	rgba: Uint8ClampedArray | Uint8Array | readonly number[];
	bins?: number;
}): number[] {
	const histogram = new Array<number>(bins).fill(0);
	const pixelCount = Math.floor(rgba.length / 4);
	if (pixelCount === 0) {
		return histogram;
	}
	for (let i = 0; i < pixelCount * 4; i += 4) {
		const luma = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
		let bin = Math.floor((luma / 256) * bins);
		if (bin >= bins) bin = bins - 1;
		if (bin < 0) bin = 0;
		histogram[bin] += 1;
	}
	return histogram.map((count) => count / pixelCount);
}

/**
 * Normalized L1 distance between two normalized histograms, in `[0, 1]`. Each
 * histogram sums to 1, so the raw L1 distance maxes at 2; halving normalizes it.
 */
export function histogramDelta({
	a,
	b,
}: {
	a: readonly number[];
	b: readonly number[];
}): number {
	const n = Math.min(a.length, b.length);
	let sum = 0;
	for (let i = 0; i < n; i++) {
		sum += Math.abs(a[i] - b[i]);
	}
	return sum / 2;
}

/**
 * From a cadence-sampled sequence of luma histograms (one per `times[i]`), pick
 * the times that START a scene: frame 0 always starts one; thereafter a time is a
 * scene start when its delta from the previous frame is a LOCAL MAXIMUM and at
 * least `threshold`. A static clip yields only `[times[0]]`; a hard cut yields a
 * start near the cut.
 */
export function pickSceneStartTimes({
	histograms,
	times,
	threshold = DEFAULT_SCENE_THRESHOLD,
}: {
	histograms: readonly number[][];
	times: readonly number[];
	threshold?: number;
}): number[] {
	if (histograms.length !== times.length) {
		throw new Error("pickSceneStartTimes: histograms and times length mismatch");
	}
	if (times.length === 0) {
		return [];
	}

	const deltas: number[] = [0];
	for (let i = 1; i < histograms.length; i++) {
		deltas.push(histogramDelta({ a: histograms[i - 1], b: histograms[i] }));
	}

	const starts: number[] = [times[0]];
	for (let i = 1; i < deltas.length; i++) {
		const aboveThreshold = deltas[i] >= threshold;
		const localMax =
			deltas[i] >= deltas[i - 1] &&
			(i === deltas.length - 1 || deltas[i] >= deltas[i + 1]);
		if (aboveThreshold && localMax) {
			starts.push(times[i]);
		}
	}

	return [...new Set(starts)].sort((a, b) => a - b);
}
