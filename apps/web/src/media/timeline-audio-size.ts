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
