import { describe, expect, test } from "bun:test";
import {
	planAuthorChunks,
	MAX_CHUNKS,
	VARIANT_CHUNK_SEC,
} from "../chunk-plan";

function assertContiguousCoverage(
	chunks: { startSec: number; endSec: number }[],
	totalSec: number,
): void {
	expect(chunks[0].startSec).toBe(0);
	expect(chunks[chunks.length - 1].endSec).toBeCloseTo(totalSec, 5);
	for (let i = 1; i < chunks.length; i++) {
		// No gaps, no overlaps.
		expect(chunks[i].startSec).toBeCloseTo(chunks[i - 1].endSec, 5);
	}
}

describe("planAuthorChunks", () => {
	test("8-min video → 6 even chunks covering the whole timeline", () => {
		const chunks = planAuthorChunks(480); // ceil(480/90) = 6
		expect(chunks.length).toBe(6);
		assertContiguousCoverage(chunks, 480);
		// Even length.
		const len = chunks[0].endSec - chunks[0].startSec;
		for (const c of chunks) expect(c.endSec - c.startSec).toBeCloseTo(len, 5);
		expect(len).toBeCloseTo(80, 5);
	});

	test("short video → a single chunk", () => {
		const chunks = planAuthorChunks(30);
		expect(chunks.length).toBe(1);
		expect(chunks[0].startSec).toBe(0);
		expect(chunks[0].endSec).toBe(30);
	});

	test("variant (coarser) target yields fewer chunks", () => {
		const chunks = planAuthorChunks(480, VARIANT_CHUNK_SEC); // ceil(480/150) = 4
		expect(chunks.length).toBe(4);
		assertContiguousCoverage(chunks, 480);
	});

	test("never exceeds MAX_CHUNKS, still covers the whole timeline", () => {
		const chunks = planAuthorChunks(100_000);
		expect(chunks.length).toBe(MAX_CHUNKS);
		assertContiguousCoverage(chunks, 100_000);
	});

	test("indices are sequential from 0", () => {
		const chunks = planAuthorChunks(300);
		chunks.forEach((c, i) => expect(c.index).toBe(i));
	});
});
