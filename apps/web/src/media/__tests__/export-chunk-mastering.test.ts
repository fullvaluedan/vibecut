import { describe, expect, test } from "bun:test";
import {
	applyGainToAudioBuffer,
	getAudioBufferPeak,
	masterGainForPeak,
	MASTER_OUTPUT_HEADROOM,
} from "../audio-mastering";

/**
 * A minimal stand-in for an `AudioBuffer`: the mastering helpers only read
 * `numberOfChannels` / `getChannelData(channel)` and mutate the returned
 * Float32Array in place, so a plain object backed by real Float32Arrays behaves
 * identically without needing Web Audio in the test runner.
 */
function fakeBuffer(channels: number[][]): AudioBuffer {
	const data = channels.map((c) => Float32Array.from(c));
	return {
		numberOfChannels: data.length,
		length: data[0]?.length ?? 0,
		sampleRate: 44_100,
		getChannelData: (channel: number) => data[channel],
	} as unknown as AudioBuffer;
}

describe("chunked export mastering is one global, seam-free decision", () => {
	test("a sub-threshold mix is a true pass-through (gain exactly 1)", () => {
		expect(masterGainForPeak({ peak: 0 })).toBe(1);
		expect(masterGainForPeak({ peak: 0.5 })).toBe(1);
		// Exactly at the ceiling is still a pass-through (matches the limiter).
		expect(masterGainForPeak({ peak: MASTER_OUTPUT_HEADROOM })).toBe(1);
	});

	test("a clipping mix normalizes the global peak down to the headroom ceiling", () => {
		const gain = masterGainForPeak({ peak: 1.5 });
		expect(gain).toBeCloseTo(MASTER_OUTPUT_HEADROOM / 1.5, 12);
		// The loudest sample lands exactly on the ceiling after the scalar.
		expect(1.5 * gain).toBeCloseTo(MASTER_OUTPUT_HEADROOM, 12);
	});

	test("applyGainToAudioBuffer with gain 1 leaves every sample untouched", () => {
		const buffer = fakeBuffer([[0.1, -0.2, 0.3]]);
		const before = Array.from(buffer.getChannelData(0));
		applyGainToAudioBuffer({ audioBuffer: buffer, gain: 1 });
		expect(Array.from(buffer.getChannelData(0))).toEqual(before);
	});

	test("a constant-amplitude clipping tone has equal gain on both sides of a window seam", () => {
		// Two adjacent 60s windows of the SAME clipping amplitude (a constant 1.5
		// tone split across a seam). The whole-timeline peak drives ONE scalar
		// applied to both windows, so there is no loudness step at the boundary.
		const left = fakeBuffer([[1.5, 1.5, 1.5, 1.5]]);
		const right = fakeBuffer([[1.5, 1.5, 1.5, 1.5]]);

		const globalPeak = Math.max(
			getAudioBufferPeak({ audioBuffer: left }),
			getAudioBufferPeak({ audioBuffer: right }),
		);
		const gain = masterGainForPeak({ peak: globalPeak });
		applyGainToAudioBuffer({ audioBuffer: left, gain });
		applyGainToAudioBuffer({ audioBuffer: right, gain });

		const lastOfLeft = left.getChannelData(0)[3];
		const firstOfRight = right.getChannelData(0)[0];
		expect(firstOfRight).toBe(lastOfLeft); // no step at the seam (exact)
		// Float32 storage, so the absolute value is only single-precision exact.
		expect(lastOfLeft).toBeCloseTo(MASTER_OUTPUT_HEADROOM, 6);
	});

	test("a clipping sine has an equal output/input gain ratio across the seam", () => {
		const N = 8;
		const amp = 1.5; // clips
		const sine = (i: number) => amp * Math.sin((2 * Math.PI * i) / N);
		// Split the tone at the seam between window sample 3 and window sample 0.
		const leftIn = [sine(0), sine(1), sine(2), sine(3)];
		const rightIn = [sine(4), sine(5), sine(6), sine(7)];
		const left = fakeBuffer([leftIn]);
		const right = fakeBuffer([rightIn]);

		const gain = masterGainForPeak({
			peak: Math.max(
				getAudioBufferPeak({ audioBuffer: left }),
				getAudioBufferPeak({ audioBuffer: right }),
			),
		});
		applyGainToAudioBuffer({ audioBuffer: left, gain });
		applyGainToAudioBuffer({ audioBuffer: right, gain });

		const leftRatio = left.getChannelData(0)[3] / leftIn[3];
		const rightRatio = right.getChannelData(0)[0] / rightIn[0];
		// Float32 storage limits this to single precision; the gain is still equal
		// on both sides of the seam to ~7 significant digits (a per-window
		// compressor would step it far more than that).
		expect(rightRatio).toBeCloseTo(leftRatio, 6); // gain identical across the seam
		expect(leftRatio).toBeCloseTo(gain, 6);
	});
});
