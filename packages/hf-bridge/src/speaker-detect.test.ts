import { describe, expect, it } from "bun:test";
import { safeZoneFromModelFrames, sanitizeOccupies } from "./speaker-detect.ts";

describe("sanitizeOccupies", () => {
	it("keeps valid zones, drops junk, de-dupes", () => {
		expect(sanitizeOccupies(["left", "left", "nope", 3, "center"])).toEqual([
			"left",
			"center",
		]);
	});
	it("non-array → empty", () => {
		expect(sanitizeOccupies("left")).toEqual([]);
		expect(sanitizeOccupies(null)).toEqual([]);
	});
});

describe("safeZoneFromModelFrames", () => {
	it("centered across all frames → both sides safe", () => {
		const z = safeZoneFromModelFrames({
			frames: [{ occupies: ["center"] }, { occupies: ["center"] }],
		});
		expect(z.safeColumns).toEqual(["left", "right"]);
		expect(z.bandOnly).toBe(false);
	});
	it("moving speaker → band-only", () => {
		const z = safeZoneFromModelFrames({
			frames: [{ occupies: ["left"] }, { occupies: ["right"] }],
		});
		expect(z.bandOnly).toBe(true);
		expect(z.instruction).toMatch(/LOWER-THIRD band/);
	});
	it("malformed model output → conservative unknown band", () => {
		expect(safeZoneFromModelFrames(null).bandOnly).toBe(true);
		expect(safeZoneFromModelFrames({}).bandOnly).toBe(true);
		expect(safeZoneFromModelFrames({ frames: "x" }).bandOnly).toBe(true);
	});
});
