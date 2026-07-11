import { describe, expect, test } from "bun:test";
import {
	buildFixtureAudioFeatures,
	FIXTURE_ENVELOPE_WINDOW_SEC,
} from "../fixture-types";

/** Synthesize a mono buffer: a loud sine for [0,loudSec), then silence. */
function sineThenSilence({
	sampleRate,
	loudSec,
	totalSec,
	freq = 220,
	amp = 0.6,
}: {
	sampleRate: number;
	loudSec: number;
	totalSec: number;
	freq?: number;
	amp?: number;
}): Float32Array {
	const n = Math.round(totalSec * sampleRate);
	const loudN = Math.round(loudSec * sampleRate);
	const out = new Float32Array(n);
	for (let i = 0; i < loudN; i++) {
		out[i] = amp * Math.sin((2 * Math.PI * freq * i) / sampleRate);
	}
	return out;
}

describe("buildFixtureAudioFeatures", () => {
	const sampleRate = 16000;

	test("sine+silence yields nonzero loudness on speech and plausible wpm", () => {
		const samples = sineThenSilence({ sampleRate, loudSec: 3, totalSec: 5 });
		// Segment 0 sits over the loud sine (5 words), segment 1 over the silence.
		const segments = [
			{ text: "this is a spoken line", start: 0, end: 3 },
			{ text: "quiet", start: 3.5, end: 4.5 },
		];
		const { envelope, features } = buildFixtureAudioFeatures({
			samples,
			sampleRate,
			segments,
		});

		// Envelope length matches the hop math: floor(N / round(windowSec*rate)).
		const windowSize = Math.round(FIXTURE_ENVELOPE_WINDOW_SEC * sampleRate);
		expect(envelope.length).toBe(Math.floor(samples.length / windowSize));

		expect(features).toHaveLength(2);
		// The spoken segment carries real energy; the silent one is near zero.
		expect(features[0].energy).toBeGreaterThan(0);
		expect(features[0].loudnessRelative).toBeGreaterThan(features[1].loudnessRelative);
		// 5 words over 3 seconds ≈ 100 wpm.
		expect(features[0].wpm).toBeGreaterThan(50);
		expect(features[0].wordCount).toBe(5);
	});

	test("a clip with no segments yields empty features without crashing", () => {
		const samples = sineThenSilence({ sampleRate, loudSec: 1, totalSec: 2 });
		const { envelope, features } = buildFixtureAudioFeatures({
			samples,
			sampleRate,
			segments: [],
		});
		expect(features).toEqual([]);
		expect(envelope.length).toBeGreaterThan(0);
	});

	test("stored values are rounded to 3 decimals for JSON size", () => {
		const samples = sineThenSilence({ sampleRate, loudSec: 2, totalSec: 2 });
		const { envelope, features } = buildFixtureAudioFeatures({
			samples,
			sampleRate,
			segments: [{ text: "hello there friend", start: 0, end: 2 }],
		});
		for (const v of envelope) {
			expect(v).toBe(Math.round(v * 1000) / 1000);
		}
		expect(features[0].energy).toBe(Math.round(features[0].energy * 1000) / 1000);
	});
});
