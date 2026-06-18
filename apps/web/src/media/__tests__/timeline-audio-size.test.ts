import { describe, expect, test } from "bun:test";
import {
	audioBufferByteSize,
	timelineAudioFrameCount,
} from "../timeline-audio-size";

// Wasm-free local copy of TICKS_PER_SECOND (the helpers inject it so they're
// bun-testable without the @/wasm binary).
const TPS = 120_000;

describe("timelineAudioFrameCount", () => {
	test("frames = ceil(durationSeconds * sampleRate)", () => {
		expect(
			timelineAudioFrameCount({
				durationTicks: 2 * TPS,
				sampleRate: 16000,
				ticksPerSecond: TPS,
			}),
		).toBe(32000); // 2s @ 16kHz
	});

	test("the reported ~21.7-min crash: 44.1kHz is the rejected size; 16kHz is far smaller", () => {
		const durationTicks = Math.round(1302.96 * TPS); // ≈ the crash duration
		const old44k = timelineAudioFrameCount({
			durationTicks,
			sampleRate: 44100,
			ticksPerSecond: TPS,
		});
		const new16k = timelineAudioFrameCount({
			durationTicks,
			sampleRate: 16000,
			ticksPerSecond: TPS,
		});
		expect(old44k).toBeGreaterThan(57_000_000); // ~57.46M — what createBuffer rejected
		expect(new16k).toBeLessThan(21_000_000); // ~20.85M
	});

	test("rounds partial samples up and handles a zero-length timeline", () => {
		expect(
			timelineAudioFrameCount({
				durationTicks: 1,
				sampleRate: 16000,
				ticksPerSecond: TPS,
			}),
		).toBe(1); // ceil of a tiny fraction
		expect(
			timelineAudioFrameCount({
				durationTicks: 0,
				sampleRate: 16000,
				ticksPerSecond: TPS,
			}),
		).toBe(0);
	});
});

describe("audioBufferByteSize", () => {
	test("16kHz mono is ~5.5x smaller than 44.1kHz stereo for the same duration", () => {
		const durationTicks = Math.round(1302.96 * TPS);
		const stereo44k = audioBufferByteSize({
			frameCount: timelineAudioFrameCount({
				durationTicks,
				sampleRate: 44100,
				ticksPerSecond: TPS,
			}),
			channels: 2,
		});
		const mono16k = audioBufferByteSize({
			frameCount: timelineAudioFrameCount({
				durationTicks,
				sampleRate: 16000,
				ticksPerSecond: TPS,
			}),
			channels: 1,
		});
		expect(stereo44k).toBeGreaterThan(450_000_000); // ~459 MB — the failing allocation
		expect(mono16k).toBeLessThan(90_000_000); // ~83 MB — fits createBuffer
		expect(stereo44k / mono16k).toBeGreaterThan(5); // ~5.5x reduction
	});
});
