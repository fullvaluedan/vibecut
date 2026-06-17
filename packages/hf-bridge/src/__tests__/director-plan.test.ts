import { describe, expect, test } from "bun:test";
import {
	buildDirectorPrompt,
	renderSignalTable,
	sanitizeDirectorPlan,
	type DirectorSegment,
} from "../author";

const seg = (
	overrides: Partial<DirectorSegment> & Pick<DirectorSegment, "startSec" | "endSec" | "text">,
): DirectorSegment => overrides;

describe("renderSignalTable", () => {
	test("renders one row per segment and escapes pipes in text", () => {
		const table = renderSignalTable([
			seg({ startSec: 0, endSec: 2, text: "a | b", assetId: "take1abc", wpm: 140, loudnessRelative: 1, fillerCandidate: false }),
			seg({ startSec: 2, endSec: 4, text: "um uh", assetId: "take2def", wpm: 60, loudnessRelative: 0.1, fillerCandidate: true, silenceBeforeSec: 0.5 }),
		]);
		const lines = table.split("\n");
		expect(lines[0]).toContain("time (s)");
		expect(lines).toHaveLength(4); // header + separator + 2 rows
		expect(table).toContain("a / b"); // pipe escaped
		expect(table).toContain("take1a"); // src truncated to 6
		expect(table).toContain("yes"); // filler flag
	});
});

describe("buildDirectorPrompt", () => {
	const segments = [seg({ startSec: 0, endSec: 2, text: "hello", wpm: 120 })];

	test("includes the op instructions, the table, and the total duration", () => {
		const prompt = buildDirectorPrompt({ segments, totalSec: 12.5 });
		expect(prompt).toContain("take_select");
		expect(prompt).toContain("reorder");
		expect(prompt).toContain("SIGNAL TABLE:");
		expect(prompt).toContain("12.50");
		expect(prompt).toContain('"operations"');
	});

	test("injects the taste note only when provided", () => {
		expect(buildDirectorPrompt({ segments, totalSec: 12 })).not.toContain("EDITOR TASTE");
		const withTaste = buildDirectorPrompt({
			segments,
			totalSec: 12,
			taste: "be conservative with tangent-cuts",
		});
		expect(withTaste).toContain("EDITOR TASTE");
		expect(withTaste).toContain("be conservative with tangent-cuts");
	});
});

describe("sanitizeDirectorPlan", () => {
	test("happy path: a cut + a reorder survive, schema-valid, with stable ids", () => {
		const raw = {
			operations: [
				{ op: "cut", startSec: 3, endSec: 5, reason: "filler", confidence: 0.8 },
				{ op: "reorder", startSec: 8, endSec: 10, targetStartSec: 0, reason: "hook to front", confidence: 0.6 },
			],
		};
		const { operations } = sanitizeDirectorPlan(raw, 12);
		expect(operations).toHaveLength(2);
		expect(operations[0].op).toBe("cut");
		expect(operations[1].op).toBe("reorder");
		expect(operations[1].targetStartSec).toBe(0);
		expect(operations.every((o) => o.id.startsWith("op_"))).toBe(true);
	});

	test("drops overlapping removals (cut/take_select), keeping the earlier one", () => {
		const raw = {
			operations: [
				{ op: "cut", startSec: 2, endSec: 6, reason: "a", confidence: 0.9 },
				{ op: "take_select", startSec: 4, endSec: 8, reason: "weaker take", confidence: 0.7 },
				{ op: "cut", startSec: 9, endSec: 10, reason: "b", confidence: 0.9 },
			],
		};
		const { operations } = sanitizeDirectorPlan(raw, 12);
		// The [4,8) take_select overlaps the [2,6) cut -> dropped; the [9,10) cut survives.
		expect(operations.map((o) => [o.op, o.startSec, o.endSec])).toEqual([
			["cut", 2, 6],
			["cut", 9, 10],
		]);
	});

	test("drops reversed and clamps out-of-bounds ranges", () => {
		const raw = {
			operations: [
				{ op: "cut", startSec: 5, endSec: 3, reason: "reversed", confidence: 1 }, // dropped (end<=start)
				{ op: "cut", startSec: -2, endSec: 99, reason: "oob", confidence: 1 }, // clamped to [0,12]
			],
		};
		const { operations } = sanitizeDirectorPlan(raw, 12);
		expect(operations).toHaveLength(1);
		expect([operations[0].startSec, operations[0].endSec]).toEqual([0, 12]);
	});

	test("drops a reorder whose target is out of bounds", () => {
		const raw = {
			operations: [
				{ op: "reorder", startSec: 8, endSec: 10, targetStartSec: 99, reason: "bad target", confidence: 0.6 },
			],
		};
		expect(sanitizeDirectorPlan(raw, 12).operations).toHaveLength(0);
	});

	test("ids are stable across re-sanitization of the same output", () => {
		const raw = {
			operations: [{ op: "cut", startSec: 3, endSec: 5, reason: "x", confidence: 0.8 }],
		};
		const a = sanitizeDirectorPlan(raw, 12).operations[0].id;
		const b = sanitizeDirectorPlan(raw, 12).operations[0].id;
		expect(a).toBe(b);
	});

	test("empty operations stays empty; a missing array throws", () => {
		expect(sanitizeDirectorPlan({ operations: [] }, 12).operations).toEqual([]);
		expect(() => sanitizeDirectorPlan({}, 12)).toThrow(/no operations array/);
	});
});
