import { describe, expect, test } from "bun:test";
import { detectTinyClipCuts } from "../tiny-clip";

const span = ({ startSec, endSec }: { startSec: number; endSec: number }) => ({ startSec, endSec });

describe("detectTinyClipCuts", () => {
	test("flags a clip shorter than the minimum (the 2-frame head clip)", () => {
		// 2 frames @30fps ≈ 0.067s, threshold ≈ 5 frames ≈ 0.167s.
		const ops = detectTinyClipCuts({
			clips: [span({ startSec: 0, endSec: 0.067 })],
			minDurationSec: 0.167,
		});
		expect(ops).toHaveLength(1);
		expect(ops[0].op).toBe("cut");
		expect(ops[0].category).toBe("noise");
		expect(ops[0].startSec).toBe(0);
		expect(ops[0].endSec).toBeCloseTo(0.067, 3);
	});

	test("leaves a normal-length clip alone", () => {
		const ops = detectTinyClipCuts({
			clips: [span({ startSec: 0, endSec: 5 })],
			minDurationSec: 0.167,
		});
		expect(ops).toHaveLength(0);
	});

	test("only flags the tiny clips in a mix", () => {
		const ops = detectTinyClipCuts({
			clips: [
				span({ startSec: 0, endSec: 0.05 }), // tiny → cut
				span({ startSec: 0.05, endSec: 10 }), // real → keep
				span({ startSec: 10, endSec: 10.1 }), // tiny → cut
			],
			minDurationSec: 0.167,
		});
		expect(ops).toHaveLength(2);
		expect(ops.map((o) => o.startSec)).toEqual([0, 10]);
	});

	test("a clip exactly at the threshold is kept (strictly shorter only)", () => {
		const ops = detectTinyClipCuts({
			clips: [span({ startSec: 0, endSec: 0.167 })],
			minDurationSec: 0.167,
		});
		expect(ops).toHaveLength(0);
	});

	test("does NOT flag a zero- or negative-length clip", () => {
		const ops = detectTinyClipCuts({
			clips: [span({ startSec: 5, endSec: 5 }), span({ startSec: 8, endSec: 7 })],
			minDurationSec: 0.167,
		});
		expect(ops).toHaveLength(0);
	});

	test("zero/negative threshold disables the guard", () => {
		expect(
			detectTinyClipCuts({ clips: [span({ startSec: 0, endSec: 0.05 })], minDurationSec: 0 }),
		).toHaveLength(0);
	});

	test("ids are stable + prefixed", () => {
		const clips = [span({ startSec: 0, endSec: 0.05 })];
		const a = detectTinyClipCuts({ clips, minDurationSec: 0.167 });
		const b = detectTinyClipCuts({ clips, minDurationSec: 0.167 });
		expect(a[0].id).toBe(b[0].id);
		expect(a[0].id.startsWith("tiny-")).toBe(true);
	});
});

// 2P-U2: word-aware accept-default split at the 15-frame floor (0.5s @30fps).
describe("detectTinyClipCuts (word-aware micro-clip sweep, 2P-U2)", () => {
	const FLOOR = 0.5; // 15 frames @30fps

	test("a 9-frame clip holding only a partial \"um\" is default-accepted", () => {
		// 9 frames ≈ 0.3s < floor; the only word inside is filler.
		const ops = detectTinyClipCuts({
			clips: [span({ startSec: 10, endSec: 10.3 })],
			minDurationSec: FLOOR,
			words: [{ text: "um", start: 10.05, end: 10.2 }],
		});
		expect(ops).toHaveLength(1);
		expect(ops[0].defaultAccept).toBe(true);
	});

	test("a 12-frame clip holding the complete word \"yes\" is an opt-in row naming it", () => {
		// 12 frames = 0.4s < floor; a real content word lives fully inside.
		const ops = detectTinyClipCuts({
			clips: [span({ startSec: 10, endSec: 10.4 })],
			minDurationSec: FLOOR,
			words: [{ text: "yes", start: 10.05, end: 10.35 }],
		});
		expect(ops).toHaveLength(1);
		expect(ops[0].defaultAccept).toBe(false);
		expect(ops[0].reason).toContain("yes");
	});

	test("a 20-frame clip (over floor) is untouched", () => {
		// 20 frames ≈ 0.667s >= floor.
		const ops = detectTinyClipCuts({
			clips: [span({ startSec: 10, endSec: 10.667 })],
			minDurationSec: FLOOR,
			words: [{ text: "hello", start: 10.1, end: 10.5 }],
		});
		expect(ops).toHaveLength(0);
	});

	test("no transcript: shards stay opt-in only (fail-open, nothing auto-removed)", () => {
		const ops = detectTinyClipCuts({
			clips: [span({ startSec: 10, endSec: 10.3 })],
			minDurationSec: FLOOR,
			// words omitted
		});
		expect(ops).toHaveLength(1);
		expect(ops[0].defaultAccept).toBe(false);
	});

	test("a content-free shard WITH a transcript present auto-removes", () => {
		// No word lands inside this shard, but the transcript exists (words elsewhere).
		const ops = detectTinyClipCuts({
			clips: [span({ startSec: 10, endSec: 10.3 })],
			minDurationSec: FLOOR,
			words: [{ text: "elsewhere", start: 2, end: 2.4 }],
		});
		expect(ops).toHaveLength(1);
		expect(ops[0].defaultAccept).toBe(true);
	});
});
