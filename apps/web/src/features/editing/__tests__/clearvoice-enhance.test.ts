import { describe, expect, test } from "bun:test";
import { mediaTimeFromSeconds } from "@/wasm";
import {
	computeVisibleSourceSpanSeconds,
	encodeWavBlob,
	sliceSourceSamples,
} from "../clearvoice-enhance";

describe("computeVisibleSourceSpanSeconds", () => {
	test("equals duration at normal speed", () => {
		expect(
			computeVisibleSourceSpanSeconds({
				element: {
					duration: mediaTimeFromSeconds({ seconds: 10 }),
				},
			}),
		).toBeCloseTo(10, 5);
	});

	test("halves for a 2x speed clip", () => {
		expect(
			computeVisibleSourceSpanSeconds({
				element: {
					duration: mediaTimeFromSeconds({ seconds: 10 }),
					retime: { rate: 2 },
				},
			}),
		).toBeCloseTo(5, 5);
	});

	test("protects against a zero rate", () => {
		expect(
			computeVisibleSourceSpanSeconds({
				element: {
					duration: mediaTimeFromSeconds({ seconds: 10 }),
					retime: { rate: 0 },
				},
			}),
		).toBeCloseTo(10, 5);
	});
});

describe("sliceSourceSamples", () => {
	test("slices the requested source span", () => {
		const samples = new Float32Array(10 * 16_000).fill(0.5);
		const sliced = sliceSourceSamples({
			samples,
			sampleRate: 16_000,
			startSec: 2,
			spanSec: 3,
		});
		expect(sliced.length).toBe(48_000);
		expect(sliced[0]).toBe(0.5);
	});

	test("clamps past the end of the source", () => {
		const samples = new Float32Array(10_000);
		const sliced = sliceSourceSamples({
			samples,
			sampleRate: 16_000,
			startSec: 0.5,
			spanSec: 10,
		});
		expect(sliced.length).toBe(2_000);
	});

	test("never returns an empty slice when the source has samples", () => {
		const sliced = sliceSourceSamples({
			samples: new Float32Array(16_000),
			sampleRate: 16_000,
			startSec: 99,
			spanSec: 0,
		});
		expect(sliced.length).toBeGreaterThan(0);
	});
});

describe("encodeWavBlob", () => {
	test("writes a valid 16k mono 16-bit PCM header", async () => {
		const blob = encodeWavBlob({
			samples: new Float32Array(16_000).fill(0),
			sampleRate: 16_000,
		});
		expect(blob.type).toBe("audio/wav");
		const buffer = new Uint8Array(await blob.arrayBuffer());
		const view = new DataView(buffer.buffer);
		expect(new TextDecoder().decode(buffer.subarray(0, 4))).toBe("RIFF");
		expect(new TextDecoder().decode(buffer.subarray(8, 12))).toBe("WAVE");
		expect(view.getUint32(4, true)).toBe(36 + 16_000 * 2);
		expect(view.getUint16(22, true)).toBe(1); // mono
		expect(view.getUint32(24, true)).toBe(16_000); // sample rate
		expect(view.getUint16(34, true)).toBe(16); // bits per sample
		expect(view.getUint32(40, true)).toBe(16_000 * 2); // data size
		expect(buffer.length).toBe(44 + 16_000 * 2);
	});

	test("clamps samples to the [-1, 1] range", async () => {
		const blob = encodeWavBlob({
			samples: new Float32Array([-2, 0, 2]),
			sampleRate: 8_000,
		});
		const buffer = new Uint8Array(await blob.arrayBuffer());
		const view = new DataView(buffer.buffer);
		expect(view.getInt16(44, true)).toBe(-0x8000);
		expect(view.getInt16(48, true)).toBe(0x7fff);
	});
});
