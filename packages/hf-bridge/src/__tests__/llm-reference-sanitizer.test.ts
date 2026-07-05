import { describe, expect, test } from "bun:test";
import {
	resolveReferencedOps,
	sanitizeReferencedPlan,
	type ReferenceCatalog,
} from "../llm-reference-sanitizer";

const TPS = 120_000; // matches @/wasm TICKS_PER_SECOND
const sec = (s: number) => Math.round(s * TPS);

// Lines L0..L2 and a parallel words[] for word-index refs.
const catalog: ReferenceCatalog = {
	lines: [
		{ lineId: "L0", startSec: 0, endSec: 2 },
		{ lineId: "L1", startSec: 2, endSec: 5 },
		{ lineId: "L2", startSec: 5, endSec: 9 },
	],
	words: [
		{ startSec: 0.0, endSec: 0.4 }, // w0
		{ startSec: 0.4, endSec: 0.9 }, // w1
		{ startSec: 1.0, endSec: 1.6 }, // w2
		{ startSec: 2.0, endSec: 2.5 }, // w3
	],
};

describe("resolveReferencedOps — happy path (scenario 1)", () => {
	test("a valid line-id span resolves to L0.start .. L1.end", () => {
		const [op] = resolveReferencedOps({
			rawOps: [
				{ op: "cut", startLineId: "L0", endLineId: "L1", reason: "a", confidence: 0.9 },
			],
			catalog,
			ticksPerSecond: TPS,
		});
		expect(op).toMatchObject({ startTicks: sec(0), endTicks: sec(5), op: "cut" });
	});

	test("a valid word-index span resolves to w1.start .. w2.end", () => {
		const [op] = resolveReferencedOps({
			rawOps: [{ op: "cut", startWord: 1, endWord: 2, reason: "b", confidence: 0.8 }],
			catalog,
			ticksPerSecond: TPS,
		});
		expect(op).toMatchObject({ startTicks: sec(0.4), endTicks: sec(1.6) });
	});

	test("two non-overlapping refs both survive, in start order", () => {
		const ops = resolveReferencedOps({
			rawOps: [
				{ startLineId: "L2", endLineId: "L2" }, // 5..9
				{ startWord: 0, endWord: 1 }, // 0..0.9
			],
			catalog,
			ticksPerSecond: TPS,
		});
		expect(ops.map((o) => [o.startTicks, o.endTicks])).toEqual([
			[sec(0), sec(0.9)],
			[sec(5), sec(9)],
		]);
	});

	test("a single-line span resolves to that line's own range", () => {
		const [op] = resolveReferencedOps({
			rawOps: [{ startLineId: "L2", endLineId: "L2" }],
			catalog,
			ticksPerSecond: TPS,
		});
		expect(op).toMatchObject({ startTicks: sec(5), endTicks: sec(9) });
	});
});

describe("resolveReferencedOps — drop rules (scenario 2)", () => {
	test("an out-of-range word index is dropped (never clamped)", () => {
		const ops = resolveReferencedOps({
			rawOps: [{ startWord: 2, endWord: 99 }],
			catalog,
			ticksPerSecond: TPS,
		});
		expect(ops).toEqual([]);
	});

	test("a reversed range is dropped (word and line)", () => {
		const ops = resolveReferencedOps({
			rawOps: [
				{ startWord: 3, endWord: 1 }, // reversed word span
				{ startLineId: "L2", endLineId: "L0" }, // reversed line span (end before start)
			],
			catalog,
			ticksPerSecond: TPS,
		});
		expect(ops).toEqual([]);
	});

	test("an unknown line id is dropped", () => {
		expect(
			resolveReferencedOps({
				rawOps: [{ startLineId: "L9", endLineId: "L9" }],
				catalog,
				ticksPerSecond: TPS,
			}),
		).toEqual([]);
	});

	test("a duplicate reference collapses to one", () => {
		const ops = resolveReferencedOps({
			rawOps: [
				{ startLineId: "L0", endLineId: "L0" },
				{ startLineId: "L0", endLineId: "L0" },
			],
			catalog,
			ticksPerSecond: TPS,
		});
		expect(ops).toHaveLength(1);
	});

	test("an overlapping later op is dropped (kept span wins)", () => {
		const ops = resolveReferencedOps({
			rawOps: [
				{ startLineId: "L0", endLineId: "L1" }, // 0..5
				{ startLineId: "L1", endLineId: "L2" }, // 2..9 overlaps the kept 0..5
			],
			catalog,
			ticksPerSecond: TPS,
		});
		expect(ops).toHaveLength(1);
		expect(ops[0]).toMatchObject({ startTicks: sec(0), endTicks: sec(5) });
	});

	test("an op with no usable reference (raw seconds only) is dropped", () => {
		expect(
			resolveReferencedOps({
				// startSec/endSec are intentionally NOT read by the sanitizer.
				rawOps: [{ op: "cut", ...({ startSec: 1, endSec: 2 } as object) }],
				catalog,
				ticksPerSecond: TPS,
			}),
		).toEqual([]);
	});
});

describe("sanitizeReferencedPlan — malformed responses (scenario 4)", () => {
	test("non-JSON string yields zero ops and a stage-named error, not a throw", () => {
		const r = sanitizeReferencedPlan({
			raw: "this is not json{",
			stage: "director",
			catalog,
			ticksPerSecond: TPS,
		});
		expect(r.ops).toEqual([]);
		expect(r.error).toContain("director");
	});

	test("wrong shape (no operations array) yields zero ops and a stage-named error", () => {
		const r = sanitizeReferencedPlan({
			raw: { somethingElse: true },
			stage: "redundancy",
			catalog,
			ticksPerSecond: TPS,
		});
		expect(r.ops).toEqual([]);
		expect(r.error).toContain("redundancy");
	});

	test("a valid JSON string with operations resolves and reports no error", () => {
		const r = sanitizeReferencedPlan({
			raw: JSON.stringify({ operations: [{ startLineId: "L0", endLineId: "L1" }] }),
			stage: "director",
			catalog,
			ticksPerSecond: TPS,
		});
		expect(r.error).toBeNull();
		expect(r.ops).toHaveLength(1);
		expect(r.ops[0]).toMatchObject({ startTicks: sec(0), endTicks: sec(5) });
	});

	test("accepts an already-parsed object under `ops` too", () => {
		const r = sanitizeReferencedPlan({
			raw: { ops: [{ startWord: 0, endWord: 0 }] },
			stage: "context",
			catalog,
			ticksPerSecond: TPS,
		});
		expect(r.error).toBeNull();
		expect(r.ops).toHaveLength(1);
	});
});
