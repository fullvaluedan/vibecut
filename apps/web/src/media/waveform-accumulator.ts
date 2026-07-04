import type { SourceWaveformSummary } from "./waveform-summary";

/**
 * Canonical peak-bucket size (samples). Mirrors
 * `DEFAULT_SOURCE_WAVEFORM_BUCKET_SIZE` in `waveform-summary.ts`; kept here so this
 * module stays dependency-free (no `@/retime`/wasm import chain) and bun-testable.
 */
export const DEFAULT_WAVEFORM_BUCKET_SIZE = 128;

/**
 * Streaming peak-bucket accumulator: builds a `SourceWaveformSummary` from audio
 * delivered in CHUNKS (mediabunny's `AudioBufferSink`) without ever materializing
 * the full PCM. A long source (e.g. a 16-minute recording) decoded in one shot via
 * `AudioContext.decodeAudioData` truncates — it returned only ~44s of a 16-min
 * file, leaving every clip past that with a flat waveform. Feeding its decoded
 * chunks here keeps memory flat and the summary full-length.
 *
 * Buckets stay a uniform `bucketSize` samples ACROSS chunk seams (a partial bucket
 * carries into the next chunk) so the sample-index→bucket mapping the renderer
 * relies on never drifts over a long file.
 */
export class WaveformSummaryAccumulator {
	private readonly bucketSize: number;
	private readonly peaks: number[] = [];
	private bucketPeak = 0;
	private bucketFill = 0;
	private totalSamples = 0;
	private sampleRate = 0;

	constructor({
		bucketSize = DEFAULT_WAVEFORM_BUCKET_SIZE,
	}: { bucketSize?: number } = {}) {
		this.bucketSize = Math.max(1, Math.floor(bucketSize));
	}

	/** Add one decoded chunk: one Float32Array per channel, each `length` samples. */
	add({
		channels,
		length,
		sampleRate,
	}: {
		channels: readonly Float32Array[];
		length: number;
		sampleRate: number;
	}): void {
		if (sampleRate > 0) {
			this.sampleRate = sampleRate;
		}
		for (let i = 0; i < length; i++) {
			let peak = 0;
			for (const channel of channels) {
				const amplitude = Math.abs(channel[i] ?? 0);
				if (amplitude > peak) {
					peak = amplitude;
				}
			}
			if (peak > this.bucketPeak) {
				this.bucketPeak = peak;
			}
			this.bucketFill++;
			this.totalSamples++;
			if (this.bucketFill >= this.bucketSize) {
				this.peaks.push(this.bucketPeak);
				this.bucketPeak = 0;
				this.bucketFill = 0;
			}
		}
	}

	/** True once at least one sample has been added (so a 0-track file can fall back). */
	hasSamples(): boolean {
		return this.totalSamples > 0;
	}

	/** Finalize into a summary, flushing any partial trailing bucket. */
	finish({ sourceKey }: { sourceKey: string }): SourceWaveformSummary {
		if (this.bucketFill > 0) {
			this.peaks.push(this.bucketPeak);
			this.bucketPeak = 0;
			this.bucketFill = 0;
		}
		return {
			sourceKey,
			sampleRate: this.sampleRate,
			totalSamples: this.totalSamples,
			bucketSize: this.bucketSize,
			amplitudes: Float32Array.from(this.peaks),
		};
	}
}
