import { describe, expect, test } from "bun:test";
import { resolveTrimVsCut } from "../resolve-trim-vs-cut";
import type { DirectorOp } from "@framecut/hf-bridge";

const cut = (startSec: number, endSec: number): DirectorOp => ({
	id: `c-${startSec}-${endSec}`,
	op: "cut",
	startSec,
	endSec,
	reason: "r",
	confidence: 0.8,
});

// 30fps: 3 frames = 0.1s. Tolerance of 0.2s (6 frames) covers it.
const TOL = 0.2;

describe("resolveTrimVsCut (U4/KTD4)", () => {
	test("a removal ending 3 frames inside a clip trailing edge becomes a trim", () => {
		// Clip [0,5]; removal ends at 4.9 (0.1s short of the clip end) -> snapped to 5.0.
		const [op] = resolveTrimVsCut({
			ops: [cut(2, 4.9)],
			clipStartsSec: [0],
			clipEndsSec: [5],
			toleranceSec: TOL,
		});
		expect(op.endSec).toBeCloseTo(5, 5); // trimmed to the clip edge (no sliver)
		expect(op.startSec).toBe(2); // interior start untouched
	});

	test("a removal starting 3 frames inside a clip leading edge becomes a trim", () => {
		// Clip starts at 10; removal starts at 10.1 -> snapped back to 10.0.
		const [op] = resolveTrimVsCut({
			ops: [cut(10.1, 13)],
			clipStartsSec: [10],
			clipEndsSec: [20],
			toleranceSec: TOL,
		});
		expect(op.startSec).toBeCloseTo(10, 5);
	});

	test("an interior removal (both edges mid-clip) stays a ripple-cut (unchanged)", () => {
		const [op] = resolveTrimVsCut({
			ops: [cut(3, 5)],
			clipStartsSec: [0],
			clipEndsSec: [10], // nearest boundaries are 3s / 5s away, beyond tolerance
			toleranceSec: TOL,
		});
		expect(op.startSec).toBe(3);
		expect(op.endSec).toBe(5);
	});

	test("a removal already at the exact boundary stays put (already a trim)", () => {
		const [op] = resolveTrimVsCut({
			ops: [cut(2, 5)],
			clipStartsSec: [0],
			clipEndsSec: [5], // end already ON the clip edge
			toleranceSec: TOL,
		});
		expect(op.endSec).toBe(5); // unchanged; coincident with the boundary = a trim
	});

	test("a non-removal op passes through untouched", () => {
		const reorder: DirectorOp = {
			id: "r",
			op: "reorder",
			startSec: 8,
			endSec: 10,
			targetStartSec: 0,
			reason: "hook",
			confidence: 0.6,
		};
		const [op] = resolveTrimVsCut({
			ops: [reorder],
			clipStartsSec: [8],
			clipEndsSec: [10],
			toleranceSec: TOL,
		});
		expect(op).toEqual(reorder);
	});
});
