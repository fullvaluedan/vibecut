/**
 * Streaming linear resampler (pure, wasm-free → bun-testable).
 *
 * Resamples audio delivered in CHUNKS (mediabunny's AudioBufferSink) to a target
 * rate while writing straight into a pre-sized output buffer — so a long source
 * never materializes its full native PCM. The previous per-asset decode held the
 * source ~3× (all chunks + a full native Float32 copy + a full native AudioBuffer)
 * before resampling, which OOM'd a 16-min recording at "Extracting timeline audio".
 *
 * Linear interpolation with a one-sample carry across chunk seams keeps the
 * input→output position continuous (no per-chunk discontinuity). It is used for
 * the heavy-downsample ANALYSIS path (→16kHz for transcription/silence), where a
 * crude resample is fine; the export path keeps its higher-quality offline render.
 */
export class StreamingLinearResampler {
	/** Native input samples per output sample (nativeRate / targetRate). */
	private readonly ratio: number;
	private readonly numChannels: number;
	private readonly out: Float32Array[];
	/** Absolute index of the first sample of the NEXT chunk to arrive. */
	private inputBase = 0;
	/** Last sample of the previous chunk, per channel (for seam interpolation). */
	private readonly tail: Float32Array;
	private writeIndex = 0;

	constructor({
		nativeRate,
		targetRate,
		numChannels,
		maxOutputSamples,
	}: {
		nativeRate: number;
		targetRate: number;
		numChannels: number;
		maxOutputSamples: number;
	}) {
		this.ratio = nativeRate / targetRate;
		this.numChannels = numChannels;
		this.out = Array.from(
			{ length: numChannels },
			() => new Float32Array(Math.max(0, maxOutputSamples)),
		);
		this.tail = new Float32Array(numChannels);
	}

	/** Fold one decoded chunk (one Float32Array per channel, each `length` long). */
	push({
		channels,
		length,
	}: {
		channels: readonly Float32Array[];
		length: number;
	}): void {
		if (length <= 0) return;
		const base = this.inputBase;
		const end = base + length;
		const capacity = this.out[0]?.length ?? 0;
		while (this.writeIndex < capacity) {
			const src = this.writeIndex * this.ratio;
			const i0 = Math.floor(src);
			const i1 = i0 + 1;
			if (i1 >= end) break; // need a later chunk to interpolate this output
			const frac = src - i0;
			for (let c = 0; c < this.numChannels; c++) {
				const data = channels[c] ?? channels[channels.length - 1];
				// i0 is at most base-1 (the saved tail); i1 is always within this chunk.
				const s0 = i0 >= base ? (data[i0 - base] ?? 0) : this.tail[c];
				const s1 = data[i1 - base] ?? 0;
				this.out[c][this.writeIndex] = s0 + (s1 - s0) * frac;
			}
			this.writeIndex++;
		}
		for (let c = 0; c < this.numChannels; c++) {
			const data = channels[c] ?? channels[channels.length - 1];
			this.tail[c] = data[length - 1] ?? this.tail[c];
		}
		this.inputBase = end;
	}

	/** Resampled channels, trimmed to the number of samples actually produced. */
	finish(): Float32Array[] {
		return this.out.map((channel) => channel.subarray(0, this.writeIndex));
	}

	/** Samples produced so far (per channel). */
	get outputLength(): number {
		return this.writeIndex;
	}
}
