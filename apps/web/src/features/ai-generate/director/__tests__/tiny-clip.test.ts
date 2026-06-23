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
