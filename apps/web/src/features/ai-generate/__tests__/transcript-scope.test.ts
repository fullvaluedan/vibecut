import { describe, expect, test } from "bun:test";
import {
	scopeSegments,
	hasAuthorableContent,
	type TranscriptSegment,
} from "../transcript-scope";

/** Six 100s segments spanning [0, 600), text = its index for easy assertions. */
const SEGMENTS: TranscriptSegment[] = Array.from({ length: 6 }, (_, i) => ({
	start: i * 100,
	end: (i + 1) * 100,
	text: `seg${i}`,
}));

describe("scopeSegments", () => {
	test("happy path: [300,400] returns only overlapping segments, offset to 0", () => {
		const out = scopeSegments(SEGMENTS, 300, 400);
		// Only seg3 ([300,400)) overlaps; offset to 0 → [0.0–100.0].
		expect(out).toBe("[0.0–100.0] seg3");
	});

	test("a window spanning two segments returns both, each offset to the window start", () => {
		const out = scopeSegments(SEGMENTS, 150, 350);
		// seg1 [100,200), seg2 [200,300), seg3 [300,400) all overlap [150,350).
		expect(out).toBe(
			["[0.0–50.0] seg1", "[50.0–150.0] seg2", "[150.0–250.0] seg3"].join("\n"),
		);
	});

	test("boundary: strict > / < excludes segments touching only at the edge", () => {
		// Window [100,200): seg0 ends exactly at 100 (end > start is false → excluded),
		// seg2 starts exactly at 200 (start < end is false → excluded). Only seg1 in.
		const out = scopeSegments(SEGMENTS, 100, 200);
		expect(out).toBe("[0.0–100.0] seg1");
	});

	test("whole-video parity: [0,total] returns every segment (variant-path window)", () => {
		const out = scopeSegments(SEGMENTS, 0, 600);
		expect(out.split("\n")).toHaveLength(SEGMENTS.length);
		expect(out).toContain("seg0");
		expect(out).toContain("seg5");
	});

	test("empty source returns '' for any window", () => {
		expect(scopeSegments([], 0, 600)).toBe("");
		expect(scopeSegments([], 300, 400)).toBe("");
	});

	test("out-of-range window past the last segment returns '' (drives silent-chunk skip)", () => {
		expect(scopeSegments(SEGMENTS, 900, 1000)).toBe("");
	});

	test("text is trimmed and negative offsets are clamped to 0", () => {
		const segs: TranscriptSegment[] = [{ start: 50, end: 150, text: "  hi  " }];
		// Window starts after the segment start → offset would be negative, clamped to 0.
		const out = scopeSegments(segs, 100, 200);
		expect(out).toBe("[0.0–50.0] hi");
	});
});

describe("hasAuthorableContent", () => {
	test("empty transcript + empty direction → false", () => {
		expect(hasAuthorableContent("", "")).toBe(false);
	});

	test("non-empty transcript → true", () => {
		expect(hasAuthorableContent("[0.0–1.0] hello", "")).toBe(true);
	});

	test("empty transcript + non-empty direction → true", () => {
		expect(hasAuthorableContent("", "make it bold")).toBe(true);
	});

	test("whitespace-only both → false", () => {
		expect(hasAuthorableContent("   \n  ", "  \t ")).toBe(false);
	});
});
