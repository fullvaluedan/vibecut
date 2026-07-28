import { describe, expect, test } from "bun:test";
import {
	buildCoordinateMap,
	buildVirtualTimeline,
	mapAssembledOpsToSource,
	remapEnvelope,
	SECOND_PASS_REASON_PREFIX,
	tagSecondPass,
} from "../virtual-timeline";
import type { DirectorOp } from "@framecut/hf-bridge";
import type { SpeechFeatures } from "../types";
import type { TranscriptSegment } from "../build-signal-table";
import type { WordTiming } from "../cut-utils";

/** A default-accepted cut op over [startSec, endSec). */
function cut(startSec: number, endSec: number, id = `c-${startSec}-${endSec}`): DirectorOp {
	return { id, op: "cut", startSec, endSec, reason: "x", confidence: 0.9 };
}

describe("buildCoordinateMap", () => {
	test("identity map when there are no cuts", () => {
		const map = buildCoordinateMap({ removals: [], totalSec: 10 });
		expect(map.assembledTotalSec).toBe(10);
		expect(map.keptSpans.length).toBe(1);
		for (const t of [0, 2.5, 5, 7.31, 10]) {
			expect(map.toSource(t)).toBeCloseTo(t, 9);
			expect(map.toAssembled(t)).toBeCloseTo(t, 9);
		}
	});

	test("single cut shifts everything after it left by the cut duration", () => {
		// Remove [3,5): 2s gone. Assembled total 8.
		const map = buildCoordinateMap({ removals: [{ startSec: 3, endSec: 5 }], totalSec: 10 });
		expect(map.assembledTotalSec).toBe(8);
		// Before the cut: unchanged.
		expect(map.toSource(1)).toBeCloseTo(1, 9);
		expect(map.toAssembled(1)).toBeCloseTo(1, 9);
		// After the cut: assembled t maps to source t+2.
		expect(map.toSource(3.5)).toBeCloseTo(5.5, 9);
		expect(map.toAssembled(5.5)).toBeCloseTo(3.5, 9);
		expect(map.toSource(8)).toBeCloseTo(10, 9);
	});

	test("round-trips a point through multiple cuts (toAssembled then toSource)", () => {
		// Remove [2,4) and [7,9): 4s gone. Assembled total 6.
		const removals = [
			{ startSec: 2, endSec: 4 },
			{ startSec: 7, endSec: 9 },
		];
		const map = buildCoordinateMap({ removals, totalSec: 12 });
		expect(map.assembledTotalSec).toBe(8);
		// Every kept source point must survive a source -> assembled -> source trip.
		for (const s of [0, 1.5, 1.99, 4.0, 5.5, 6.9, 9.0, 10.25, 12]) {
			const a = map.toAssembled(s);
			expect(map.toSource(a)).toBeCloseTo(s, 6);
		}
		// And an assembled point survives assembled -> source -> assembled.
		for (const a of [0, 1.5, 2.0, 3.5, 4.9, 6.0, 8]) {
			const s = map.toSource(a);
			expect(map.toAssembled(s)).toBeCloseTo(a, 6);
		}
	});

	test("assembled point landing exactly on a cut boundary resolves by edge", () => {
		// Remove [3,5). The kept spans meet in assembled coords at t=3
		// (source 3 = end of the first kept run, source 5 = start of the second).
		const map = buildCoordinateMap({ removals: [{ startSec: 3, endSec: 5 }], totalSec: 10 });
		// "end" edge => the content BEFORE the collapse (source 3).
		expect(map.toSource(3, "end")).toBeCloseTo(3, 9);
		// "start" edge => the content AFTER the collapse (source 5).
		expect(map.toSource(3, "start")).toBeCloseTo(5, 9);
	});

	test("a source point inside a removed span snaps to the collapse seam", () => {
		const map = buildCoordinateMap({ removals: [{ startSec: 3, endSec: 5 }], totalSec: 10 });
		// Anything in [3,5) collapses to assembled 3.
		expect(map.toAssembled(3)).toBeCloseTo(3, 9);
		expect(map.toAssembled(4)).toBeCloseTo(3, 9);
		expect(map.toAssembled(4.99)).toBeCloseTo(3, 9);
	});

	test("everything removed yields an empty assembled timeline", () => {
		const map = buildCoordinateMap({ removals: [{ startSec: 0, endSec: 10 }], totalSec: 10 });
		expect(map.assembledTotalSec).toBe(0);
		expect(map.keptSpans.length).toBe(0);
		// Degenerate but total: any query resolves to 0 rather than NaN.
		expect(map.toSource(0)).toBe(0);
		expect(map.toAssembled(5)).toBe(0);
	});

	test("overlapping/touching removal input is unioned before mapping", () => {
		// [2,4) and [3,6) overlap -> a single [2,6) removal (4s).
		const map = buildCoordinateMap({
			removals: [
				{ startSec: 2, endSec: 4 },
				{ startSec: 3, endSec: 6 },
			],
			totalSec: 10,
		});
		expect(map.assembledTotalSec).toBe(6);
		expect(map.keptSpans.length).toBe(2);
		expect(map.toSource(2)).toBeCloseTo(6, 9); // assembled 2 = source 6 (after the union)
	});

	test("cut boundaries are clamped into [0, totalSec]", () => {
		const map = buildCoordinateMap({
			removals: [{ startSec: -5, endSec: 3 }, { startSec: 8, endSec: 20 }],
			totalSec: 10,
		});
		// Removes [0,3) and [8,10): 5s. Assembled total 5.
		expect(map.assembledTotalSec).toBe(5);
		expect(map.toSource(0)).toBeCloseTo(3, 9);
	});
});

describe("buildVirtualTimeline", () => {
	const words: WordTiming[] = [
		{ text: "a", start: 0, end: 0.5 },
		{ text: "b", start: 0.5, end: 1.0 },
		{ text: "c", start: 3.0, end: 3.5 }, // midpoint 3.25, inside the cut -> dropped
		{ text: "d", start: 5.0, end: 5.5 },
		{ text: "e", start: 5.5, end: 6.0 },
	];
	const segments: TranscriptSegment[] = [
		{ text: "a b", start: 0, end: 1.0 },
		{ text: "c", start: 3.0, end: 3.5 }, // midpoint inside the cut -> dropped
		{ text: "d e", start: 5.0, end: 6.0 },
	];
	const features: SpeechFeatures[] = segments.map((s) => ({
		startSec: s.start,
		endSec: s.end,
		energy: 0.1,
		loudnessRelative: 0.8,
		wpm: 150,
		wordCount: 2,
		fillerCandidate: false,
	}));

	test("drops words/segments whose midpoint is inside an accepted removal, remaps the rest", () => {
		const vt = buildVirtualTimeline({
			words,
			segments,
			features,
			envelope: [],
			windowSec: 0.02,
			ops: [cut(2, 4.5)], // removes 2.5s that contains word/segment "c"
			totalSec: 6,
		});
		expect(vt.removedSec).toBeCloseTo(2.5, 9);
		expect(vt.words.map((w) => w.text)).toEqual(["a", "b", "d", "e"]);
		// "d" started at source 5; after removing 2.5s before it, assembled 2.5.
		const d = vt.words.find((w) => w.text === "d")!;
		expect(d.start).toBeCloseTo(2.5, 9);
		expect(vt.segments.map((s) => s.text)).toEqual(["a b", "d e"]);
		// Features stay parallel to the surviving segments and carry remapped bounds.
		expect(vt.features.length).toBe(2);
		expect(vt.features[1].startSec).toBeCloseTo(2.5, 9);
	});

	test("no accepted removals -> identity assembled state", () => {
		const vt = buildVirtualTimeline({
			words,
			segments,
			features,
			envelope: [],
			windowSec: 0.02,
			ops: [],
			totalSec: 6,
		});
		expect(vt.removedSec).toBe(0);
		expect(vt.words.length).toBe(words.length);
		expect(vt.words[2].start).toBeCloseTo(3.0, 9);
	});

	test("OFFERED (opt-in) removals are not applied to the assembled state", () => {
		const offered: DirectorOp = { ...cut(2, 4.5), defaultAccept: false };
		const vt = buildVirtualTimeline({
			words,
			segments,
			features,
			envelope: [],
			windowSec: 0.02,
			ops: [offered],
			totalSec: 6,
		});
		expect(vt.removedSec).toBe(0);
		expect(vt.words.length).toBe(words.length);
	});

	test("remaps the energy envelope onto the assembled timeline", () => {
		// 6s of 0.02s windows = 300 windows; make the source envelope a ramp so we
		// can see the shift. Remove [0,3): the assembled envelope should start at
		// what was source-3s.
		const windowSec = 0.02;
		const srcLen = Math.ceil(6 / windowSec);
		const envelope = Array.from({ length: srcLen }, (_, i) => i);
		const vt = buildVirtualTimeline({
			words,
			segments,
			features,
			envelope,
			windowSec,
			ops: [cut(0, 3)],
			totalSec: 6,
		});
		// Assembled window 0 (mid 0.01s) maps to source ~3.01s -> index ~150.
		expect(vt.envelope.length).toBe(Math.ceil(3 / windowSec));
		expect(vt.envelope[0]).toBeGreaterThan(140);
		expect(vt.envelope[0]).toBeLessThan(160);
	});
});

describe("remapEnvelope", () => {
	test("empty envelope or non-positive window yields []", () => {
		const map = buildCoordinateMap({ removals: [], totalSec: 5 });
		expect(remapEnvelope({ envelope: [], windowSec: 0.02, map })).toEqual([]);
		expect(remapEnvelope({ envelope: [1, 2, 3], windowSec: 0, map })).toEqual([]);
	});
});

describe("mapAssembledOpsToSource", () => {
	test("maps a cut in assembled coords back across a P1 seam", () => {
		// P1 removed [3,5). A P2 cut over assembled [2.5, 3.5) selects content that
		// spans the seam: source 2.5..(3 collapse)..5.5.
		const map = buildCoordinateMap({ removals: [{ startSec: 3, endSec: 5 }], totalSec: 10 });
		const p2: DirectorOp = cut(2.5, 3.5, "assembled");
		const [mapped] = mapAssembledOpsToSource({ ops: [p2], map });
		expect(mapped.startSec).toBeCloseTo(2.5, 6);
		expect(mapped.endSec).toBeCloseTo(5.5, 6);
		expect(mapped.id.startsWith("p2-")).toBe(true);
	});

	test("drops non-removal ops (keep/reorder) and zero-length spans", () => {
		const map = buildCoordinateMap({ removals: [], totalSec: 10 });
		const keep: DirectorOp = { id: "k", op: "keep", startSec: 1, endSec: 2, reason: "", confidence: 1 };
		const reorder: DirectorOp = { id: "r", op: "reorder", startSec: 1, endSec: 2, reason: "", confidence: 1, targetStartSec: 5 };
		expect(mapAssembledOpsToSource({ ops: [keep, reorder], map }).length).toBe(0);
	});
});

describe("tagSecondPass", () => {
	test("prefixes the reason (idempotently) and forces the row OFFERED", () => {
		const op: DirectorOp = { ...cut(1, 2), reason: "residual filler", category: "llm" };
		const tagged = tagSecondPass(op);
		expect(tagged.reason).toBe(`${SECOND_PASS_REASON_PREFIX}residual filler`);
		expect(tagged.defaultAccept).toBe(false);
		// Idempotent: tagging again does not double the prefix.
		expect(tagSecondPass(tagged).reason).toBe(tagged.reason);
	});

	test("drops the redundancy group link (no review group to swap against)", () => {
		const op: DirectorOp = { ...cut(1, 2), category: "redundancy", groupId: "g0" };
		expect(tagSecondPass(op).groupId).toBeUndefined();
	});
});
