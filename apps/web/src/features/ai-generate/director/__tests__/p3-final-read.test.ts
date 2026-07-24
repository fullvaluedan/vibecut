import { describe, expect, test } from "bun:test";
import {
	applyHarmVerdicts,
	collectHarmCandidates,
	HARM_REVERT_MIN_CONFIDENCE,
	HARM_REVIEW_MIN_SEC,
} from "../p3-final-read";
import type { DirectorOp, VerifyHarmVerdict } from "@framecut/hf-bridge";
import type { WordTiming } from "../cut-utils";

/**
 * Tests for the P3 harm/texture wiring (round 14 U2). collectHarmCandidates builds
 * the default-accepted-cut review list (substantial cuts + borderline micro-cuts)
 * with the assembled seam context; applyHarmVerdicts demotes a confident "revert"
 * to offered-off and NEVER deletes a row.
 */

const op = (o: Partial<DirectorOp> & { id: string }): DirectorOp => ({
	op: "cut",
	startSec: 0,
	endSec: 1,
	reason: "r",
	confidence: 0.7,
	...o,
});

const wordRun = (from: number, count: number): WordTiming[] =>
	Array.from({ length: count }, (_, i) => ({
		text: `w${from + i}`,
		start: from + i,
		end: from + i + 0.4,
	}));

describe("collectHarmCandidates", () => {
	// Words 0..19 (one per second). A 2s cut over [5,7) removes w5,w6.
	const words = wordRun(0, 20);

	test("a substantial cut becomes a candidate carrying its removed + context text", () => {
		const cut = op({ id: "c", startSec: 5, endSec: 7, category: "llm" });
		const [cand, ...rest] = collectHarmCandidates({ ops: [cut], words });
		expect(rest).toHaveLength(0);
		expect(cand.id).toBe("c");
		expect(cand.texture).toBe(false);
		expect(cand.removedText).toBe("w5 w6");
		// contextBefore = kept words just before the cut; contextAfter = just after.
		expect(cand.contextBefore.endsWith("w4")).toBe(true);
		expect(cand.contextAfter.startsWith("w7")).toBe(true);
	});

	test("a short cut is skipped unless flagged borderline", () => {
		const shortCut = op({ id: "s", startSec: 5.0, endSec: 5.3, category: "llm" });
		expect(collectHarmCandidates({ ops: [shortCut], words })).toEqual([]);
		const [cand] = collectHarmCandidates({
			ops: [shortCut],
			words,
			borderlineIds: ["s"],
		});
		expect(cand.id).toBe("s");
		expect(cand.texture).toBe(true);
	});

	test("offered rows and join cuts are never harm candidates", () => {
		const offered = op({ id: "o", startSec: 5, endSec: 7, category: "llm", defaultAccept: false });
		const join = op({ id: "j", startSec: 5, endSec: 7, category: "join" });
		expect(collectHarmCandidates({ ops: [offered, join], words })).toEqual([]);
	});

	test("the candidate budget is respected, keeping borderline rows first", () => {
		const ops: DirectorOp[] = [
			op({ id: "big1", startSec: 2, endSec: 5, category: "llm" }),
			op({ id: "big2", startSec: 8, endSec: 12, category: "llm" }),
			op({ id: "micro", startSec: 6.0, endSec: 6.3, category: "llm" }),
		];
		const out = collectHarmCandidates({
			ops,
			words,
			borderlineIds: ["micro"],
			maxCandidates: 1,
		});
		expect(out).toHaveLength(1);
		expect(out[0].id).toBe("micro"); // texture row survives the cap
	});

	test("HARM_REVIEW_MIN_SEC is the documented substantial-cut bar", () => {
		expect(HARM_REVIEW_MIN_SEC).toBe(1.5);
	});
});

describe("applyHarmVerdicts", () => {
	const cut = op({ id: "c", startSec: 5, endSec: 7, category: "llm", reason: "removed a point" });

	test("a confident revert demotes to offered-off and annotates the reason", () => {
		const verdicts: VerifyHarmVerdict[] = [
			{ id: "c", verdict: "revert", confidence: 0.9 },
		];
		const out = applyHarmVerdicts({ ops: [cut], verdicts });
		expect(out).toHaveLength(1); // never deleted
		expect(out[0].defaultAccept).toBe(false);
		expect(out[0].reason).toContain("removed a point");
		expect(out[0].reason).toContain("final read");
	});

	test("a low-confidence revert leaves the cut default-accepted", () => {
		const verdicts: VerifyHarmVerdict[] = [
			{ id: "c", verdict: "revert", confidence: HARM_REVERT_MIN_CONFIDENCE - 0.05 },
		];
		expect(applyHarmVerdicts({ ops: [cut], verdicts })).toEqual([cut]);
	});

	test("a keep verdict, an unknown id, or an empty list is a no-op", () => {
		expect(
			applyHarmVerdicts({ ops: [cut], verdicts: [{ id: "c", verdict: "keep", confidence: 0.99 }] }),
		).toEqual([cut]);
		expect(
			applyHarmVerdicts({ ops: [cut], verdicts: [{ id: "zzz", verdict: "revert", confidence: 0.99 }] }),
		).toEqual([cut]);
		expect(applyHarmVerdicts({ ops: [cut], verdicts: [] })).toEqual([cut]);
	});

	test("an already-offered row is never touched", () => {
		const offered = op({ id: "c", startSec: 5, endSec: 7, category: "llm", defaultAccept: false });
		const verdicts: VerifyHarmVerdict[] = [{ id: "c", verdict: "revert", confidence: 0.99 }];
		expect(applyHarmVerdicts({ ops: [offered], verdicts })).toEqual([offered]);
	});
});
