import { describe, expect, test } from "bun:test";
import {
	planChunkWindows,
	elementOverlapsWindow,
	mixElementIntoWindow,
	type WindowMixElement,
} from "../export-chunk-mixer";

// A test element whose source is read at `outputSampleRate` unless a different
// `sourceSampleRate` is given (so interpolation can be exercised). `sourceIndexAt`
// folds trimStart the same way the real mixer does. Gain is constant by default.
function makeElement({
	sourceChannels,
	outputStartSample,
	renderedLength,
	outputSampleRate = 100,
	sourceSampleRate = outputSampleRate,
	trimStart = 0,
	gain = 1,
}: {
	sourceChannels: Float32Array[];
	outputStartSample: number;
	renderedLength: number;
	outputSampleRate?: number;
	sourceSampleRate?: number;
	trimStart?: number;
	gain?: number;
}): WindowMixElement {
	return {
		sourceChannels,
		outputStartSample,
		renderedLength,
		outputSampleRate,
		sourceIndexAt: (clipTime) => (trimStart + clipTime) * sourceSampleRate,
		gainAt: () => gain,
	};
}

/**
 * Reference mixer copied verbatim from the ORIGINAL `mixAudioChannels` inner
 * loop (before it delegated to `mixElementIntoWindow`). Locks the chunked mixer
 * to the exact pre-existing single-buffer formula.
 */
function referenceFullMix({
	elements,
	totalFrames,
	channels,
}: {
	elements: WindowMixElement[];
	totalFrames: number;
	channels: number;
}): Float32Array[] {
	const out = Array.from({ length: channels }, () => new Float32Array(totalFrames));
	for (const element of elements) {
		for (let channel = 0; channel < channels; channel++) {
			const outputData = out[channel];
			const sourceChannel = Math.min(channel, element.sourceChannels.length - 1);
			const sourceData = element.sourceChannels[sourceChannel];
			for (let i = 0; i < element.renderedLength; i++) {
				const outputIndex = element.outputStartSample + i;
				if (outputIndex >= totalFrames) break;
				const clipTime = i / element.outputSampleRate;
				const sourceIndex = element.sourceIndexAt(clipTime);
				if (sourceIndex >= sourceData.length) break;
				const lower = Math.floor(sourceIndex);
				const upper = Math.min(sourceData.length - 1, lower + 1);
				const fraction = sourceIndex - lower;
				const gain = element.gainAt(clipTime);
				outputData[outputIndex] +=
					(sourceData[lower] * (1 - fraction) + sourceData[upper] * fraction) *
					gain;
			}
		}
	}
	return out;
}

/** Mix elements window-by-window and concatenate into full-length channels. */
function chunkedMix({
	elements,
	totalFrames,
	channels,
	chunkFrames,
}: {
	elements: WindowMixElement[];
	totalFrames: number;
	channels: number;
	chunkFrames: number;
}): { channels: Float32Array[]; peakWindowFrames: number } {
	const windows = planChunkWindows({ totalFrames, chunkFrames });
	const out = Array.from({ length: channels }, () => new Float32Array(totalFrames));
	let peakWindowFrames = 0;

	for (const window of windows) {
		const windowChannels = Array.from(
			{ length: channels },
			() => new Float32Array(window.frameCount),
		);
		peakWindowFrames = Math.max(peakWindowFrames, window.frameCount);

		for (const element of elements) {
			if (
				!elementOverlapsWindow({
					element,
					windowStartFrame: window.startFrame,
					windowFrameCount: window.frameCount,
				})
			) {
				continue;
			}
			mixElementIntoWindow({
				element,
				windowChannels,
				windowStartFrame: window.startFrame,
				windowFrameCount: window.frameCount,
			});
		}

		// Copy this window into the assembled output (the encoder handoff step).
		for (let channel = 0; channel < channels; channel++) {
			out[channel].set(windowChannels[channel], window.startFrame);
		}
	}

	return { channels: out, peakWindowFrames };
}

describe("planChunkWindows", () => {
	test("windows are contiguous, non-overlapping, and cover exactly totalFrames", () => {
		const windows = planChunkWindows({ totalFrames: 250, chunkFrames: 100 });
		expect(windows.map((w) => w.frameCount)).toEqual([100, 100, 50]);
		expect(windows.map((w) => w.startFrame)).toEqual([0, 100, 200]);
		expect(windows.map((w) => w.index)).toEqual([0, 1, 2]);
		expect(windows.reduce((sum, w) => sum + w.frameCount, 0)).toBe(250);
	});

	test("exact multiple has no trailing remainder window", () => {
		const windows = planChunkWindows({ totalFrames: 300, chunkFrames: 100 });
		expect(windows).toHaveLength(3);
		expect(windows[2]).toEqual({ index: 2, startFrame: 200, frameCount: 100 });
	});

	test("timeline shorter than one chunk is a single window", () => {
		const windows = planChunkWindows({ totalFrames: 40, chunkFrames: 100 });
		expect(windows).toEqual([{ index: 0, startFrame: 0, frameCount: 40 }]);
	});

	test("empty timeline yields no windows; a bad chunk size throws", () => {
		expect(planChunkWindows({ totalFrames: 0, chunkFrames: 100 })).toEqual([]);
		expect(() => planChunkWindows({ totalFrames: 100, chunkFrames: 0 })).toThrow();
	});
});

describe("elementOverlapsWindow", () => {
	const element = { outputStartSample: 100, renderedLength: 50 }; // [100, 150)

	test("detects overlap, including partial and edge-touching cases", () => {
		expect(
			elementOverlapsWindow({ element, windowStartFrame: 0, windowFrameCount: 100 }),
		).toBe(false); // [0,100) ends exactly at element start - no overlap
		expect(
			elementOverlapsWindow({ element, windowStartFrame: 80, windowFrameCount: 40 }),
		).toBe(true); // [80,120) overlaps the head
		expect(
			elementOverlapsWindow({ element, windowStartFrame: 140, windowFrameCount: 40 }),
		).toBe(true); // [140,180) overlaps the tail
		expect(
			elementOverlapsWindow({ element, windowStartFrame: 150, windowFrameCount: 40 }),
		).toBe(false); // [150,190) starts exactly at element end - no overlap
	});
});

describe("mixElementIntoWindow", () => {
	test("an element fully outside the window contributes nothing", () => {
		const element = makeElement({
			sourceChannels: [new Float32Array([1, 1, 1, 1])],
			outputStartSample: 200,
			renderedLength: 4,
		});
		const windowChannels = [new Float32Array(50)];
		mixElementIntoWindow({
			element,
			windowChannels,
			windowStartFrame: 0,
			windowFrameCount: 50,
		});
		expect(windowChannels[0].every((v) => v === 0)).toBe(true);
	});

	test("applies constant gain and writes at the right window-local offset", () => {
		const element = makeElement({
			sourceChannels: [new Float32Array([2, 4, 6, 8])],
			outputStartSample: 10,
			renderedLength: 4,
			gain: 0.5,
		});
		const windowChannels = [new Float32Array(20)];
		mixElementIntoWindow({
			element,
			windowChannels,
			windowStartFrame: 0,
			windowFrameCount: 20,
		});
		// gain 0.5 applied, placed starting at sample 10.
		expect(Array.from(windowChannels[0].slice(10, 14))).toEqual([1, 2, 3, 4]);
		expect(windowChannels[0][9]).toBe(0);
		expect(windowChannels[0][14]).toBe(0);
	});

	test("stops when the source is exhausted, exactly like the single-buffer mixer", () => {
		const element = makeElement({
			sourceChannels: [new Float32Array([1, 1])], // only 2 samples of source
			outputStartSample: 0,
			renderedLength: 10, // asks for 10 output samples
		});
		const windowChannels = [new Float32Array(10)];
		mixElementIntoWindow({
			element,
			windowChannels,
			windowStartFrame: 0,
			windowFrameCount: 10,
		});
		// Only sample 0 has a full source sample; sample 1 reads index 1 (last), then
		// index 2 is out of range so it stops. Tail stays silent.
		expect(windowChannels[0][0]).toBe(1);
		expect(windowChannels[0].slice(2).every((v) => v === 0)).toBe(true);
	});
});

describe("chunked mix equals the whole-timeline mix (the wall fix is behavior-preserving)", () => {
	test("an element that spans a window boundary is continuous across the seam", () => {
		// Ramp source so a seam-induced gap or double-count would be obvious.
		const source = new Float32Array(200);
		for (let i = 0; i < source.length; i++) source[i] = i + 1;
		const element = makeElement({
			sourceChannels: [source],
			outputStartSample: 0,
			renderedLength: 200,
		});
		const totalFrames = 200;

		const reference = referenceFullMix({ elements: [element], totalFrames, channels: 1 });
		// Chunk size 60 forces the 200-sample element across 4 window seams.
		const { channels } = chunkedMix({
			elements: [element],
			totalFrames,
			channels: 1,
			chunkFrames: 60,
		});
		expect(Array.from(channels[0])).toEqual(Array.from(reference[0]));
	});

	test("many overlapping elements, stereo, fractional resample, varied gains", () => {
		const totalFrames = 1000;
		const channels = 2;

		const toneA = new Float32Array(600);
		for (let i = 0; i < toneA.length; i++) toneA[i] = Math.sin(i / 7);
		const toneB = new Float32Array(400);
		for (let i = 0; i < toneB.length; i++) toneB[i] = Math.cos(i / 5) * 0.8;

		const elements: WindowMixElement[] = [
			makeElement({
				sourceChannels: [toneA],
				outputStartSample: 0,
				renderedLength: 600,
				gain: 0.9,
			}),
			// Overlaps toneA in [300, 700); different source rate => fractional index.
			makeElement({
				sourceChannels: [toneB, toneB],
				outputStartSample: 300,
				renderedLength: 400,
				outputSampleRate: 100,
				sourceSampleRate: 90,
				trimStart: 0.1,
				gain: 0.5,
			}),
			// Tail element that runs to the very last sample.
			makeElement({
				sourceChannels: [toneA],
				outputStartSample: 700,
				renderedLength: 300,
				gain: 1,
			}),
		];

		const reference = referenceFullMix({ elements, totalFrames, channels });

		for (const chunkFrames of [1, 37, 100, 999, 1000, 4096]) {
			const { channels: mixed, peakWindowFrames } = chunkedMix({
				elements,
				totalFrames,
				channels,
				chunkFrames,
			});
			for (let channel = 0; channel < channels; channel++) {
				for (let i = 0; i < totalFrames; i++) {
					expect(mixed[channel][i]).toBeCloseTo(reference[channel][i], 6);
				}
			}
			// No single window is ever larger than the requested chunk size.
			expect(peakWindowFrames).toBeLessThanOrEqual(Math.min(chunkFrames, totalFrames));
		}
	});
});
