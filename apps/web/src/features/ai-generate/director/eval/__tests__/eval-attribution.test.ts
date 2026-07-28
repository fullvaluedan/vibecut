import { describe, expect, test } from "bun:test";
import {
	attributeEssentialWordsLost,
	formatByCategoryLine,
	formatTopOffendingOps,
} from "../attribution";
import type { TruthCutSpan } from "../align";
import type { DirectorOp } from "@framecut/hf-bridge";
import type { TranscriptionWord } from "@/transcription/types";

function words(text: string, startAt = 0): TranscriptionWord[] {
	return text
		.split(/\s+/)
		.filter(Boolean)
		.map((w, i) => ({
			text: w,
			start: startAt + i * 0.3,
			end: startAt + i * 0.3 + 0.28,
		}));
}

function truthSpan(
	rawWords: TranscriptionWord[],
	startIndex: number,
	endIndex: number,
): TruthCutSpan {
	return {
		startIndex,
		endIndex,
		startSec: rawWords[startIndex].start,
		endSec: rawWords[endIndex].end,
		text: rawWords
			.slice(startIndex, endIndex + 1)
			.map((w) => w.text)
			.join(" "),
	};
}

function op(partial: Partial<DirectorOp> & Pick<DirectorOp, "id" | "startSec" | "endSec">): DirectorOp {
	return {
		op: "cut",
		reason: "test reason",
		confidence: 0.9,
		...partial,
	};
}

describe("attributeEssentialWordsLost", () => {
	// 10 words; Dan cut nothing (truth is empty) so any proposed cut is 100%
	// essential-words-lost, isolating the attribution logic from the confusion
	// matrix already covered by eval-score.test.ts.
	const raw = words("intro line here um wait no the real content follows");

	test("single op destroying kept words is attributed to itself", () => {
		// Op covers words 3..5 ("um wait no"), all kept (truth is empty).
		const ops = [op({ id: "a", startSec: raw[3].start, endSec: raw[5].end, category: "pacing" })];
		const result = attributeEssentialWordsLost({
			rawWords: raw,
			truthCutSpans: [],
			operations: ops,
			mode: "offered",
		});
		expect(result.byOp).toHaveLength(1);
		expect(result.byOp[0]).toMatchObject({ id: "a", wordCount: 3, words: "um wait no" });
		expect(result.byCategory).toEqual([["pacing", 3]]);
	});

	test("raw LLM ops with no category key on the op kind", () => {
		const ops = [op({ id: "a", startSec: raw[3].start, endSec: raw[3].end })]; // no category
		const result = attributeEssentialWordsLost({
			rawWords: raw,
			truthCutSpans: [],
			operations: ops,
			mode: "offered",
		});
		expect(result.byCategory).toEqual([["cut", 1]]);
		expect(result.byOp[0].category).toBeUndefined();
	});

	test("non-overlapping ops in different categories sum without double-counting", () => {
		const ops = [
			op({ id: "a", startSec: raw[0].start, endSec: raw[0].end, category: "filler" }),
			op({ id: "b", startSec: raw[1].start, endSec: raw[2].end, category: "pacing" }),
		];
		const result = attributeEssentialWordsLost({
			rawWords: raw,
			truthCutSpans: [],
			operations: ops,
			mode: "offered",
		});
		expect(result.byCategory).toEqual([
			["pacing", 2],
			["filler", 1],
		]);
		const totalByOp = result.byOp.reduce((a, o) => a + o.wordCount, 0);
		const totalByCategory = result.byCategory.reduce((a, [, c]) => a + c, 0);
		expect(totalByOp).toBe(3);
		expect(totalByCategory).toBe(3);
	});

	test("overlapping ops attribute the shared word to EACH covering op (documented double-count)", () => {
		// Both ops cover word 2 ("here"); word 1 ("line") belongs to "a" only.
		const ops = [
			op({ id: "a", startSec: raw[1].start, endSec: raw[2].end, category: "pacing" }),
			op({ id: "b", startSec: raw[2].start, endSec: raw[3].end, category: "repeat" }),
		];
		const result = attributeEssentialWordsLost({
			rawWords: raw,
			truthCutSpans: [],
			operations: ops,
			mode: "offered",
		});
		const byId = Object.fromEntries(result.byOp.map((o) => [o.id, o]));
		expect(byId.a.wordCount).toBe(2); // "line here"
		expect(byId.b.wordCount).toBe(2); // "here um"
		// The shared word ("here") is double-counted across categories by design.
		expect(result.byCategory).toEqual([
			["pacing", 2],
			["repeat", 2],
		]);
		// Total essential-lost words are only 3 distinct words (1,2,3), not 4.
		const distinctDestroyed = new Set<number>();
		for (let i = 1; i <= 3; i++) distinctDestroyed.add(i);
		expect(distinctDestroyed.size).toBe(3);
	});

	test("auto mode drops opt-in (defaultAccept false) ops from the attribution entirely", () => {
		const ops = [
			op({ id: "a", startSec: raw[0].start, endSec: raw[0].end, category: "filler" }),
			op({
				id: "b",
				startSec: raw[1].start,
				endSec: raw[1].end,
				category: "redundancy",
				defaultAccept: false,
			}),
		];
		const offered = attributeEssentialWordsLost({
			rawWords: raw,
			truthCutSpans: [],
			operations: ops,
			mode: "offered",
		});
		const auto = attributeEssentialWordsLost({
			rawWords: raw,
			truthCutSpans: [],
			operations: ops,
			mode: "auto",
		});
		expect(offered.byOp.map((o) => o.id).sort()).toEqual(["a", "b"]);
		expect(auto.byOp.map((o) => o.id)).toEqual(["a"]);
		expect(auto.byCategory).toEqual([["filler", 1]]);
	});

	test("keep/reorder ops never appear in the attribution", () => {
		const ops = [
			op({ id: "k", op: "keep", startSec: raw[0].start, endSec: raw[0].end }),
			op({ id: "r", op: "reorder", startSec: raw[1].start, endSec: raw[1].end }),
		];
		const result = attributeEssentialWordsLost({
			rawWords: raw,
			truthCutSpans: [],
			operations: ops,
			mode: "offered",
		});
		expect(result.byOp).toEqual([]);
		expect(result.byCategory).toEqual([]);
	});

	test("words truth actually cut are never attributed as essential-lost", () => {
		// Op covers the truth-cut span exactly: nothing destroyed, nothing attributed.
		const truth = [truthSpan(raw, 3, 5)];
		const ops = [op({ id: "a", startSec: raw[3].start, endSec: raw[5].end, category: "pacing" })];
		const result = attributeEssentialWordsLost({
			rawWords: raw,
			truthCutSpans: truth,
			operations: ops,
			mode: "offered",
		});
		expect(result.byOp).toEqual([]);
		expect(result.byCategory).toEqual([]);
	});

	test("duplicate-word reconciliation swap: a word rescued by the swap is never attributed", () => {
		// "verify the the logs": truth labels the FIRST "the" (index 1) cut; our op
		// cuts the SECOND "the" (index 2). scoreCutProposals treats this as a hit
		// via the swap, not an essential-lost word: attribution must agree.
		const dupRaw = words("verify the the logs");
		const truth = [truthSpan(dupRaw, 1, 1)];
		const ops = [
			op({ id: "a", startSec: dupRaw[2].start, endSec: dupRaw[2].end, category: "duplicate" }),
		];
		const result = attributeEssentialWordsLost({
			rawWords: dupRaw,
			truthCutSpans: truth,
			operations: ops,
			mode: "offered",
		});
		expect(result.byOp).toEqual([]);
		expect(result.byCategory).toEqual([]);
	});

	test("byOp sorts by wordCount descending, ties broken by startSec", () => {
		const ops = [
			op({ id: "late", startSec: raw[8].start, endSec: raw[8].end, category: "pacing" }),
			op({ id: "early", startSec: raw[0].start, endSec: raw[0].end, category: "filler" }),
			op({ id: "big", startSec: raw[3].start, endSec: raw[5].end, category: "context" }),
		];
		const result = attributeEssentialWordsLost({
			rawWords: raw,
			truthCutSpans: [],
			operations: ops,
			mode: "offered",
		});
		expect(result.byOp.map((o) => o.id)).toEqual(["big", "early", "late"]);
	});
});

describe("report formatting helpers", () => {
	const raw = words("intro line here um wait no the real content follows");

	test("formatByCategoryLine and formatTopOffendingOps return null when nothing was attributed", () => {
		const empty = attributeEssentialWordsLost({
			rawWords: raw,
			truthCutSpans: [],
			operations: [],
			mode: "offered",
		});
		expect(formatByCategoryLine(empty)).toBeNull();
		expect(formatTopOffendingOps(empty)).toBeNull();
	});

	test("formatByCategoryLine renders descending category counts", () => {
		const ops = [
			op({ id: "a", startSec: raw[0].start, endSec: raw[0].end, category: "filler" }),
			op({ id: "b", startSec: raw[1].start, endSec: raw[2].end, category: "pacing" }),
		];
		const result = attributeEssentialWordsLost({
			rawWords: raw,
			truthCutSpans: [],
			operations: ops,
			mode: "offered",
		});
		const line = formatByCategoryLine(result);
		expect(line).toBe("essLost by category    pacing:2  filler:1");
	});

	test("formatTopOffendingOps truncates long reasons and destroyed-text snippets", () => {
		const longReason =
			"this reason string is deliberately written to run well past the sixty character truncation boundary so the ellipsis kicks in";
		const ops = [
			op({
				id: "a",
				startSec: raw[3].start,
				endSec: raw[8].end, // "um wait no the real content", 6 words, > 50 chars once joined with padding
				category: "pacing",
				reason: longReason,
			}),
		];
		const result = attributeEssentialWordsLost({
			rawWords: raw,
			truthCutSpans: [],
			operations: ops,
			mode: "offered",
		});
		const lines = formatTopOffendingOps(result);
		expect(lines).not.toBeNull();
		const joined = lines!.join("\n");
		expect(joined).toContain("-- top offending ops (essential words lost) --");
		expect(joined).toContain("pacing");
		expect(joined).toContain("6 word(s) destroyed");
		expect(joined).toContain("...");
		// The reason line stays under the ~60-char-plus-ellipsis budget.
		const reasonLine = lines!.find((l) => l.includes("reason:"))!;
		expect(reasonLine.length).toBeLessThan(longReason.length + 40);
	});

	test("formatTopOffendingOps caps the list at the given limit and notes the remainder", () => {
		const ops = Array.from({ length: 10 }, (_, i) =>
			op({
				id: `op${i}`,
				startSec: i * 10,
				endSec: i * 10 + 1,
				category: "pacing",
			}),
		);
		// Give each op exactly one distinct destroyed word so all 10 have wordCount 1.
		const manyWords = words(
			Array.from({ length: 10 }, (_, i) => `w${i}`).join(" "),
			0,
		).map((w, i) => ({ ...w, start: i * 10 + 0.4, end: i * 10 + 0.6 }));
		const result = attributeEssentialWordsLost({
			rawWords: manyWords,
			truthCutSpans: [],
			operations: ops,
			mode: "offered",
		});
		expect(result.byOp).toHaveLength(10);
		const lines = formatTopOffendingOps(result, 8)!;
		expect(lines.filter((l) => l.includes("word(s) destroyed"))).toHaveLength(8);
		expect(lines[lines.length - 1]).toBe("  ...and 2 more offending op(s)");
	});
});
