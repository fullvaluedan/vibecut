import { describe, expect, test } from "bun:test";
import { planAudioChunks } from "../audio";

/** P0.4 window math: exact cover, no gaps/overlap, partial last chunk. */
describe("planAudioChunks", () => {
	test("splits with a partial last chunk", () => {
		const chunks = planAudioChunks({ totalFrames: 250, chunkFrames: 100 });
		expect(chunks).toEqual([
			{ startFrame: 0, frames: 100 },
			{ startFrame: 100, frames: 100 },
			{ startFrame: 200, frames: 50 },
		]);
	});

	test("an exact multiple has no empty tail chunk", () => {
		const chunks = planAudioChunks({ totalFrames: 200, chunkFrames: 100 });
		expect(chunks).toHaveLength(2);
		expect(chunks.at(-1)).toEqual({ startFrame: 100, frames: 100 });
	});

	test("a timeline shorter than one window is a single chunk", () => {
		expect(planAudioChunks({ totalFrames: 30, chunkFrames: 100 })).toEqual([
			{ startFrame: 0, frames: 30 },
		]);
	});

	test("degenerate inputs produce no chunks", () => {
		expect(planAudioChunks({ totalFrames: 0, chunkFrames: 100 })).toEqual([]);
		expect(planAudioChunks({ totalFrames: 100, chunkFrames: 0 })).toEqual([]);
	});

	test("windows cover every frame exactly once (property check)", () => {
		for (const [total, size] of [
			[44100 * 125, 44100 * 60],
			[7, 3],
			[1, 1],
		] as const) {
			const chunks = planAudioChunks({ totalFrames: total, chunkFrames: size });
			let cursor = 0;
			for (const c of chunks) {
				expect(c.startFrame).toBe(cursor);
				expect(c.frames).toBeGreaterThan(0);
				cursor += c.frames;
			}
			expect(cursor).toBe(total);
		}
	});
});
