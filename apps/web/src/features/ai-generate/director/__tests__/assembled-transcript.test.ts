import { describe, expect, test } from "bun:test";
import type { DirectorOp } from "@framecut/hf-bridge";
import {
	buildAssembledTranscript,
	collectJoinFragments,
	CUT_MARKER,
	JOIN_CONTEXT_WORDS,
	WINDOW_CONTEXT_WORDS,
} from "../assembled-transcript";
import type { WordTiming } from "../cut-utils";

/**
 * The assembled-transcript builder (round 12 U2/R3): the post-cut text the
 * final read judges. Words removed by default-accepted cuts vanish, seams where
 * two kept runs meet across a removal carry the [CUT] marker, and past the
 * character cap the full text gives way to timestamped windows centered on the
 * join fragments.
 */

/** Word i spans [0.3i, 0.3i + 0.28] with text `t<i>` (or from a list). */
function mkWords(n: number, texts?: string[]): WordTiming[] {
	return Array.from({ length: n }, (_, i) => ({
		text: texts?.[i] ?? `t${i}`,
		start: i * 0.3,
		end: i * 0.3 + 0.28,
	}));
}

const cut = (
	o: Partial<DirectorOp> & { id: string; startSec: number; endSec: number },
): DirectorOp => ({
	op: "cut",
	reason: "r",
	confidence: 0.7,
	...o,
});

/** A cut spanning words [a, b] inclusive (midpoint containment at 0.3 spacing). */
const cutWords = (id: string, a: number, b: number, extra: Partial<DirectorOp> = {}) =>
	cut({ id, startSec: a * 0.3, endSec: (b + 1) * 0.3, ...extra });

describe("buildAssembledTranscript (cuts applied, markers at seams)", () => {
	test("removed words vanish and one marker sits at each seam, in order", () => {
		const words = mkWords(10);
		// Two separate accepted cuts: words 2-3 and words 6-7.
		const out = buildAssembledTranscript({
			words,
			ops: [cutWords("c1", 2, 3), cutWords("c2", 6, 7)],
		});
		expect(out).toBe(`t0 t1 ${CUT_MARKER} t4 t5 ${CUT_MARKER} t8 t9`);
	});

	test("an OFFERED removal is NOT applied (its words stay, no marker)", () => {
		const words = mkWords(6);
		const out = buildAssembledTranscript({
			words,
			ops: [cutWords("c1", 2, 3, { defaultAccept: false })],
		});
		expect(out).toBe("t0 t1 t2 t3 t4 t5");
	});

	test("keep and reorder ops never remove words", () => {
		const words = mkWords(4);
		const out = buildAssembledTranscript({
			words,
			ops: [
				cut({ id: "k", op: "keep", startSec: 0, endSec: 1.2 }),
				cut({ id: "m", op: "reorder", startSec: 0, endSec: 0.9, targetStartSec: 2 }),
			],
		});
		expect(out).toBe("t0 t1 t2 t3");
	});

	test("no leading or trailing marker, and touching cuts read as ONE seam", () => {
		const words = mkWords(8);
		// A leading cut, a trailing cut, and two ADJACENT mid cuts sharing an edge.
		const out = buildAssembledTranscript({
			words,
			ops: [
				cutWords("lead", 0, 0),
				cutWords("m1", 3, 4),
				cutWords("m2", 5, 5), // touches m1: merged, one seam
				cutWords("tail", 7, 7),
			],
		});
		expect(out).toBe(`t1 t2 ${CUT_MARKER} t6`);
	});

	test("empty words and an all-removed transcript yield empty text", () => {
		expect(buildAssembledTranscript({ words: [], ops: [] })).toBe("");
		expect(
			buildAssembledTranscript({ words: mkWords(3), ops: [cutWords("all", 0, 2)] }),
		).toBe("");
	});

	test("under the cap the FULL text returns (no windows)", () => {
		const words = mkWords(20);
		const out = buildAssembledTranscript({
			words,
			ops: [cutWords("c1", 5, 6)],
			joinSpans: [{ startSec: 1, endSec: 2 }],
		});
		expect(out).not.toContain("[window");
		expect(out).toContain(`t4 ${CUT_MARKER} t7`);
	});
});

describe("buildAssembledTranscript (windowing past the cap)", () => {
	// 800 words with a stranded fragment at word 400: accepted cuts over words
	// 398-399 and 401-402 leave t400 stranded between two seams.
	const words = mkWords(800);
	const ops = [cutWords("a", 398, 399), cutWords("b", 401, 402)];
	// The join gap between the two cuts (what the fragment row spans).
	const joinSpan = { startSec: 400 * 0.3, endSec: 401 * 0.3 };

	test("over the cap, timestamped windows around each join replace the full text", () => {
		const out = buildAssembledTranscript({
			words,
			ops,
			joinSpans: [joinSpan],
			maxChars: 1000,
		});
		// One window, labeled with real start/end timestamps.
		expect(out.startsWith("[window ")).toBe(true);
		expect(out).toMatch(/^\[window \d+\.\ds-\d+\.\ds\]\n/);
		// The fragment and BOTH seams are in view.
		expect(out).toContain(`${CUT_MARKER} t400 ${CUT_MARKER} t403`);
		// The window is centered: WINDOW_CONTEXT_WORDS kept words each side, so the
		// far ends of the transcript are excluded.
		expect(out).not.toContain("t0 ");
		expect(out).not.toContain(" t100 ");
		expect(out).not.toContain(" t790");
		// The nearest context IS included (kept index of t400 is 398, so the window
		// floor is kept index 398 - WINDOW_CONTEXT_WORDS = 248 -> word t248).
		expect(out).toContain(`t${398 - WINDOW_CONTEXT_WORDS}`);
		expect(out.length).toBeLessThan(4000);
	});

	test("overlapping windows merge into one (no duplicated text)", () => {
		const out = buildAssembledTranscript({
			words,
			ops,
			joinSpans: [joinSpan, { startSec: joinSpan.startSec + 0.1, endSec: joinSpan.endSec }],
			maxChars: 1000,
		});
		expect(out.match(/\[window /g)?.length).toBe(1);
	});

	test("with no join spans an oversized text truncates at a word boundary", () => {
		const out = buildAssembledTranscript({ words, ops: [], maxChars: 200 });
		expect(out).toContain("[TRUNCATED]");
		expect(out.length).toBeLessThanOrEqual(200 + "\n[TRUNCATED]".length);
	});
});

describe("collectJoinFragments", () => {
	// Accepted cuts over words 20-22 and 24-26 strand word 23; the join op spans
	// the gap between them, exactly as detectJoinTextureCuts mints it.
	const words = mkWords(40);
	const ops = [cutWords("a", 20, 22), cutWords("b", 24, 26)];
	const joinOp = cut({
		id: "join-x",
		startSec: 23 * 0.3,
		endSec: 24 * 0.3,
		reason: 'Stranded between two cuts: "t23" - swallow it?',
		category: "join",
		defaultAccept: false,
	});

	test("a fragment row carries the op id, stranded text, span, and KEPT context each side", () => {
		const [frag, ...rest] = collectJoinFragments({ ops, joinOps: [joinOp], words });
		expect(rest).toEqual([]);
		expect(frag.id).toBe("join-x");
		expect(frag.text).toBe("t23");
		expect(frag.startSec).toBe(joinOp.startSec);
		expect(frag.endSec).toBe(joinOp.endSec);
		// Context BEFORE: the last JOIN_CONTEXT_WORDS kept words - the removed words
		// 20-22 never appear (the model reads the fragment as the cut strands it).
		const beforeWords = frag.contextBefore.split(" ");
		expect(beforeWords).toHaveLength(JOIN_CONTEXT_WORDS);
		expect(beforeWords[beforeWords.length - 1]).toBe("t19");
		expect(beforeWords[0]).toBe(`t${20 - JOIN_CONTEXT_WORDS}`);
		expect(frag.contextBefore).not.toContain("t20");
		// Context AFTER: kept words resume at t27 (24-26 removed); only 13 remain.
		const afterWords = frag.contextAfter.split(" ");
		expect(afterWords[0]).toBe("t27");
		expect(afterWords).toHaveLength(13);
		expect(frag.contextAfter).not.toContain("t26");
	});

	test("AUTO sliver joins and non-join ops are never fragments", () => {
		const sliver = cut({
			id: "join-sliver",
			startSec: 23 * 0.3,
			endSec: 24 * 0.3,
			category: "join",
			// No defaultAccept: an accepted AUTO row, not an OFFERED fragment.
		});
		const offeredRetake = cut({
			id: "r1",
			startSec: 23 * 0.3,
			endSec: 24 * 0.3,
			category: "retake",
			defaultAccept: false,
		});
		expect(
			collectJoinFragments({ ops, joinOps: [sliver, offeredRetake], words }),
		).toEqual([]);
	});

	test("a join op whose span holds no kept word is skipped (defensive)", () => {
		const wordless = cut({
			id: "join-empty",
			startSec: 200,
			endSec: 201,
			category: "join",
			defaultAccept: false,
		});
		expect(collectJoinFragments({ ops, joinOps: [wordless], words })).toEqual([]);
	});
});
