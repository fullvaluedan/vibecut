import { describe, expect, test } from "bun:test";
import { StreamingLinearResampler } from "../streaming-resampler";

/** Reference whole-buffer linear resample to compare the streamed result against. */
function referenceResample({
	input,
	nativeRate,
	targetRate,
}: {
	input: number[];
	nativeRate: number;
	targetRate: number;
}): number[] {
	const ratio = nativeRate / targetRate;
	const out: number[] = [];
	for (let o = 0; ; o++) {
		const src = o * ratio;
		const i0 = Math.floor(src);
		const i1 = i0 + 1;
		if (i1 >= input.length) break;
		const frac = src - i0;
		out.push(input[i0] + (input[i1] - input[i0]) * frac);
	}
	return out;
}

function close({
	actual,
	expected,
	eps = 1e-5,
}: {
	actual: number[];
	expected: number[];
	eps?: number;
}) {
	expect(actual.length).toBe(expected.length);
	for (let i = 0; i < actual.length; i++) {
		expect(Math.abs(actual[i] - expected[i])).toBeLessThan(eps);
	}
}

describe("StreamingLinearResampler", () => {
	test("identity at ratio 1 reproduces the input (minus the trailing sample)", () => {
		const r = new StreamingLinearResampler({
			nativeRate: 16000,
			targetRate: 16000,
			numChannels: 1,
			maxOutputSamples: 8,
		});
		const input = [0, 0.1, 0.2, 0.3, 0.4, 0.5];
		r.push({ channels: [new Float32Array(input)], length: input.length });
		const out = Array.from(r.finish()[0]);
		// ratio 1 → output[o] = input[o]; last sample dropped (no i1 to interpolate).
		close({ actual: out, expected: input.slice(0, input.length - 1) });
	});

	test("integer downsample 48k->16k picks every 3rd sample", () => {
		const r = new StreamingLinearResampler({
			nativeRate: 48000,
			targetRate: 16000,
			numChannels: 1,
			maxOutputSamples: 16,
		});
		const input = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
		r.push({ channels: [new Float32Array(input)], length: input.length });
		expect(Array.from(r.finish()[0])).toEqual([0, 3, 6]);
	});

	test("chunked input matches a whole-buffer resample ACROSS seams", () => {
		const nativeRate = 48000;
		const targetRate = 16000;
		const input = Array.from({ length: 100 }, (_, i) => Math.sin(i / 5));
		const expected = referenceResample({ input, nativeRate, targetRate });

		const r = new StreamingLinearResampler({
			nativeRate,
			targetRate,
			numChannels: 1,
			maxOutputSamples: 64,
		});
		// Push in uneven chunks so seams land at non-multiples of the ratio.
		for (const [start, len] of [
			[0, 7],
			[7, 13],
			[20, 1],
			[21, 50],
			[71, 29],
		] as const) {
			r.push({
				channels: [new Float32Array(input.slice(start, start + len))],
				length: len,
			});
		}
		close({ actual: Array.from(r.finish()[0]), expected });
	});

	test("non-integer ratio (44.1k->16k) uses the seam tail correctly", () => {
		const nativeRate = 44100;
		const targetRate = 16000;
		const input = Array.from({ length: 200 }, (_, i) => (i % 7) / 7);
		const expected = referenceResample({ input, nativeRate, targetRate });
		const r = new StreamingLinearResampler({
			nativeRate,
			targetRate,
			numChannels: 1,
			maxOutputSamples: 128,
		});
		for (let i = 0; i < input.length; i += 11) {
			const len = Math.min(11, input.length - i);
			r.push({ channels: [new Float32Array(input.slice(i, i + len))], length: len });
		}
		close({ actual: Array.from(r.finish()[0]), expected });
	});

	test("two channels resample independently", () => {
		const r = new StreamingLinearResampler({
			nativeRate: 48000,
			targetRate: 16000,
			numChannels: 2,
			maxOutputSamples: 8,
		});
		const left = [0, 1, 2, 3, 4, 5, 6];
		const right = [10, 11, 12, 13, 14, 15, 16];
		r.push({
			channels: [new Float32Array(left), new Float32Array(right)],
			length: left.length,
		});
		const out = r.finish();
		expect(Array.from(out[0])).toEqual([0, 3]);
		expect(Array.from(out[1])).toEqual([10, 13]);
	});

	test("never writes past the pre-sized output capacity", () => {
		const r = new StreamingLinearResampler({
			nativeRate: 16000,
			targetRate: 16000,
			numChannels: 1,
			maxOutputSamples: 3, // deliberately too small
		});
		r.push({ channels: [new Float32Array([1, 2, 3, 4, 5, 6, 7, 8])], length: 8 });
		expect(r.outputLength).toBeLessThanOrEqual(3);
	});
});
