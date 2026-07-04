import { describe, expect, it } from "bun:test";
import { canExport } from "@/export/can-export";

/**
 * ExportButton reads this guard from `editor.timeline.getTotalDuration()` and
 * short-circuits BEFORE pickSaveLocation (U8), so an empty project fails
 * immediately instead of showing a save dialog only to fail with
 * "Project is empty". Imported from the leaf (not the @/export barrel) so the
 * test stays free of the wasm pull-in.
 */
describe("canExport", () => {
	it("is false for a zero-duration (empty) timeline", () => {
		expect(canExport({ durationTicks: 0 })).toBe(false);
	});

	it("is true for a non-empty timeline", () => {
		expect(canExport({ durationTicks: 90_000 })).toBe(true);
	});

	it("is false for a negative duration (defensive)", () => {
		expect(canExport({ durationTicks: -1 })).toBe(false);
	});
});
