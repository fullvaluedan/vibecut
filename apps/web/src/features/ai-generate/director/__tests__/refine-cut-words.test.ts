import { describe, expect, test } from "bun:test";
import { refineCutWordBounds } from "../refine-cut-words";
import { snapRemovalOps } from "../snap-cut";
import { resolveTrimVsCut } from "../resolve-trim-vs-cut";
import { justifyCuts } from "../justify-cuts";
import type { WordTiming } from "../cut-utils";
import type { DirectorOp } from "@framecut/hf-bridge";

const op = ({
	startSec,
	endSec,
	op = "cut",
	id = `t-${startSec}-${endSec}`,
}: {
	startSec: number;
	endSec: number;
	op?: DirectorOp["op"];
	id?: string;
}): DirectorOp => ({
	id,
	op,
	startSec,
	endSec,
	reason: "test",
	confidence: 0.5,
});

const word = (text: string, start: number, end: number): WordTiming => ({
	text,
	start,
	end,
});

// A tidy sentence: five words, each 0.4s long with 0.1s gaps between them.
//  "So"      0.0–0.4   gap 0.4–0.5
//  "this"    0.5–0.9   gap 0.9–1.0
//  "phone"   1.0–1.4   gap 1.4–1.5
//  "is"      1.5–1.9   gap 1.9–2.0
//  "great"   2.0–2.4
const SENTENCE: WordTiming[] = [
	word("So", 0.0, 0.4),
	word("this", 0.5, 0.9),
	word("phone.", 1.0, 1.4),
	word("is", 1.5, 1.9),
	word("great", 2.0, 2.4),
];

describe("refineCutWordBounds", () => {
	test("edge landing mid-word shifts to the word gap and the word survives (shrink)", () => {
		// Cut end lands at 1.1 — just inside "phone." (1.0–1.4), only its head (0.1s of
		// 0.4s) is removed, midpoint 1.2 is OUTSIDE the cut → exclude the word, edge
		// shrinks back to the word's start (1.0). "phone." survives whole.
		const [refined] = refineCutWordBounds({
			ops: [op({ startSec: 0.45, endSec: 1.1 })],
			words: SENTENCE,
		});
		expect(refined.startSec).toBe(0.45); // start already in a gap → untouched
		expect(refined.endSec).toBe(1.0); // shrunk off "phone." to its start
	});

	test("word with midpoint inside the cut is swallowed whole (end edge lands after its end)", () => {
		// Cut end lands at 1.3 — inside "phone." (1.0–1.4), midpoint 1.2 is INSIDE the
		// cut (majority removed) → swallow the word whole, edge grows to its end (1.4).
		const [refined] = refineCutWordBounds({
			ops: [op({ startSec: 0.45, endSec: 1.3 })],
			words: SENTENCE,
		});
		expect(refined.endSec).toBe(1.4);
	});

	test("start edge inside a word swallows it when its midpoint is in the cut", () => {
		// Cut start lands at 1.1 — inside "phone." (1.0–1.4), midpoint 1.2 >= 1.1 is in
		// the cut → swallow whole, start grows back to the word's start (1.0).
		const [refined] = refineCutWordBounds({
			ops: [op({ startSec: 1.1, endSec: 1.95 })],
			words: SENTENCE,
		});
		expect(refined.startSec).toBe(1.0);
	});

	test("start edge inside a word shrinks off it when its midpoint is kept", () => {
		// Cut start lands at 1.3 — inside "phone." (1.0–1.4), midpoint 1.2 < 1.3 is kept
		// → exclude, start shrinks forward to the word's end (1.4). "phone." survives.
		const [refined] = refineCutWordBounds({
			ops: [op({ startSec: 1.3, endSec: 1.95 })],
			words: SENTENCE,
		});
		expect(refined.startSec).toBe(1.4);
	});

	test("op entirely inside one word collapses and is dropped", () => {
		// Both edges land inside "phone." (1.0–1.4): a cut within a single word is never
		// a real removal → dropped.
		const refined = refineCutWordBounds({
			ops: [op({ startSec: 1.1, endSec: 1.25 })],
			words: SENTENCE,
		});
		expect(refined).toHaveLength(0);
	});

	test("empty / absent words returns ops unchanged (fail-open)", () => {
		const ops = [op({ startSec: 1.1, endSec: 1.3 })];
		expect(refineCutWordBounds({ ops, words: [] })).toEqual(ops);
		expect(refineCutWordBounds({ ops, words: undefined })).toEqual(ops);
	});

	test("edges already on gaps are untouched (idempotent, byte-identical op)", () => {
		const original = op({ startSec: 0.45, endSec: 1.45 }); // both in gaps
		const [refined] = refineCutWordBounds({ ops: [original], words: SENTENCE });
		expect(refined).toBe(original); // same reference: no rewrite
	});

	test("keep and reorder ops pass through untouched even when edges are mid-word", () => {
		const keep = op({ startSec: 1.1, endSec: 1.3, op: "keep" });
		const reorder = op({ startSec: 1.1, endSec: 1.3, op: "reorder" });
		const refined = refineCutWordBounds({ ops: [keep, reorder], words: SENTENCE });
		expect(refined[0]).toBe(keep);
		expect(refined[1]).toBe(reorder);
	});

	test("take_select removals are refined like cuts", () => {
		const [refined] = refineCutWordBounds({
			ops: [op({ startSec: 0.45, endSec: 1.1, op: "take_select" })],
			words: SENTENCE,
		});
		expect(refined.endSec).toBe(1.0); // shrunk off "phone."
		expect(refined.op).toBe("take_select");
	});

	test("both edges mid-word (different words) refine independently", () => {
		// start 0.2 inside "So" (0.0–0.4, mid 0.2 >= 0.2 → swallow → 0.0);
		// end 2.2 inside "great" (2.0–2.4, mid 2.2 <= 2.2 → swallow → 2.4).
		const [refined] = refineCutWordBounds({
			ops: [op({ startSec: 0.2, endSec: 2.2 })],
			words: SENTENCE,
		});
		expect(refined.startSec).toBe(0.0);
		expect(refined.endSec).toBe(2.4);
	});

	test("integration: a segment-granular op through snap → refine → trim → justify ends word-safe", () => {
		// A segment-granular removal whose end lands mid-"phone." (1.25). No energy signal
		// (empty envelope → snap is a pass-through), so refine is the pass that saves the
		// word; trim-vs-cut has no nearby clip edges; justifyCuts keeps the real removal.
		const raw = op({ startSec: 0.45, endSec: 1.25, id: "seg" });
		const snapped = snapRemovalOps({ ops: [raw], envelope: [] });
		const refined = refineCutWordBounds({ ops: snapped, words: SENTENCE });
		const trimmed = resolveTrimVsCut({
			ops: refined,
			clipStartsSec: [],
			clipEndsSec: [],
			toleranceSec: 0.5,
		});
		const [final] = justifyCuts({ ops: trimmed, words: SENTENCE, floorSec: 0.5 });
		// end 1.25: midpoint 1.2 <= 1.25 → "phone." swallowed whole, edge at 1.4. No cut
		// edge lands inside any word.
		expect(final.endSec).toBe(1.4);
		for (const w of SENTENCE) {
			expect(final.startSec < w.start || final.startSec >= w.end).toBe(true);
			expect(final.endSec <= w.start || final.endSec >= w.end).toBe(true);
		}
	});

	test("punctuation-only / zero-width tokens never nudge an edge", () => {
		const words: WordTiming[] = [
			word("hi", 0.0, 0.4),
			word("...", 0.4, 0.6), // normalizes to empty → ignored
			word("there", 0.6, 1.0),
		];
		const original = op({ startSec: 0.5, endSec: 0.55 }); // inside the "..." token
		const [refined] = refineCutWordBounds({ ops: [original], words });
		expect(refined).toBe(original); // untouched — "..." is not a boundary word
	});
});
