import { describe, expect, test } from "bun:test";
import {
	FRAGMENT_MAX_WORDS,
	SILENT_SLIVER_MAX_SEC,
	detectJoinTextureCuts,
} from "../join-texture";
import type { WordTiming } from "../cut-utils";
import type { DirectorOp } from "@framecut/hf-bridge";

const word = (text: string, start: number, end: number): WordTiming => ({ text, start, end });

const cut = ({
	startSec,
	endSec,
	op = "cut",
	defaultAccept,
}: {
	startSec: number;
	endSec: number;
	op?: DirectorOp["op"];
	defaultAccept?: boolean;
}): DirectorOp => ({
	id: `${op}-${startSec}-${endSec}`,
	op,
	startSec,
	endSec,
	reason: "test cut",
	confidence: 0.8,
	...(defaultAccept === undefined ? {} : { defaultAccept }),
});

describe("detectJoinTextureCuts (round 12 U1)", () => {
	test("a wordless sub-0.5s sliver between two accepted cuts is swallowed AUTO", () => {
		const ops = [cut({ startSec: 0, endSec: 5 }), cut({ startSec: 5.05, endSec: 10 })];
		const joins = detectJoinTextureCuts({ ops, words: [] });
		expect(joins).toHaveLength(1);
		const j = joins[0];
		expect(j.op).toBe("cut");
		expect(j.category).toBe("join");
		expect(j.startSec).toBe(5);
		expect(j.endSec).toBe(5.05);
		expect(j.id.startsWith("join-")).toBe(true);
		expect(j.reason).toContain("Silent sliver");
		// AUTO: the field is OMITTED when accepted (redundancy-apply convention).
		expect("defaultAccept" in j).toBe(false);
	});

	test("a wordless gap LONGER than the sliver ceiling is left alone (a real pause)", () => {
		const ops = [
			cut({ startSec: 0, endSec: 5 }),
			cut({ startSec: 5 + SILENT_SLIVER_MAX_SEC + 0.2, endSec: 10 }),
		];
		expect(detectJoinTextureCuts({ ops, words: [] })).toHaveLength(0);
	});

	test("a stranded word fragment is OFFERED (defaultAccept false) and the reason quotes it", () => {
		const ops = [cut({ startSec: 0, endSec: 5 }), cut({ startSec: 6, endSec: 10 })];
		const words = [word("so...", 5.2, 5.5)];
		const joins = detectJoinTextureCuts({ ops, words });
		expect(joins).toHaveLength(1);
		const j = joins[0];
		expect(j.category).toBe("join");
		expect(j.defaultAccept).toBe(false);
		expect(j.startSec).toBe(5);
		expect(j.endSec).toBe(6);
		expect(j.reason).toBe('Stranded between two cuts: "so..." - swallow it?');
	});

	test("a fragment of MORE than FRAGMENT_MAX_WORDS words is real content, never flagged", () => {
		const ops = [cut({ startSec: 0, endSec: 5 }), cut({ startSec: 8, endSec: 10 })];
		const words = Array.from({ length: FRAGMENT_MAX_WORDS + 1 }, (_, i) =>
			word(`w${i}`, 5.2 + i * 0.4, 5.5 + i * 0.4),
		);
		expect(detectJoinTextureCuts({ ops, words })).toHaveLength(0);
	});

	test("a fragment of exactly FRAGMENT_MAX_WORDS words is still offered", () => {
		const ops = [cut({ startSec: 0, endSec: 5 }), cut({ startSec: 8, endSec: 10 })];
		const words = Array.from({ length: FRAGMENT_MAX_WORDS }, (_, i) =>
			word(`w${i}`, 5.2 + i * 0.4, 5.5 + i * 0.4),
		);
		const joins = detectJoinTextureCuts({ ops, words });
		expect(joins).toHaveLength(1);
		expect(joins[0].defaultAccept).toBe(false);
		expect(joins[0].reason).toContain('"w0 w1 w2 w3"');
	});

	test("a gap beside an OFFERED (defaultAccept false) cut is not a join", () => {
		const ops = [
			cut({ startSec: 0, endSec: 5 }),
			cut({ startSec: 5.05, endSec: 10, defaultAccept: false }),
		];
		expect(detectJoinTextureCuts({ ops, words: [] })).toHaveLength(0);
	});

	test("overlapping input cuts merge into ONE span before pairing", () => {
		// [0,3] and [2,5] overlap -> one region [0,5]; the only join is its sliver
		// against [5.05,10], never an op between the two overlapping cuts.
		const ops = [
			cut({ startSec: 0, endSec: 3 }),
			cut({ startSec: 2, endSec: 5 }),
			cut({ startSec: 5.05, endSec: 10 }),
		];
		const joins = detectJoinTextureCuts({ ops, words: [] });
		expect(joins).toHaveLength(1);
		expect(joins[0].startSec).toBe(5);
		expect(joins[0].endSec).toBe(5.05);
	});

	test("touching cuts (shared edge) mint no zero-width join", () => {
		const ops = [cut({ startSec: 0, endSec: 5 }), cut({ startSec: 5, endSec: 10 })];
		expect(detectJoinTextureCuts({ ops, words: [] })).toHaveLength(0);
	});

	test("non-removal ops (keep/reorder) never form a join side", () => {
		const ops = [
			cut({ startSec: 0, endSec: 5 }),
			cut({ startSec: 5.05, endSec: 10, op: "keep" }),
		];
		expect(detectJoinTextureCuts({ ops, words: [] })).toHaveLength(0);
	});

	test("take_select spans pair like cuts", () => {
		const ops = [
			cut({ startSec: 0, endSec: 5, op: "take_select" }),
			cut({ startSec: 5.05, endSec: 10 }),
		];
		expect(detectJoinTextureCuts({ ops, words: [] })).toHaveLength(1);
	});

	test("word midpoint containment decides membership: a word straddling the gap edge with its midpoint inside counts", () => {
		const ops = [cut({ startSec: 0, endSec: 5 }), cut({ startSec: 5.3, endSec: 10 })];
		// Midpoint 5.15 sits inside (5, 5.3): one kept word -> OFFERED, not AUTO.
		const words = [word("hm", 5.0, 5.3)];
		const joins = detectJoinTextureCuts({ ops, words });
		expect(joins).toHaveLength(1);
		expect(joins[0].defaultAccept).toBe(false);
	});
});
