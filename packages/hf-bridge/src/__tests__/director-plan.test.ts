import { describe, expect, test } from "bun:test";
import {
	buildDirectorPrompt,
	renderAssetCatalog,
	renderSignalTable,
	sanitizeDirectorPlan,
	type DirectorAssetSummary,
	type DirectorSegment,
} from "../author";

const seg = (
	overrides: Partial<DirectorSegment> & Pick<DirectorSegment, "startSec" | "endSec" | "text">,
): DirectorSegment => overrides;

const CATALOG: DirectorAssetSummary[] = [
	{ name: "intro-take.mp4", durationSec: 30, segmentCount: 4, firstLine: "hey everyone", lastLine: "let's go" },
	{ name: "outro-take.mp4", durationSec: 20, segmentCount: 2, firstLine: "thanks for watching", lastLine: "see ya" },
];

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

	test("omits the grp column when no segment is clustered (byte-identical header)", () => {
		const table = renderSignalTable([seg({ startSec: 0, endSec: 2, text: "hi" })]);
		expect(table.split("\n")[0]).toBe("| time (s) | src | text | loudness | wpm | filler | silence(s) |");
		expect(table).not.toContain("grp");
	});

	test("adds a grp column when a segment carries a clusterId", () => {
		const table = renderSignalTable([
			seg({ startSec: 0, endSec: 2, text: "today we ship", clusterId: "C1" }),
			seg({ startSec: 2, endSec: 4, text: "today we ship", clusterId: "C1" }),
		]);
		expect(table.split("\n")[0]).toContain(" grp ");
		// Both rows carry the cluster id.
		expect(table.match(/C1/g)).toHaveLength(2);
	});
});

describe("renderAssetCatalog", () => {
	test("lists each clip with name, duration, and line count", () => {
		const block = renderAssetCatalog(CATALOG);
		expect(block).toContain("ASSET CATALOG");
		expect(block).toContain('"intro-take.mp4" (30.0s, 4 lines)');
		expect(block).toContain('"outro-take.mp4" (20.0s, 2 lines)');
		expect(block).toContain('opens "hey everyone"');
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

	test("renders the asset catalog block for multi-clip input only", () => {
		expect(buildDirectorPrompt({ segments, totalSec: 12, catalog: CATALOG })).toContain(
			"ASSET CATALOG",
		);
		// A single-clip catalog is omitted (keeps the single-recording prompt lean).
		expect(
			buildDirectorPrompt({ segments, totalSec: 12, catalog: [CATALOG[0]] }),
		).not.toContain("ASSET CATALOG");
		// No catalog at all → no block.
		expect(buildDirectorPrompt({ segments, totalSec: 12 })).not.toContain("ASSET CATALOG");
	});

	test("adds the grp de-dup rule only when a segment is clustered", () => {
		const clustered = [seg({ startSec: 0, endSec: 2, text: "today we ship", clusterId: "C1" })];
		const withClusters = buildDirectorPrompt({ segments: clustered, totalSec: 12 });
		expect(withClusters).toContain('Rows sharing a "grp" id');
		// No clusters → no de-dup rule (and the prompt is otherwise unchanged).
		expect(buildDirectorPrompt({ segments, totalSec: 12 })).not.toContain('Rows sharing a "grp" id');
	});

	test("adds the compression contract block ONLY when compressionTarget is present (U3)", () => {
		const withTarget = buildDirectorPrompt({ segments, totalSec: 12, compressionTarget: 0.585 });
		expect(withTarget).toContain("COMPRESSION TARGET");
		expect(withTarget).toContain("59%"); // round(0.585 * 100)
		expect(buildDirectorPrompt({ segments, totalSec: 12 })).not.toContain("COMPRESSION TARGET");
	});

	test("absent compressionTarget is byte-identical to omitting the field entirely (U3 pin)", () => {
		const omitted = buildDirectorPrompt({ segments, totalSec: 12 });
		const explicitUndefined = buildDirectorPrompt({
			segments,
			totalSec: 12,
			compressionTarget: undefined,
		});
		expect(explicitUndefined).toBe(omitted);
	});

	test("compressionTarget stacks with the taste note without splitting it (U3)", () => {
		const both = buildDirectorPrompt({
			segments,
			totalSec: 12,
			taste: "be conservative with tangent-cuts",
			compressionTarget: 0.4,
		});
		expect(both).toContain("EDITOR TASTE");
		expect(both).toContain("be conservative with tangent-cuts"); // pinned substring intact
		expect(both).toContain("COMPRESSION TARGET");
		expect(both).toContain("40%");
	});

	test("out-of-range compressionTarget is clamped into [0, 0.8] (U3)", () => {
		expect(buildDirectorPrompt({ segments, totalSec: 12, compressionTarget: 0.95 })).toContain(
			"80%",
		);
		expect(buildDirectorPrompt({ segments, totalSec: 12, compressionTarget: -0.3 })).toContain(
			"0%",
		);
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

describe("renderSignalTable — importance (keep-side)", () => {
	test("adds an imp column when a segment carries importance; byte-identical when absent", () => {
		const withImp = renderSignalTable([seg({ startSec: 0, endSec: 2, text: "hi", importance: 0.83 })]);
		expect(withImp.split("\n")[0]).toContain(" imp ");
		expect(withImp).toContain("0.83");
		const without = renderSignalTable([seg({ startSec: 0, endSec: 2, text: "hi" })]);
		expect(without).not.toContain("imp");
		expect(without.split("\n")[0]).toBe("| time (s) | src | text | loudness | wpm | filler | silence(s) |");
	});

	test("grp and imp columns coexist", () => {
		const header = renderSignalTable([
			seg({ startSec: 0, endSec: 2, text: "hi", clusterId: "C1", importance: 0.5 }),
		]).split("\n")[0];
		expect(header).toContain(" grp ");
		expect(header).toContain(" imp ");
	});
});

describe("buildDirectorPrompt — importance (keep-side)", () => {
	test("adds the imp guidance only when importance is present", () => {
		const withImp = buildDirectorPrompt({
			segments: [seg({ startSec: 0, endSec: 2, text: "hi", importance: 0.7 })],
			totalSec: 12,
		});
		expect(withImp).toContain('"imp" score');
		const without = buildDirectorPrompt({
			segments: [seg({ startSec: 0, endSec: 2, text: "hi" })],
			totalSec: 12,
		});
		expect(without).not.toContain('"imp" score');
	});

	test("asks for load-bearing keep ops only when importance is present (U4)", () => {
		const withImp = buildDirectorPrompt({
			segments: [seg({ startSec: 0, endSec: 2, text: "hi", importance: 0.7 })],
			totalSec: 12,
		});
		expect(withImp).toContain('Emit "keep" ops on the genuinely LOAD-BEARING');
		const without = buildDirectorPrompt({
			segments: [seg({ startSec: 0, endSec: 2, text: "hi" })],
			totalSec: 12,
		});
		expect(without).not.toContain("LOAD-BEARING");
	});
});
