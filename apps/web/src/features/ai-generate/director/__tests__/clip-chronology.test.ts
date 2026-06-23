import { describe, expect, test } from "bun:test";
import { parseClipTimestamp, planChronologicalReorder, type ChronoClip } from "../clip-chronology";

describe("parseClipTimestamp", () => {
	test("parses the 'YYYY-MM-DD HH-MM-SS' form Dan's recorder uses", () => {
		const a = parseClipTimestamp("2026-06-22 23-37-45.mp4");
		const b = parseClipTimestamp("2026-06-22 23-37-46.mp4");
		expect(a).not.toBeNull();
		expect(b).not.toBeNull();
		expect((b ?? 0) > (a ?? 0)).toBe(true); // one second later sorts later
	});

	test("orders across days/months/years monotonically", () => {
		const ordered = [
			"2025-12-31 23-59-59.mp4",
			"2026-01-01 00-00-00.mp4",
			"2026-06-22 23-37-45.mp4",
		].map((n) => parseClipTimestamp(n) ?? 0);
		expect(ordered[0]).toBeLessThan(ordered[1]);
		expect(ordered[1]).toBeLessThan(ordered[2]);
	});

	test("parses compact 'YYYYMMDD_HHMMSS' and colon/dot time separators", () => {
		expect(parseClipTimestamp("VID_20260622_233745.mov")).not.toBeNull();
		expect(parseClipTimestamp("2026-06-22T23:37:45.mp4")).not.toBeNull();
		expect(parseClipTimestamp("2026-06-22 23.37.45.mp4")).not.toBeNull();
	});

	test("returns null when there is no timestamp or it is out of range", () => {
		expect(parseClipTimestamp("my cool clip.mp4")).toBeNull();
		expect(parseClipTimestamp("clip-0001.mp4")).toBeNull();
		expect(parseClipTimestamp("2026-13-40 99-99-99.mp4")).toBeNull(); // impossible fields
	});

	test("ignores a split suffix on the name", () => {
		// after a split the editor appends "(left)"/"(right)" — the timestamp still parses
		expect(parseClipTimestamp("2026-06-22 23-37-45 (left).mp4")).not.toBeNull();
	});
});

const clip = ({
	elementId,
	name,
	startTimeTicks,
	durationTicks = 1000,
}: {
	elementId: string;
	name: string;
	startTimeTicks: number;
	durationTicks?: number;
}): ChronoClip => ({ elementId, name, startTimeTicks, durationTicks });

describe("planChronologicalReorder", () => {
	test("reorders reverse-placed clips back-to-back in timestamp order", () => {
		// Placed newest-first (reverse); timestamps say the order should flip.
		const clips = [
			clip({ elementId: "c", name: "2026-06-22 23-37-47.mp4", startTimeTicks: 0, durationTicks: 1000 }),
			clip({ elementId: "b", name: "2026-06-22 23-37-46.mp4", startTimeTicks: 1000, durationTicks: 2000 }),
			clip({ elementId: "a", name: "2026-06-22 23-37-45.mp4", startTimeTicks: 3000, durationTicks: 500 }),
		];
		const moves = planChronologicalReorder({ clips });
		expect(moves).not.toBeNull();
		// Chronological order is a, b, c → laid back-to-back from 0.
		expect(moves).toEqual([
			{ elementId: "a", newStartTimeTicks: 0 },
			{ elementId: "b", newStartTimeTicks: 500 },
			{ elementId: "c", newStartTimeTicks: 2500 },
		]);
	});

	test("returns null when already in chronological order", () => {
		const clips = [
			clip({ elementId: "a", name: "2026-06-22 23-37-45.mp4", startTimeTicks: 0 }),
			clip({ elementId: "b", name: "2026-06-22 23-37-46.mp4", startTimeTicks: 1000 }),
		];
		expect(planChronologicalReorder({ clips })).toBeNull();
	});

	test("returns null when not every clip has a timestamp (defer to content)", () => {
		const clips = [
			clip({ elementId: "a", name: "2026-06-22 23-37-46.mp4", startTimeTicks: 0 }),
			clip({ elementId: "b", name: "intro.mp4", startTimeTicks: 1000 }),
		];
		expect(planChronologicalReorder({ clips })).toBeNull();
	});

	test("returns null when all timestamps are identical (ambiguous)", () => {
		const clips = [
			clip({ elementId: "a", name: "2026-06-22 23-37-45.mp4", startTimeTicks: 1000 }),
			clip({ elementId: "b", name: "2026-06-22 23-37-45.mp4", startTimeTicks: 0 }),
		];
		expect(planChronologicalReorder({ clips })).toBeNull();
	});

	test("returns null for fewer than 2 clips", () => {
		expect(
			planChronologicalReorder({
				clips: [clip({ elementId: "a", name: "2026-06-22 23-37-45.mp4", startTimeTicks: 0 })],
			}),
		).toBeNull();
	});
});
