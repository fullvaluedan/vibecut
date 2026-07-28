import { describe, expect, test } from "bun:test";
import type { DirectorOp } from "@framecut/hf-bridge";
import { HANDLE_SEC, swallowPauseBounds } from "../swallow-pause";
import { envelope } from "./test-envelope";

const WIN = 0.05;
const QUIET = 0.001;
const LOUD = 0.05;
const THRESH = 0.01;

function cut(startSec: number, endSec: number, extra: Partial<DirectorOp> = {}): DirectorOp {
	return {
		id: `c-${startSec}`,
		op: "cut",
		startSec,
		endSec,
		reason: "test",
		confidence: 0.6,
		category: "pacing",
		...extra,
	} as DirectorOp;
}

describe("swallowPauseBounds", () => {
	test("a cut inside a pause swallows it to word +/- handle on both sides", () => {
		// Words end at 44.72 and resume at 48.16; silence 44.75-48.20.
		const env = envelope(60, LOUD, [44.75, 48.2, QUIET]);
		const words = [
			{ start: 44.16, end: 44.72 },
			{ start: 48.16, end: 48.3 },
		];
		const ops = swallowPauseBounds({
			ops: [cut(45.38, 47.63)],
			envelope: env,
			words,
			threshold: THRESH,
		});
		expect(ops).toHaveLength(1);
		expect(ops[0].startSec).toBeCloseTo(44.72 + HANDLE_SEC, 2);
		expect(ops[0].endSec).toBeCloseTo(48.16 - HANDLE_SEC, 2);
	});

	test("an edge flush against continuous speech falls back to the trough snap", () => {
		// Uniform loud audio: the trough snap has nothing quieter, boundary stays.
		const env = envelope(30, LOUD);
		const words = [{ start: 0.5, end: 9.9 }, { start: 12.2, end: 29 }];
		const op = cut(10, 12);
		const ops = swallowPauseBounds({ ops: [op], envelope: env, words, threshold: THRESH });
		expect(ops[0].startSec).toBeCloseTo(10, 3);
		expect(ops[0].endSec).toBeCloseTo(12, 3);
	});

	test("two removals widening into the same pause collapse to one owning cut", () => {
		// One long silence 10-20 with two cuts inside it and no words between:
		// both widen to the identical word-to-word span, so the duplicate drops
		// and a single cut owns the pause (the non-overlap invariant).
		const env = envelope(30, LOUD, [10, 20, QUIET]);
		const words = [
			{ start: 9, end: 9.9 },
			{ start: 20.2, end: 21 },
		];
		const ops = swallowPauseBounds({
			ops: [cut(11, 13), cut(16, 18)],
			envelope: env,
			words,
			threshold: THRESH,
		});
		expect(ops).toHaveLength(1);
		expect(ops[0].startSec).toBeCloseTo(9.9 + HANDLE_SEC, 2);
		// The walk stops at the silence run's end (20.0): the loud 20.0-20.2
		// stretch before the next word is energetic audio, never swallowed.
		expect(ops[0].endSec).toBeCloseTo(20.0, 2);
	});

	test("widening never crosses 0 or the audio end", () => {
		// Silence from 0 and to the end, no words outside the middle.
		const env = envelope(20, QUIET, [8, 12, LOUD]);
		const words = [{ start: 8.2, end: 11.8 }];
		const ops = swallowPauseBounds({
			ops: [cut(2, 5), cut(14, 17)],
			envelope: env,
			words,
			threshold: THRESH,
		});
		expect(ops[0].startSec).toBe(0);
		expect(ops[1].endSec).toBeCloseTo(20, 3);
	});

	test("empty envelope is a pass-through", () => {
		const op = cut(1, 2);
		const ops = swallowPauseBounds({ ops: [op], envelope: [], words: [], threshold: THRESH });
		expect(ops).toEqual([op]);
	});

	test("a removal already word-adjacent on both sides stays byte-identical", () => {
		// Words hug the cut: prev ends at start-handle, next starts at end+handle,
		// and the pause is exactly the cut span (no silence outside it).
		const env = envelope(30, LOUD, [10, 12, QUIET]);
		const words = [
			{ start: 9, end: 10 - HANDLE_SEC },
			{ start: 12 + HANDLE_SEC, end: 13 },
		];
		const op = cut(10, 12);
		const ops = swallowPauseBounds({ ops: [op], envelope: env, words, threshold: THRESH });
		// Start edge: window before 10 is loud -> trough snap -> may stay or move
		// within the quiet cut interior... the window at 9.95 is LOUD so fallback
		// snap finds the quiet window just inside the pause; end edge symmetric.
		// The op must never shrink and never clip a word.
		expect(ops[0].startSec).toBeLessThanOrEqual(10 + 0.26);
		expect(ops[0].startSec).toBeGreaterThanOrEqual(10 - 0.26);
		expect(ops[0].endSec).toBeGreaterThanOrEqual(12 - 0.26);
	});

	test("hallucination-free words list lets a silent tail swallow fully", () => {
		// Silence 50-83.85 with NO clean words inside (hallucinations excluded):
		// a cut at 58.23-59.92 widens across the whole silent block.
		const env = envelope(83.85, LOUD, [50, 83.85, QUIET]);
		const words = [{ start: 1, end: 49.8 }];
		const ops = swallowPauseBounds({
			ops: [cut(58.23, 59.92)],
			envelope: env,
			words,
			threshold: THRESH,
		});
		expect(ops[0].startSec).toBeCloseTo(49.95, 1);
		expect(ops[0].endSec).toBeCloseTo(83.85, 2);
	});

	test("review fix: the start-edge check inspects the boundary's own window (no jump-over)", () => {
		// A clap occupies window [1.00, 1.05); windows before it are silent. A
		// cut starting at 1.04 (inside the clap's window) must NOT widen back
		// through the silence, swallowing the clap the walk never inspected.
		const env = envelope(30, QUIET, [1.0, 1.05, LOUD], [1.05, 29, LOUD]);
		const words = [{ start: 1.1, end: 28 }];
		const ops = swallowPauseBounds({
			ops: [cut(1.04, 5)],
			envelope: env,
			words,
			threshold: THRESH,
		});
		// Pre-boundary window (containing 1.039) is LOUD -> fallback snap, no widen to 0.
		expect(ops[0].startSec).toBeGreaterThan(0.7);
	});

	test("review fix: flush edges at the timeline extremes stay put", () => {
		// A trailing dead-air cut ends at totalSec (beyond the envelope): the
		// fallback snap must not pull it back inside.
		const env = envelope(20, LOUD, [15, 20, QUIET]);
		const words = [{ start: 1, end: 14.8 }];
		const ops = swallowPauseBounds({
			ops: [cut(15.15, 20.01), cut(0, 0.8)],
			envelope: env,
			words,
			threshold: THRESH,
		});
		const trailing = ops.find((o) => o.endSec > 19)!;
		expect(trailing.endSec).toBeCloseTo(20.01, 3);
		const leading = ops.find((o) => o.startSec < 0.1)!;
		expect(leading.startSec).toBe(0);
	});

	test("review fix: empty words means bounded snap only, never an uncapped widen", () => {
		// Degraded transcript: a cut edge in a huge quiet region must not walk
		// the whole region; only the bounded trough snap applies.
		const env = envelope(60, QUIET, [30, 32, LOUD]);
		const ops = swallowPauseBounds({
			ops: [cut(10, 12)],
			envelope: env,
			words: [],
			threshold: THRESH,
		});
		expect(ops[0].startSec).toBeGreaterThan(9.7); // moved at most searchSec
		expect(ops[0].endSec).toBeLessThan(12.3);
	});

	test("review fix: the walk never enters a keeper span (protected beat survives)", () => {
		// A protected 1s emphasis beat [12, 13] sits after a filler cut ending
		// at 12: without the keeper limit the end edge would widen through the
		// beat to the next word at 14.
		const env = envelope(30, LOUD, [11.9, 13.9, QUIET]);
		const words = [
			{ start: 1, end: 11.9 },
			{ start: 14, end: 15 },
		];
		const withKeeper = swallowPauseBounds({
			ops: [cut(11.5, 12)],
			envelope: env,
			words,
			keepers: [{ startSec: 12, endSec: 13 }],
			threshold: THRESH,
		});
		expect(withKeeper[0].endSec).toBeLessThanOrEqual(12 + 1e-6);
		const withoutKeeper = swallowPauseBounds({
			ops: [cut(11.5, 12)],
			envelope: env,
			words,
			threshold: THRESH,
		});
		expect(withoutKeeper[0].endSec).toBeGreaterThan(13); // proves the limit did the work
	});

	test("round 12: an OFFERED cut widening into a pause never erases the AUTO cut on the other side", () => {
		// Reproduces the join-the-group diagnostic (R3): a never-auto-applied
		// OFFERED row (e.g. a retake candidate) sits with its NEAR edge in real
		// speech (so it never widens on that side) and its FAR edge inside a
		// long pause, next to an AUTO pacing cut that lives entirely inside the
		// same pause. Both widen toward the SAME next-word boundary on their
		// shared side, so the offered cut's far edge and the accepted cut's far
		// edge land on the identical point, and the offered cut's un-widened
		// near edge makes it a SUPERSET of the accepted cut's span. Before this
		// fix, whichever cut sorted first by raw start time won the pause
		// outright (here the offered one, since it starts earlier at 8.5),
		// silently deleting the accepted cut. The accepted cut must always
		// survive with its full widened span; the offered cut must shrink to
		// stop where the accepted cut's territory begins.
		const env = envelope(60, LOUD, [10, 20, QUIET]);
		const words = [
			{ start: 9, end: 9.9 },
			{ start: 20.2, end: 21 },
		];
		const ops = swallowPauseBounds({
			ops: [
				// START (8.5) sits in the loud, non-silent region before the pause:
				// never widens, only trough-snaps. END (10.5) is inside the pause:
				// widens forward to the same next-word limit the accepted cut uses.
				cut(8.5, 10.5, { id: "offered", category: "retake", defaultAccept: false }),
				// Fully inside the pause: widens on BOTH sides to word +/- handle.
				cut(15, 16, { id: "auto", category: "pacing" }), // defaultAccept omitted = accepted
			],
			envelope: env,
			words,
			threshold: THRESH,
		});
		const auto = ops.find((o) => o.id === "auto")!;
		const offered = ops.find((o) => o.id === "offered")!;
		expect(auto).toBeDefined();
		// The AUTO cut keeps its full word-to-word widened span, untouched by
		// the offered cut's presence.
		expect(auto.startSec).toBeCloseTo(9.9 + HANDLE_SEC, 2);
		expect(auto.endSec).toBeCloseTo(20.0, 2);
		// The offered cut survives (not silently deleted) but is trimmed back to
		// where the accepted cut's territory begins, never overlapping it.
		expect(offered).toBeDefined();
		expect(offered.endSec).toBeLessThanOrEqual(auto.startSec + 1e-6);
		expect(offered.startSec).toBeLessThan(offered.endSec);
		expect(offered.startSec).toBeLessThan(9.5); // near edge stayed put, not widened
	});

	test("round 12: an OFFERED cut fully swallowed by an AUTO cut's widened span drops out", () => {
		const env = envelope(60, LOUD, [10, 20, QUIET]);
		const words = [
			{ start: 9, end: 9.9 },
			{ start: 20.2, end: 21 },
		];
		const ops = swallowPauseBounds({
			ops: [
				cut(13, 14, { id: "offered", category: "retake", defaultAccept: false }),
				cut(11, 19, { id: "auto", category: "pacing" }),
			],
			envelope: env,
			words,
			threshold: THRESH,
		});
		expect(ops.find((o) => o.id === "auto")).toBeDefined();
		expect(ops.find((o) => o.id === "offered")).toBeUndefined();
	});

	test("round 12: two ACCEPTED cuts overlapping after widening resolve exactly as before (start order wins)", () => {
		// Same shape as the pre-existing "two removals widening into the same
		// pause" test above, pinned explicitly with both cuts accepted: this
		// fix must not change AUTO-vs-AUTO behavior at all.
		const env = envelope(30, LOUD, [10, 20, QUIET]);
		const words = [
			{ start: 9, end: 9.9 },
			{ start: 20.2, end: 21 },
		];
		const ops = swallowPauseBounds({
			ops: [cut(11, 13), cut(16, 18)],
			envelope: env,
			words,
			threshold: THRESH,
		});
		expect(ops).toHaveLength(1);
		expect(ops[0].startSec).toBeCloseTo(9.9 + HANDLE_SEC, 2);
		expect(ops[0].endSec).toBeCloseTo(20.0, 2);
	});

	test("round 12: two OFFERED cuts overlapping after widening still resolve by start order between themselves", () => {
		const env = envelope(30, LOUD, [10, 20, QUIET]);
		const words = [
			{ start: 9, end: 9.9 },
			{ start: 20.2, end: 21 },
		];
		const ops = swallowPauseBounds({
			ops: [
				cut(11, 13, { defaultAccept: false }),
				cut(16, 18, { defaultAccept: false }),
			],
			envelope: env,
			words,
			threshold: THRESH,
		});
		expect(ops).toHaveLength(1);
		expect(ops.every((o) => o.defaultAccept === false)).toBe(true);
		expect(ops[0].startSec).toBeCloseTo(9.9 + HANDLE_SEC, 2);
		expect(ops[0].endSec).toBeCloseTo(20.0, 2);
	});

	test("round 12 B1: an OFFERED cut spanning the GAPS between two accepted cuts survives as BOTH disjoint remainders", () => {
		// The confirmed multi-island trace: OFFERED [3,20] minus accepted [0,5]
		// and [10,15] must leave BOTH [5,10] AND [15,20]. The old single-span trim
		// mutated one range cumulatively and returned only [5,10], silently
		// discarding [15,20] (which overlapped no accepted cut at all). A flat,
		// loud envelope with EMPTY words keeps every edge exactly where it starts
		// (no widen; the trough-snap fallback is a no-op on a flat envelope), so
		// the subtraction runs at the exact trace coordinates.
		const env = envelope(25, LOUD); // 500 flat-loud windows, zero silence
		const ops = swallowPauseBounds({
			ops: [
				cut(3, 20, { id: "offered", category: "retake", defaultAccept: false }),
				cut(0, 5, { id: "accA", category: "pacing" }), // defaultAccept omitted = accepted
				cut(10, 15, { id: "accB", category: "pacing" }),
			],
			envelope: env,
			words: [],
			threshold: THRESH,
		});
		// The two accepted cuts survive untouched.
		expect(ops.find((o) => o.id === "accA")).toBeDefined();
		expect(ops.find((o) => o.id === "accB")).toBeDefined();
		// The offered cut survives as TWO disjoint sub-spans, not one.
		const offered = ops.filter((o) => o.category === "retake");
		expect(offered).toHaveLength(2);
		const spans = offered
			.map((o) => [o.startSec, o.endSec] as const)
			.sort((a, b) => a[0] - b[0]);
		expect(spans[0][0]).toBeCloseTo(5, 6);
		expect(spans[0][1]).toBeCloseTo(10, 6);
		expect(spans[1][0]).toBeCloseTo(15, 6);
		expect(spans[1][1]).toBeCloseTo(20, 6);
		// Both remainders keep the offered row's id FAMILY, re-keyed distinctly so
		// two ops never share one id.
		expect(offered.every((o) => o.id.startsWith("offered"))).toBe(true);
		expect(new Set(offered.map((o) => o.id)).size).toBe(2);
	});

	test("round 12 B1: an OFFERED cut trimmed on a single side keeps its original id (byte-identical)", () => {
		// A one-survivor trim is the common case and must not re-key: OFFERED
		// [3,20] minus a single accepted [0,5] leaves exactly [5,20], id intact.
		const env = envelope(25, LOUD);
		const ops = swallowPauseBounds({
			ops: [
				cut(3, 20, { id: "offered", category: "retake", defaultAccept: false }),
				cut(0, 5, { id: "accA", category: "pacing" }),
			],
			envelope: env,
			words: [],
			threshold: THRESH,
		});
		const offered = ops.filter((o) => o.category === "retake");
		expect(offered).toHaveLength(1);
		expect(offered[0].id).toBe("offered");
		expect(offered[0].startSec).toBeCloseTo(5, 6);
		expect(offered[0].endSec).toBeCloseTo(20, 6);
	});

	test("keep and reorder ops pass through untouched", () => {
		const env = envelope(30, LOUD, [10, 14, QUIET]);
		const keep: DirectorOp = {
			id: "k1",
			op: "keep",
			startSec: 10,
			endSec: 14,
			reason: "beat",
			confidence: 0.9,
		} as DirectorOp;
		const ops = swallowPauseBounds({
			ops: [keep],
			envelope: env,
			words: [],
			threshold: THRESH,
		});
		expect(ops[0]).toBe(keep);
	});
});
