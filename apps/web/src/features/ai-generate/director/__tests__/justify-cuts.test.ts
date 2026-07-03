import { describe, expect, test } from "bun:test";
import { justifyCuts } from "../justify-cuts";
import type { WordTiming } from "../cut-utils";
import type { DirectorOp, DirectorOpCategory } from "@framecut/hf-bridge";

// 30fps -> the shared 15-frame floor is 0.5s.
const FLOOR_SEC = 0.5;

const word = (text: string, start: number, end: number): WordTiming => ({ text, start, end });

const cut = ({
	startSec,
	endSec,
	category,
	reason = "",
	op = "cut",
}: {
	startSec: number;
	endSec: number;
	category?: DirectorOpCategory;
	reason?: string;
	op?: DirectorOp["op"];
}): DirectorOp => ({
	id: `${op}-${startSec}-${endSec}`,
	op,
	startSec,
	endSec,
	reason,
	confidence: 0.6,
	...(category ? { category } : {}),
});

// Two content words spoken back-to-back with a tiny 0.2s (< floor) space between
// them: a cut in that space splices continuous speech.
const continuous: WordTiming[] = [word("hello", 0, 0.5), word("world", 0.7, 1.2)];
// A real 1.0s pause between the two words: a sub-floor cut here trims silence.
const pause: WordTiming[] = [word("hello", 0, 0.5), word("world", 1.5, 2.0)];

describe("justifyCuts (2P-U5 / R9)", () => {
	test("a sub-floor cut between two content words WITH a real reason is kept", () => {
		const ops = [cut({ startSec: 0.5, endSec: 0.7, category: "filler", reason: "filler: um" })];
		expect(justifyCuts({ ops, words: continuous, floorSec: FLOOR_SEC })).toEqual(ops);
	});

	test("a sub-floor pacing cut splicing continuous speech is dropped (unjustified)", () => {
		const ops = [cut({ startSec: 0.5, endSec: 0.7, category: "pacing" })];
		expect(justifyCuts({ ops, words: continuous, floorSec: FLOOR_SEC })).toHaveLength(0);
	});

	test("a sub-floor uncategorised cut with no reason splicing speech is dropped", () => {
		const ops = [cut({ startSec: 0.5, endSec: 0.7 })];
		expect(justifyCuts({ ops, words: continuous, floorSec: FLOOR_SEC })).toHaveLength(0);
	});

	test("an over-floor cut is never dropped, whatever its reason", () => {
		const ops = [cut({ startSec: 0.5, endSec: 1.3, category: "pacing" })]; // 0.8s >= floor
		expect(justifyCuts({ ops, words: continuous, floorSec: FLOOR_SEC })).toEqual(ops);
	});

	test("a sub-floor pacing cut inside a REAL pause is kept (silence removal)", () => {
		const ops = [cut({ startSec: 0.6, endSec: 0.75, category: "pacing" })];
		expect(justifyCuts({ ops, words: pause, floorSec: FLOOR_SEC })).toEqual(ops);
	});

	test("with no transcript nothing is dropped (fail-open)", () => {
		const ops = [cut({ startSec: 0.5, endSec: 0.7, category: "pacing" })];
		expect(justifyCuts({ ops, words: [], floorSec: FLOOR_SEC })).toEqual(ops);
		expect(justifyCuts({ ops, floorSec: FLOOR_SEC })).toEqual(ops);
	});

	test("take_select and reorder ops are never dropped", () => {
		const ops = [
			cut({ startSec: 0.5, endSec: 0.7, op: "take_select" }),
			cut({ startSec: 0.5, endSec: 0.7, op: "reorder" }),
		];
		expect(justifyCuts({ ops, words: continuous, floorSec: FLOOR_SEC })).toEqual(ops);
	});

	test("an uncategorised cut that DOES carry a reason is kept (raw LLM cut)", () => {
		const ops = [cut({ startSec: 0.5, endSec: 0.7, reason: "off-topic aside" })];
		expect(justifyCuts({ ops, words: continuous, floorSec: FLOOR_SEC })).toEqual(ops);
	});

	test("only the unjustified cut is dropped; justified neighbours survive", () => {
		const words: WordTiming[] = [
			word("one", 0, 0.5),
			word("two", 0.7, 1.2),
			word("three", 1.4, 1.9),
		];
		const ops = [
			cut({ startSec: 0.5, endSec: 0.7, category: "pacing" }), // spliced speech -> drop
			cut({ startSec: 1.2, endSec: 1.4, category: "filler", reason: "um" }), // justified -> keep
		];
		const out = justifyCuts({ ops, words, floorSec: FLOOR_SEC });
		expect(out).toHaveLength(1);
		expect(out[0].category).toBe("filler");
	});
});
