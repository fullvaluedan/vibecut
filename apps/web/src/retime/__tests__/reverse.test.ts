import { describe, expect, test } from "bun:test";
import { computeSplitTrimBoundaries, getSourceTimeAtClipTime } from "@/retime";
import type { RetimeConfig } from "@/timeline";
import { mediaTime } from "@/wasm";

const FPS = 30;
const FRAME = 1 / FPS; // seconds per frame, used as a "ticks" stand-in here

const reversed: RetimeConfig = { rate: 1, reversed: true };
const forward: RetimeConfig = { rate: 1 };

describe("reverse sampling (renderer parity)", () => {
	test("at clipTime=0, reversed samples the LAST instant of the span", () => {
		const clipDuration = 10;
		expect(
			getSourceTimeAtClipTime({ clipTime: 0, retime: reversed, clipDuration }),
		).toBe(10);
	});

	test("as clipTime approaches clipDuration, reversed approaches the FIRST instant", () => {
		const clipDuration = 10;
		expect(
			getSourceTimeAtClipTime({
				clipTime: 10,
				retime: reversed,
				clipDuration,
			}),
		).toBe(0);
	});

	test("reversed is the mirror image of forward at every sampled instant", () => {
		const clipDuration = 8;
		for (let clipTime = 0; clipTime <= clipDuration; clipTime += 1) {
			const forwardValue = getSourceTimeAtClipTime({
				clipTime,
				retime: forward,
				clipDuration,
			});
			const reversedValue = getSourceTimeAtClipTime({
				clipTime,
				retime: reversed,
				clipDuration,
			});
			expect(reversedValue).toBe(clipDuration - forwardValue);
		}
	});

	test("frame-exact at a fixture fps: every frame boundary maps to a whole-frame source offset", () => {
		const totalFrames = 12;
		const clipDuration = totalFrames * FRAME;
		for (let frame = 0; frame < totalFrames; frame++) {
			const clipTime = frame * FRAME;
			const sourceTime = getSourceTimeAtClipTime({
				clipTime,
				retime: reversed,
				clipDuration,
			});
			const expectedFrame = totalFrames - frame;
			// Floating point: compare in frame units, rounded.
			expect(Math.round(sourceTime / FRAME)).toBe(expectedFrame);
		}
	});

	test("trim interaction: sourceTime = trimStart + reversed offset", () => {
		const trimStart = 2;
		const clipDuration = 6;
		const sourceTimeAtStart =
			trimStart +
			getSourceTimeAtClipTime({ clipTime: 0, retime: reversed, clipDuration });
		const sourceTimeAtEnd =
			trimStart +
			getSourceTimeAtClipTime({
				clipTime: clipDuration,
				retime: reversed,
				clipDuration,
			});
		// The trimmed span is [trimStart, trimStart+clipDuration]; reversed
		// starts at the far (trimEnd-side) boundary and ends at trimStart.
		expect(sourceTimeAtStart).toBe(trimStart + clipDuration);
		expect(sourceTimeAtEnd).toBe(trimStart);
	});

	test("omitting clipDuration falls back to forward (safe default for older call sites)", () => {
		expect(getSourceTimeAtClipTime({ clipTime: 5, retime: reversed })).toBe(5);
	});
});

describe("split keeps a reversed clip frame-continuous across the cut", () => {
	test("the two halves reproduce the SAME source samples the unsplit clip would have shown", () => {
		const trimStart = 0;
		const trimEnd = 0;
		const totalDuration = 10;
		const splitClipTime = 4; // T
		const leftSourceSpan = splitClipTime; // rate=1
		const rightSourceSpan = totalDuration - splitClipTime;

		const { leftTrimStart, leftTrimEnd, rightTrimStart, rightTrimEnd } =
			computeSplitTrimBoundaries({
				trimStart: mediaTime({ ticks: trimStart }),
				trimEnd: mediaTime({ ticks: trimEnd }),
				leftSourceSpan: mediaTime({ ticks: leftSourceSpan }),
				rightSourceSpan: mediaTime({ ticks: rightSourceSpan }),
				retime: reversed,
			});

		// Left half is reversed too (retime carries over unchanged) and is
		// `leftSourceSpan` long: at its own clipTime 0..leftSourceSpan, it should
		// sample the SAME source instants the original clip did at global
		// clipTime 0..splitClipTime.
		for (let t = 0; t <= leftSourceSpan; t++) {
			const original =
				trimStart +
				getSourceTimeAtClipTime({
					clipTime: t,
					retime: reversed,
					clipDuration: totalDuration,
				});
			const afterSplit =
				leftTrimStart +
				getSourceTimeAtClipTime({
					clipTime: t,
					retime: reversed,
					clipDuration: leftSourceSpan,
				});
			expect(afterSplit).toBe(original);
		}

		// Right half: its own clipTime 0..rightSourceSpan corresponds to global
		// clipTime splitClipTime..totalDuration.
		for (let t = 0; t <= rightSourceSpan; t++) {
			const original =
				trimStart +
				getSourceTimeAtClipTime({
					clipTime: splitClipTime + t,
					retime: reversed,
					clipDuration: totalDuration,
				});
			const afterSplit =
				rightTrimStart +
				getSourceTimeAtClipTime({
					clipTime: t,
					retime: reversed,
					clipDuration: rightSourceSpan,
				});
			expect(afterSplit).toBe(original);
		}

		// Sanity: total source span is conserved (no media lost or duplicated).
		expect(leftTrimEnd).toBe(mediaTime({ ticks: trimEnd }));
		expect(rightTrimStart).toBe(mediaTime({ ticks: trimStart }));
		expect(
			leftTrimStart - trimStart + (rightTrimEnd - trimEnd),
		).toBe(totalDuration);
	});

	test("forward split is unchanged by the reversed-aware helper", () => {
		const forwardOnly: RetimeConfig = { rate: 1 };
		const result = computeSplitTrimBoundaries({
			trimStart: mediaTime({ ticks: 1 }),
			trimEnd: mediaTime({ ticks: 2 }),
			leftSourceSpan: mediaTime({ ticks: 4 }),
			rightSourceSpan: mediaTime({ ticks: 6 }),
			retime: forwardOnly,
		});
		expect(result.leftTrimStart).toBe(mediaTime({ ticks: 1 }));
		expect(result.leftTrimEnd).toBe(mediaTime({ ticks: 8 })); // 2 + 6
		expect(result.rightTrimStart).toBe(mediaTime({ ticks: 5 })); // 1 + 4
		expect(result.rightTrimEnd).toBe(mediaTime({ ticks: 2 }));
	});
});
