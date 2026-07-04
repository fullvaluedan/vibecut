import { describe, expect, test } from "bun:test";
import { WaveformSummaryAccumulator } from "../waveform-accumulator";

describe("WaveformSummaryAccumulator", () => {
	test("peaks per bucket, with a uniform bucket size across one chunk", () => {
		const acc = new WaveformSummaryAccumulator({ bucketSize: 4 });
		// 8 samples → 2 full buckets. Peak (abs) of each group of 4.
		acc.add({
			channels: [new Float32Array([0.1, -0.9, 0.2, 0.3, -0.4, 0.5, -0.2, 0.1])],
			length: 8,
			sampleRate: 48000,
		});
		const summary = acc.finish({ sourceKey: "media:x" });
		expect(Array.from(summary.amplitudes)).toEqual([
			0.8999999761581421, // |−0.9|, rounded by Float32
			0.5,
		]);
		expect(summary.totalSamples).toBe(8);
		expect(summary.bucketSize).toBe(4);
		expect(summary.sampleRate).toBe(48000);
	});

	test("buckets stay uniform ACROSS chunk seams (the long-file correctness rule)", () => {
		// Same 8 samples, but split 3 + 5 across two chunks. A naive per-chunk
		// bucketer would emit a partial bucket at the seam and drift; the carry-over
		// must produce the SAME result as the single-chunk case above.
		const split = new WaveformSummaryAccumulator({ bucketSize: 4 });
		split.add({
			channels: [new Float32Array([0.1, -0.9, 0.2])],
			length: 3,
			sampleRate: 48000,
		});
		split.add({
			channels: [new Float32Array([0.3, -0.4, 0.5, -0.2, 0.1])],
			length: 5,
			sampleRate: 48000,
		});
		const summary = split.finish({ sourceKey: "media:x" });
		expect(Array.from(summary.amplitudes)).toEqual([
			0.8999999761581421,
			0.5,
		]);
		expect(summary.totalSamples).toBe(8);
	});

	test("a trailing partial bucket is flushed", () => {
		const acc = new WaveformSummaryAccumulator({ bucketSize: 4 });
		acc.add({
			channels: [new Float32Array([0.2, 0.7, 0.1, 0.0, 0.6])], // 5 samples → 1 full + 1 partial
			length: 5,
			sampleRate: 16000,
		});
		const summary = acc.finish({ sourceKey: "media:x" });
		expect(summary.amplitudes.length).toBe(2);
		expect(summary.amplitudes[1]).toBeCloseTo(0.6, 5);
		expect(summary.totalSamples).toBe(5);
	});

	test("peak is taken across channels", () => {
		const acc = new WaveformSummaryAccumulator({ bucketSize: 2 });
		acc.add({
			channels: [
				new Float32Array([0.1, 0.2]),
				new Float32Array([0.9, -0.05]),
			],
			length: 2,
			sampleRate: 44100,
		});
		const summary = acc.finish({ sourceKey: "media:x" });
		expect(summary.amplitudes[0]).toBeCloseTo(0.9, 5); // max(|0.1|,|0.9|)
	});

	test("hasSamples reflects whether any audio was added", () => {
		const empty = new WaveformSummaryAccumulator();
		expect(empty.hasSamples()).toBe(false);
		empty.add({ channels: [new Float32Array([0.5])], length: 1, sampleRate: 8000 });
		expect(empty.hasSamples()).toBe(true);
	});
});
