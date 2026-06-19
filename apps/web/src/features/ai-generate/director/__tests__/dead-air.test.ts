import { describe, expect, test } from "bun:test";
import { detectDeadAirCuts } from "../dead-air";
import type { WordTiming } from "../cut-utils";

// Build a word sequence (default 0.5s/word) so spans are easy to reason about.
function seq({
	text,
	startSec = 0,
	perWord = 0.5,
}: {
	text: string;
	startSec?: number;
	perWord?: number;
}): WordTiming[] {
	return text
		.trim()
		.split(/\s+/)
		.map((t, i) => ({
			text: t,
			start: +(startSec + i * perWord).toFixed(3),
			end: +(startSec + (i + 1) * perWord).toFixed(3),
		}));
}

describe("detectDeadAirCuts", () => {
	test("cuts a sustained pure-hesitation span", () => {
		const words = seq({ text: "um uh okay um uh okay" }); // 6 tokens, 0–3.0s
		const ops = detectDeadAirCuts({ words });
		expect(ops).toHaveLength(1);
		expect(ops[0].op).toBe("cut");
		expect(ops[0].category).toBe("deadair");
		expect(ops[0].startSec).toBeCloseTo(0, 3);
		expect(ops[0].endSec).toBeCloseTo(3.0, 3);
	});

	test("bridges a SINGLE interspersed content word", () => {
		const words = seq({ text: "um uh okay so um uh okay" }); // one "so" between, 7 tokens
		const ops = detectDeadAirCuts({ words });
		expect(ops).toHaveLength(1);
		expect(ops[0].endSec).toBeCloseTo(3.5, 3); // through the last "okay"
	});

	test("does NOT bridge a 2+ word content run (never cuts real content)", () => {
		// The 3-word content run "let me see" breaks the cluster, so neither
		// hesitation half is long/dense enough to cut — safety over recall.
		const words = seq({ text: "um uh let me see um uh okay" });
		expect(detectDeadAirCuts({ words })).toHaveLength(0);
	});

	test("cuts only the cluster, leaving surrounding content intact", () => {
		const words = seq({
			text: "this is great um uh okay um uh okay so anyway here we go",
		});
		const ops = detectDeadAirCuts({ words });
		expect(ops).toHaveLength(1);
		// "um uh okay um uh okay" spans tokens 3..8 → [1.5, 4.5]
		expect(ops[0].startSec).toBeCloseTo(1.5, 3);
		expect(ops[0].endSec).toBeCloseTo(4.5, 3);
	});

	test("does NOT cut a single filler inside real content", () => {
		const words = seq({ text: "um i really think we should ship this today" });
		expect(detectDeadAirCuts({ words })).toHaveLength(0);
	});

	test("does NOT cut a hesitation run that's too short / too few", () => {
		expect(detectDeadAirCuts({ words: seq({ text: "um uh" }) })).toHaveLength(0); // 2 tokens, 1s
	});

	test("finds two separate dead-air spans", () => {
		const words = [
			...seq({ text: "um uh okay um uh", startSec: 0 }), // 0–2.5s
			...seq({ text: "this is the real content here now", startSec: 5 }),
			...seq({ text: "uh um okay uh um", startSec: 20 }), // 20–22.5s
		];
		const ops = detectDeadAirCuts({ words });
		expect(ops).toHaveLength(2);
	});
});
