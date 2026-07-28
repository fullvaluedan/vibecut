/**
 * Pure, dependency-free math for chunked ("windowed") audio mixdown.
 *
 * The export audio stage used to allocate ONE `AudioBuffer` for the whole
 * timeline (`createTimelineAudioBuffer`), which the browser refuses to allocate
 * past roughly 21 min stereo at 44.1kHz (about 459 MB) - the "createBuffer
 * wall". This module mixes the timeline in bounded windows instead, so peak
 * memory stays flat no matter how long the timeline is.
 *
 * It has NO browser or `@/wasm` imports, so it runs under `bun test` and the
 * headless smoke proof. The window math and per-sample read are identical to
 * the single-buffer mixer, so mixing the same elements chunk-by-chunk and
 * concatenating the windows equals the whole-timeline mix sample-for-sample.
 */

export interface ChunkWindow {
	/** 0-based position of this window in the sequence. */
	index: number;
	/** First output sample of this window (inclusive, global timeline sample). */
	startFrame: number;
	/** Number of output samples in this window. */
	frameCount: number;
}

/**
 * Splits `[0, totalFrames)` into contiguous, non-overlapping windows of at most
 * `chunkFrames` samples each. The final window carries the remainder, so the
 * windows always cover exactly `totalFrames` with no gap and no overrun.
 */
export function planChunkWindows({
	totalFrames,
	chunkFrames,
}: {
	totalFrames: number;
	chunkFrames: number;
}): ChunkWindow[] {
	if (totalFrames <= 0) return [];
	if (chunkFrames <= 0) {
		throw new Error("chunkFrames must be a positive integer");
	}

	const windows: ChunkWindow[] = [];
	let start = 0;
	let index = 0;
	while (start < totalFrames) {
		const frameCount = Math.min(chunkFrames, totalFrames - start);
		windows.push({ index, startFrame: start, frameCount });
		start += frameCount;
		index++;
	}
	return windows;
}

export interface WindowMixElement {
	/** Source PCM, one `Float32Array` per source channel (mono, stereo, ...). */
	sourceChannels: Float32Array[];
	/** First output sample this element occupies (`floor(startTime * rate)`). */
	outputStartSample: number;
	/** Output samples the element spans (`ceil(duration * rate)`). */
	renderedLength: number;
	/** Output (timeline) sample rate in Hz. */
	outputSampleRate: number;
	/**
	 * Maps an element-local time (seconds, 0 at the clip's first output sample)
	 * to a floating-point index into `sourceChannels`. It already folds in
	 * `trimStart` and any retime, and is injected so this module needs no
	 * `@/retime` or `@/wasm` dependency.
	 */
	sourceIndexAt: (clipTimeSeconds: number) => number;
	/** Linear gain at an element-local time (folds volume automation). */
	gainAt: (clipTimeSeconds: number) => number;
}

/** True when `[outputStartSample, +renderedLength)` intersects the window. */
export function elementOverlapsWindow({
	element,
	windowStartFrame,
	windowFrameCount,
}: {
	element: Pick<WindowMixElement, "outputStartSample" | "renderedLength">;
	windowStartFrame: number;
	windowFrameCount: number;
}): boolean {
	const elementEnd = element.outputStartSample + element.renderedLength;
	const windowEnd = windowStartFrame + windowFrameCount;
	return element.outputStartSample < windowEnd && elementEnd > windowStartFrame;
}

/**
 * Additively mixes one element into a window's output channels.
 *
 * `windowChannels` is pre-zeroed, each of length `windowFrameCount`; index 0
 * corresponds to the global output sample `windowStartFrame`. Only the
 * intersection of the element and the window is touched (the loop bounds are
 * computed analytically), so re-scanning an element across every window stays
 * O(total samples) rather than O(total samples * window count).
 *
 * The linear-interpolation read and gain application match the single-buffer
 * mixer exactly, which is what makes the chunked output bit-for-bit equal to
 * the whole-timeline mix.
 */
export function mixElementIntoWindow({
	element,
	windowChannels,
	windowStartFrame,
	windowFrameCount,
}: {
	element: WindowMixElement;
	windowChannels: Float32Array[];
	windowStartFrame: number;
	windowFrameCount: number;
}): void {
	const sourceChannelCount = element.sourceChannels.length;
	if (sourceChannelCount === 0) return;

	const windowEnd = windowStartFrame + windowFrameCount;
	// Element-local sample range that lands inside this window.
	const iStart = Math.max(0, windowStartFrame - element.outputStartSample);
	const iEnd = Math.min(
		element.renderedLength,
		windowEnd - element.outputStartSample,
	);
	if (iEnd <= iStart) return;

	const outputChannels = windowChannels.length;
	for (let channel = 0; channel < outputChannels; channel++) {
		const outputData = windowChannels[channel];
		const sourceChannel = Math.min(channel, sourceChannelCount - 1);
		const sourceData = element.sourceChannels[sourceChannel];

		for (let i = iStart; i < iEnd; i++) {
			const outputIndex = element.outputStartSample + i;
			const windowLocal = outputIndex - windowStartFrame;

			const clipTime = i / element.outputSampleRate;
			const sourceIndex = element.sourceIndexAt(clipTime);
			// Source exhausted: stop this element's contribution, exactly like the
			// single-buffer mixer (later windows short-circuit here immediately).
			if (sourceIndex >= sourceData.length) break;

			const lowerIndex = Math.floor(sourceIndex);
			const upperIndex = Math.min(sourceData.length - 1, lowerIndex + 1);
			const fraction = sourceIndex - lowerIndex;
			const gain = element.gainAt(clipTime);

			outputData[windowLocal] +=
				(sourceData[lowerIndex] * (1 - fraction) +
					sourceData[upperIndex] * fraction) *
				gain;
		}
	}
}
