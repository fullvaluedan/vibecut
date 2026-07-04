/**
 * Word-timestamp capability probing helpers (pure, wasm-free → bun-testable).
 *
 * Whether a Whisper ONNX export can emit cross-attention word timestamps is a
 * property of the MODEL, not the audio — so a short leading slice that contains
 * speech triggers the same "must contain cross attentions" error the full audio
 * would. Probing that slice first lets the worker learn the model can't do words
 * from a ~20s decode instead of a full (e.g. 16-minute) word pass that throws.
 */

/**
 * Probe window length (seconds). Long enough that a talking-head's opening
 * almost always contains speech (so the probe is conclusive), short enough that
 * the probe is a tiny fraction of a long source.
 */
export const WORD_PROBE_WINDOW_SECONDS = 20;

/**
 * Leading view of `samples`, at most `windowSamples` long. Returns a subarray
 * VIEW (no copy) so probing costs no extra memory; returns the whole array when
 * it is already shorter than the window.
 */
export function leadingWindow({
	samples,
	windowSamples,
}: {
	samples: Float32Array;
	windowSamples: number;
}): Float32Array {
	if (windowSamples <= 0) return samples.subarray(0, 0);
	return samples.length <= windowSamples
		? samples
		: samples.subarray(0, windowSamples);
}
