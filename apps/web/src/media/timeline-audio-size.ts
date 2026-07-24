/**
 * Pure sizing math for the timeline audio mix buffer.
 *
 * Extracted from `audio.ts` so it is unit-testable without the `@/wasm` binary —
 * `ticksPerSecond` is injected rather than imported. The frame count drives the
 * `AudioBuffer` allocation in `createTimelineAudioBuffer`; a long timeline at a
 * high sample rate produces a buffer the browser's `createBuffer` refuses to
 * allocate (e.g. ~21 min stereo @ 44.1kHz ≈ 459 MB), which is why the analysis
 * path mixes at 16 kHz mono instead.
 */

/** Frames an `AudioBuffer` needs to hold `durationTicks` of timeline at `sampleRate`. */
export function timelineAudioFrameCount({
	durationTicks,
	sampleRate,
	ticksPerSecond,
}: {
	durationTicks: number;
	sampleRate: number;
	ticksPerSecond: number;
}): number {
	return Math.ceil((durationTicks / ticksPerSecond) * sampleRate);
}

/** Bytes a Float32 `AudioBuffer` of this shape occupies (4 bytes / sample / channel). */
export function audioBufferByteSize({
	frameCount,
	channels,
}: {
	frameCount: number;
	channels: number;
}): number {
	return frameCount * channels * 4;
}

/** Output samples in one mix window of `chunkSeconds` at `sampleRate` (at least 1). */
export function chunkFrameCount({
	sampleRate,
	chunkSeconds,
}: {
	sampleRate: number;
	chunkSeconds: number;
}): number {
	return Math.max(1, Math.ceil(sampleRate * chunkSeconds));
}

/**
 * True when a timeline of `frameCount` output samples would need a mix buffer
 * larger than `maxBytes` - i.e. big enough to risk the `createBuffer` wall, so
 * it should be mixed in bounded windows instead of one allocation. Small
 * timelines stay under the cap and keep the byte-identical single-buffer path.
 */
export function shouldChunkTimelineAudio({
	frameCount,
	channels,
	maxBytes,
}: {
	frameCount: number;
	channels: number;
	maxBytes: number;
}): boolean {
	return audioBufferByteSize({ frameCount, channels }) > maxBytes;
}
