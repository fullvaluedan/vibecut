import { describe, expect, test } from "bun:test";
import { aggregateDecisions, deriveTasteNote, type DirectorTasteStats } from "../taste";

describe("aggregateDecisions", () => {
	test("tallies accept/reject per op type onto the existing stats", () => {
		const stats = aggregateDecisions({
			stats: {},
			decisions: [
				{ op: "cut", accepted: true },
				{ op: "cut", accepted: false },
				{ op: "reorder", accepted: false },
			],
		});
		expect(stats.cut).toEqual({ accepted: 1, rejected: 1 });
		expect(stats.reorder).toEqual({ accepted: 0, rejected: 1 });
	});

	test("is immutable — accumulates across calls", () => {
		const first = aggregateDecisions({ stats: {}, decisions: [{ op: "cut", accepted: false }] });
		const second = aggregateDecisions({ stats: first, decisions: [{ op: "cut", accepted: false }] });
		expect(first.cut).toEqual({ accepted: 0, rejected: 1 });
		expect(second.cut).toEqual({ accepted: 0, rejected: 2 });
	});
});

describe("deriveTasteNote", () => {
	test("flags an op type the user keeps rejecting (>=2 samples, >=50%)", () => {
		const stats: DirectorTasteStats = { cut: { accepted: 0, rejected: 2 } };
		const note = deriveTasteNote(stats);
		expect(note).toContain("conservative");
		expect(note).toContain("cut");
	});

	test("flags an op type the user keeps accepting", () => {
		const stats: DirectorTasteStats = { take_select: { accepted: 3, rejected: 0 } };
		expect(deriveTasteNote(stats)).toContain("take");
	});

	test("stays silent below the sample threshold", () => {
		expect(deriveTasteNote({ cut: { accepted: 0, rejected: 1 } })).toBe("");
	});

	test("empty stats produce no note", () => {
		expect(deriveTasteNote({})).toBe("");
	});
});
