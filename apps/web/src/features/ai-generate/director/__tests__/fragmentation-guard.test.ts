import { describe, expect, test } from "bun:test";
import {
	applyFragmentationGuard,
	classifyFragmentation,
	BREATH_MERGE_MAX_GAP_SEC,
	MICRO_CUT_MAX_SEC,
} from "../fragmentation-guard";
import type { DirectorOp } from "@framecut/hf-bridge";
import type { WordTiming } from "../cut-utils";

/**
 * Tests for the deterministic fragmentation guard (round 14 U2/P3, duty c). The
 * guard classifies each default-accepted micro removal into companion / merge /
 * demote / borderline / leave, then merges wordless-breath stutters and demotes
 * isolated word-bearing chops - never deleting a row.
 */

const op = (o: Partial<DirectorOp> & { id: string }): DirectorOp => ({
	op: "cut",
	startSec: 0,
	endSec: 1,
	reason: "r",
	confidence: 0.7,
	...o,
});

/** A dense word grid so any span can be made word-bearing or wordless at will. */
const wordAt = (start: number): WordTiming => ({
	text: "w",
	start,
	end: start + 0.1,
});

describe("classifyFragmentation", () => {
	test("a lone word-bearing micro-cut with no cut nearby is demoted", () => {
		const words = [wordAt(10.0)]; // midpoint 10.05 falls inside [10.0,10.4)
		const micro = op({ id: "m", startSec: 10.0, endSec: 10.4, category: "llm" });
		const { actions } = classifyFragmentation({ ops: [micro], words });
		expect(actions).toEqual([{ id: "m", verdict: "demote" }]);
	});

	test("an isolated WORDLESS micro-cut is left alone (harmless silence trim)", () => {
		const micro = op({ id: "m", startSec: 10.0, endSec: 10.4, category: "llm" });
		const { actions } = classifyFragmentation({ ops: [micro], words: [] });
		expect(actions).toEqual([]);
	});

	test("a micro-cut abutting a real cut is a companion, untouched", () => {
		const words = [wordAt(10.0)];
		const micro = op({ id: "m", startSec: 10.0, endSec: 10.4, category: "llm" });
		// Real cut touching the micro-cut -> one contiguous >= 0.5s region.
		const real = op({ id: "R", startSec: 10.4, endSec: 13.0, category: "llm" });
		const { actions } = classifyFragmentation({ ops: [micro, real], words });
		expect(actions).toEqual([]);
	});

	test("wordless breath gap to a real cut is bridged (merge, extends the span)", () => {
		// micro [10.0,10.3], real [10.45,13]; gap [10.3,10.45] = 0.15s < breath, wordless.
		const micro = op({ id: "m", startSec: 10.0, endSec: 10.3, category: "llm" });
		const real = op({ id: "R", startSec: 10.45, endSec: 13.0, category: "llm" });
		const { actions } = classifyFragmentation({ ops: [micro, real], words: [] });
		expect(actions).toEqual([
			{ id: "m", verdict: "merge", mergedStartSec: 10.0, mergedEndSec: 10.45 },
		]);
	});

	test("breath gap that HOLDS a word cannot be bridged -> borderline", () => {
		// gap [10.3,10.45] holds a word midpoint -> unsafe to bridge -> borderline.
		const words = [wordAt(10.32)]; // midpoint 10.37 inside the gap
		const micro = op({ id: "m", startSec: 10.0, endSec: 10.3, category: "llm" });
		const real = op({ id: "R", startSec: 10.45, endSec: 13.0, category: "llm" });
		const { actions, borderlineIds } = classifyFragmentation({
			ops: [micro, real],
			words,
		});
		expect(actions).toEqual([{ id: "m", verdict: "borderline" }]);
		expect(borderlineIds).toEqual(["m"]);
	});

	test("a real cut (>= 0.5s) is never a micro-cut", () => {
		const words = [wordAt(10.0)];
		const real = op({ id: "R", startSec: 10.0, endSec: 10.6, category: "llm" });
		expect(classifyFragmentation({ ops: [real], words }).actions).toEqual([]);
	});

	test("trusted disfluency categories are exempt even when tiny/isolated", () => {
		const words = [wordAt(10.0)];
		for (const category of ["duplicate", "filler", "noise", "deadair", "join"]) {
			const micro = op({ id: "m", startSec: 10.0, endSec: 10.4, category: category as DirectorOp["category"] });
			expect(classifyFragmentation({ ops: [micro], words }).actions).toEqual([]);
		}
	});

	test("offered (defaultAccept false) micro removals are never guard targets", () => {
		const words = [wordAt(10.0)];
		const offered = op({
			id: "m",
			startSec: 10.0,
			endSec: 10.4,
			category: "retake",
			defaultAccept: false,
		});
		expect(classifyFragmentation({ ops: [offered], words }).actions).toEqual([]);
	});

	test("a gap just OVER a breath is not near a real cut -> isolated demote", () => {
		const words = [wordAt(10.0)];
		const gap = BREATH_MERGE_MAX_GAP_SEC + 0.1;
		const micro = op({ id: "m", startSec: 10.0, endSec: 10.4, category: "llm" });
		const real = op({ id: "R", startSec: 10.4 + gap, endSec: 14.0, category: "llm" });
		const { actions } = classifyFragmentation({ ops: [micro, real], words });
		expect(actions).toEqual([{ id: "m", verdict: "demote" }]);
	});
});

describe("applyFragmentationGuard", () => {
	test("demote flips defaultAccept and annotates the reason, never deletes", () => {
		const words = [wordAt(10.0)];
		const micro = op({ id: "m", startSec: 10.0, endSec: 10.4, category: "llm", reason: "chop" });
		const { operations, demotedIds } = applyFragmentationGuard({ ops: [micro], words });
		expect(operations).toHaveLength(1); // row survives
		expect(operations[0].defaultAccept).toBe(false);
		expect(operations[0].reason).toContain("chop");
		expect(operations[0].reason).toContain("fragmentation guard");
		expect(demotedIds).toEqual(["m"]);
	});

	test("merge extends the span to abut the neighbor cut", () => {
		const micro = op({ id: "m", startSec: 10.0, endSec: 10.3, category: "llm" });
		const real = op({ id: "R", startSec: 10.45, endSec: 13.0, category: "llm" });
		const { operations, mergedIds } = applyFragmentationGuard({ ops: [micro, real], words: [] });
		const m = operations.find((o) => o.id === "m")!;
		expect(m.endSec).toBeCloseTo(10.45, 6);
		expect(m.defaultAccept).not.toBe(false); // still accepted, just wider
		expect(mergedIds).toEqual(["m"]);
	});

	test("no micro-cut activity => byte-identical op list", () => {
		const big = op({ id: "R", startSec: 0, endSec: 3, category: "llm" });
		const { operations, mergedIds, demotedIds } = applyFragmentationGuard({
			ops: [big],
			words: [wordAt(1.0)],
		});
		expect(operations).toEqual([big]);
		expect(mergedIds).toEqual([]);
		expect(demotedIds).toEqual([]);
	});

	test("MICRO_CUT_MAX_SEC is the half-second boundary the module documents", () => {
		expect(MICRO_CUT_MAX_SEC).toBe(0.5);
	});
});
