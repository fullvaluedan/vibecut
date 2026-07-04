import { describe, expect, it } from "bun:test";
import { computeSafeZone } from "./speaker-zone.ts";

describe("computeSafeZone", () => {
	it("centered static speaker → both side columns safe, not band-only", () => {
		const z = computeSafeZone([
			{ timeSec: 0, occupies: ["center"] },
			{ timeSec: 1.5, occupies: ["center"] },
			{ timeSec: 3, occupies: ["center"] },
		]);
		expect(z.safeColumns).toEqual(["left", "right"]);
		expect(z.bandOnly).toBe(false);
		expect(z.occupiedAcrossClip).toEqual(["center"]);
	});

	it("speaker MOVES left→center→right → no safe column, falls back to band", () => {
		const z = computeSafeZone([
			{ timeSec: 0, occupies: ["left"] },
			{ timeSec: 1.5, occupies: ["center"] },
			{ timeSec: 3, occupies: ["right"] },
		]);
		expect(z.safeColumns).toEqual([]);
		expect(z.bandOnly).toBe(true);
		expect(z.instruction).toMatch(/LOWER-THIRD band/);
		expect(z.instruction).toMatch(/full width/);
	});

	it("off-center speaker on the right → left third stays clear", () => {
		const z = computeSafeZone([
			{ timeSec: 0, occupies: ["right"] },
			{ timeSec: 2, occupies: ["center", "right"] },
		]);
		expect(z.safeColumns).toEqual(["left"]);
		expect(z.bandOnly).toBe(false);
		expect(z.instruction).toMatch(/left third/);
		expect(z.instruction).toMatch(/Do not drift/);
	});

	it("a single safe column that disappears in a later frame is NOT reported safe", () => {
		// left clear at t=0 but speaker steps left at t=2 → left no longer safe.
		const z = computeSafeZone([
			{ timeSec: 0, occupies: ["right"] },
			{ timeSec: 2, occupies: ["left", "center", "right"] },
		]);
		expect(z.safeColumns).toEqual([]);
		expect(z.bandOnly).toBe(true);
	});

	it("no frames (detection unavailable) → conservative band-only, unknown wording", () => {
		const z = computeSafeZone([]);
		expect(z.bandOnly).toBe(true);
		expect(z.instruction).toMatch(/position unknown/);
		expect(z.instruction).toMatch(/LOWER-THIRD band/);
	});
});
