import { beforeEach, describe, expect, test } from "bun:test";
import {
	aggregateDecisions,
	deriveTasteNote,
	useDirectorTasteStore,
	type DirectorTasteStats,
} from "../taste";

describe("aggregateDecisions", () => {
	test("tallies per explicit category", () => {
		const stats = aggregateDecisions({
			stats: {},
			decisions: [
				{ op: "cut", category: "filler", accepted: false },
				{ op: "cut", category: "filler", accepted: false },
				{ op: "cut", category: "duplicate", accepted: true },
			],
		});
		expect(stats.filler).toEqual({ accepted: 0, rejected: 2 });
		expect(stats.duplicate).toEqual({ accepted: 1, rejected: 0 });
	});

	test("degrades an un-tagged op to a category by op kind; keep carries no signal", () => {
		const stats = aggregateDecisions({
			stats: {},
			decisions: [
				{ op: "cut", accepted: true }, // → llm
				{ op: "take_select", accepted: false }, // → take
				{ op: "reorder", accepted: true }, // → reorder
				{ op: "keep", accepted: true }, // → no signal
			],
		});
		expect(stats.llm).toEqual({ accepted: 1, rejected: 0 });
		expect(stats.take).toEqual({ accepted: 0, rejected: 1 });
		expect(stats.reorder).toEqual({ accepted: 1, rejected: 0 });
		expect(Object.keys(stats).sort()).toEqual(["llm", "reorder", "take"]);
	});

	test("is immutable — accumulates across calls", () => {
		const first = aggregateDecisions({
			stats: {},
			decisions: [{ op: "cut", category: "filler", accepted: false }],
		});
		const second = aggregateDecisions({
			stats: first,
			decisions: [{ op: "cut", category: "filler", accepted: false }],
		});
		expect(first.filler).toEqual({ accepted: 0, rejected: 1 });
		expect(second.filler).toEqual({ accepted: 0, rejected: 2 });
	});
});

describe("deriveTasteNote", () => {
	test("flags a category the user keeps rejecting (>=2 samples, >=50%)", () => {
		const note = deriveTasteNote({ filler: { accepted: 0, rejected: 2 } });
		expect(note).toContain("conservative");
		expect(note).toContain("filler");
	});

	test("flags a category the user keeps accepting", () => {
		expect(deriveTasteNote({ reorder: { accepted: 3, rejected: 0 } })).toContain(
			"reorder",
		);
	});

	test("emits a distinct line per category", () => {
		const note = deriveTasteNote({
			duplicate: { accepted: 3, rejected: 0 },
			filler: { accepted: 0, rejected: 2 },
		});
		expect(note).toContain("duplicate");
		expect(note).toContain("filler");
	});

	test("stays silent below the sample threshold", () => {
		const stats: DirectorTasteStats = { filler: { accepted: 0, rejected: 1 } };
		expect(deriveTasteNote(stats)).toBe("");
	});

	test("empty stats produce no note", () => {
		expect(deriveTasteNote({})).toBe("");
	});
});

describe("useDirectorTasteStore — clearTaste", () => {
	beforeEach(() => {
		// In-memory reset (persist storage is absent under bun; the store still works).
		useDirectorTasteStore.setState({ opStats: {}, selfLearningEnabled: true });
	});

	test("clearing taste empties the per-category notes", () => {
		// Record enough rejected fillers to cross the note threshold...
		useDirectorTasteStore.getState().noteReviewDecisions([
			{ op: "cut", category: "filler", accepted: false },
			{ op: "cut", category: "filler", accepted: false },
		]);
		expect(useDirectorTasteStore.getState().buildDirectorTasteNote()).not.toBe("");
		// ...then clearTaste wipes the stats so the next prompt carries no note.
		useDirectorTasteStore.getState().clearTaste();
		expect(useDirectorTasteStore.getState().buildDirectorTasteNote()).toBe("");
	});
});
