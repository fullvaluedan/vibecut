import { describe, expect, test } from "bun:test";
import {
	computeSlideTarget,
	type SlideNeighbor,
} from "../slide";

// A slideable trio at 120_000 ticks/second. The CLIP is a 100k clip starting at
// 100k (so it spans 100k..200k). Each neighbour is sourced from the MIDDLE of a
// longer file so there is tail/head source to absorb the slide on either side.
//
//   LEFT:  start 0,      duration 100k (ends at 100k == clip.start). It is trimmed
//          to the middle of a 300k source: trimStart 100k, trimEnd 100k. Its tail
//          source available to consume on a slide-right is trimEnd == 100k.
//   CLIP:  start 100k, duration 100k (trim/duration fixed — only start moves).
//   RIGHT: start 200k (== clip.end), duration 100k. Same 300k source middle-trim:
//          trimStart 100k, trimEnd 100k. Its head source available on a slide-left
//          is trimStart == 100k.
const left: SlideNeighbor = {
	startTimeTicks: 0,
	durationTicks: 100_000,
	trimStartTicks: 100_000,
	trimEndTicks: 100_000,
	sourceDurationTicks: 300_000,
	rate: 1,
};
const right: SlideNeighbor = {
	startTimeTicks: 200_000,
	durationTicks: 100_000,
	trimStartTicks: 100_000,
	trimEndTicks: 100_000,
	sourceDurationTicks: 300_000,
	rate: 1,
};
const clip = { startTimeTicks: 100_000, durationTicks: 100_000 };
const base = {
	clip,
	left,
	right,
	deltaTicks: 0,
	minDurationTicks: 1,
};

/** Combined trio span: left.start .. right.end. Must stay constant. */
function trioSpan(result: {
	left: { startTimeTicks: number } | null;
	right: { startTimeTicks: number; durationTicks: number } | null;
}): { start: number; end: number } {
	if (!result.left || !result.right) {
		throw new Error("trioSpan needs both neighbours");
	}
	return {
		start: result.left.startTimeTicks,
		end: result.right.startTimeTicks + result.right.durationTicks,
	};
}

describe("computeSlideTarget", () => {
	test("slide right: clip moves right, LEFT grows / RIGHT shrinks with correct trim signs", () => {
		// +30k slide right. Clip start 100k -> 130k. LEFT grows (dur 100k -> 130k,
		// trimEnd 100k -> 70k — consumes tail source). RIGHT shrinks from head
		// (start 200k -> 230k, dur 100k -> 70k, trimStart 100k -> 130k).
		const result = computeSlideTarget({ ...base, deltaTicks: 30_000 });
		expect(result).not.toBeNull();
		if (!result) return;

		expect(result.startTimeTicks).toBe(130_000);

		// LEFT GROWS (the prior bug shrank it).
		expect(result.left?.durationTicks).toBe(130_000);
		expect(result.left?.durationTicks).toBeGreaterThan(left.durationTicks);
		// LEFT consumes tail source — trimEnd DECREASES.
		expect(result.left?.trimEndTicks).toBe(70_000);
		expect(result.left?.trimEndTicks).toBeLessThan(left.trimEndTicks);
		// LEFT start + trimStart pinned.
		expect(result.left?.startTimeTicks).toBe(0);
		expect(result.left?.trimStartTicks).toBe(100_000);

		// RIGHT shrinks from its head — startTime INCREASES.
		expect(result.right?.startTimeTicks).toBe(230_000);
		expect(result.right?.startTimeTicks).toBeGreaterThan(right.startTimeTicks);
		expect(result.right?.durationTicks).toBe(70_000);
		// RIGHT gives up head source — trimStart INCREASES.
		expect(result.right?.trimStartTicks).toBe(130_000);
		expect(result.right?.trimStartTicks).toBeGreaterThan(right.trimStartTicks);
		// RIGHT trimEnd pinned.
		expect(result.right?.trimEndTicks).toBe(100_000);
	});

	test("slide left mirrors: clip moves left, LEFT shrinks / RIGHT grows", () => {
		// -30k slide left. Clip 100k -> 70k. LEFT shrinks (dur 100k -> 70k, trimEnd
		// 100k -> 130k — hands tail source back). RIGHT grows from head (start 200k
		// -> 170k, dur 100k -> 130k, trimStart 100k -> 70k — reclaims head source).
		const result = computeSlideTarget({ ...base, deltaTicks: -30_000 });
		expect(result).not.toBeNull();
		if (!result) return;

		expect(result.startTimeTicks).toBe(70_000);

		// LEFT shrinks; trimEnd grows back.
		expect(result.left?.durationTicks).toBe(70_000);
		expect(result.left?.durationTicks).toBeLessThan(left.durationTicks);
		expect(result.left?.trimEndTicks).toBe(130_000);
		expect(result.left?.trimEndTicks).toBeGreaterThan(left.trimEndTicks);

		// RIGHT grows; startTime decreases; trimStart shrinks (head reclaimed).
		expect(result.right?.startTimeTicks).toBe(170_000);
		expect(result.right?.durationTicks).toBe(130_000);
		expect(result.right?.trimStartTicks).toBe(70_000);
		expect(result.right?.trimStartTicks).toBeLessThan(right.trimStartTicks);
	});

	test("combined trio span is constant across a valid slide-right", () => {
		const before = trioSpan(computeSlideTarget({ ...base, deltaTicks: 0 })!);
		const after = trioSpan(computeSlideTarget({ ...base, deltaTicks: 40_000 })!);
		expect(after).toEqual(before);
		expect(before).toEqual({ start: 0, end: 300_000 });
	});

	test("combined trio span is constant across a valid slide-left", () => {
		const before = trioSpan(computeSlideTarget({ ...base, deltaTicks: 0 })!);
		const after = trioSpan(computeSlideTarget({ ...base, deltaTicks: -40_000 })!);
		expect(after).toEqual(before);
	});

	test("clip duration & trim never change (only its start moves)", () => {
		const result = computeSlideTarget({ ...base, deltaTicks: 25_000 });
		// The clip result carries only startTimeTicks; duration/trim are owned by
		// the clip itself and untouched by the helper. Assert the clip's contract:
		// the only thing it reports is a shifted start.
		expect(result?.startTimeTicks).toBe(125_000);
	});

	test("clamp slide-right at the LEFT neighbour's tail source", () => {
		// LEFT has trimEnd 100k (rate 1) -> at most 100k of tail to consume. RIGHT
		// (dur 100k, minDuration 1) can shrink at most 99_999. The right-min bound is
		// the tighter one here, so a +500k drag caps at 99_999. (To isolate the LEFT
		// source bound as the binding constraint, give the right plenty of duration.)
		const roomyRight: SlideNeighbor = { ...right, durationTicks: 500_000 };
		const result = computeSlideTarget({
			...base,
			right: roomyRight,
			deltaTicks: 500_000,
		});
		expect(result?.startTimeTicks).toBe(200_000); // 100k + 100k
		expect(result?.left?.durationTicks).toBe(200_000);
		expect(result?.left?.trimEndTicks).toBe(0); // tail fully consumed
		// RIGHT shrank by the SAME clamped 100k.
		expect(result?.right?.durationTicks).toBe(400_000);
		expect(result?.right?.trimStartTicks).toBe(200_000);
	});

	test("clamp slide-right is the TIGHTEST of left-source and right-min-duration", () => {
		// Make the right neighbour the binding constraint: tiny right clip (dur 20k)
		// can only shrink to minDuration. Left has plenty of source. A big +delta
		// caps at right.duration - minDuration = 20k - 1 = 19_999.
		const tightRight: SlideNeighbor = {
			...right,
			durationTicks: 20_000,
		};
		const result = computeSlideTarget({
			...base,
			right: tightRight,
			deltaTicks: 500_000,
		});
		expect(result?.startTimeTicks).toBe(100_000 + 19_999);
		expect(result?.right?.durationTicks).toBe(1); // min duration floor
		expect(result?.left?.durationTicks).toBe(100_000 + 19_999);
	});

	test("clamp slide-left at the RIGHT neighbour's head source", () => {
		// RIGHT trimStart 100k (rate 1) -> at most 100k of head to reclaim. The LEFT
		// (dur 100k, minDuration 1) can shrink at most 99_999, which would be tighter,
		// so give the left a roomy duration to isolate the RIGHT head-source bound.
		const roomyLeft: SlideNeighbor = {
			...left,
			durationTicks: 500_000,
			startTimeTicks: -400_000, // ends at 100k == clip.start (stay adjacent)
		};
		const result = computeSlideTarget({
			...base,
			left: roomyLeft,
			deltaTicks: -500_000,
		});
		expect(result?.startTimeTicks).toBe(0); // 100k - 100k
		expect(result?.right?.trimStartTicks).toBe(0); // head fully reclaimed
		expect(result?.right?.durationTicks).toBe(200_000);
		expect(result?.left?.durationTicks).toBe(400_000); // shrank by 100k
	});

	test("clamp slide-left at the LEFT neighbour's minimum duration", () => {
		// Tiny left clip (dur 20k) can only shrink to minDuration on a slide-left.
		// minDelta = minDuration - left.duration = 1 - 20k = -19_999.
		const tightLeft: SlideNeighbor = {
			...left,
			durationTicks: 20_000,
			startTimeTicks: 80_000, // ends at 100k == clip.start (stay adjacent)
		};
		const result = computeSlideTarget({
			...base,
			left: tightLeft,
			deltaTicks: -500_000,
		});
		expect(result?.left?.durationTicks).toBe(1); // floored at min duration
		expect(result?.startTimeTicks).toBe(100_000 - 19_999);
	});

	test("source-overshoot clamp holds the window invariant for a PRE-TRIMMED left neighbour", () => {
		// A left neighbour already near the end of its source: trimEnd just 10k. A
		// big slide-right tries to consume more tail than exists; the global clamp
		// caps the slide at 10k, and the source-overshoot clamp pins trimEnd at 0 —
		// never negative, never past the source.
		// Self-consistent: trimStart 190k + visible 100k + trimEnd 10k == 300k source.
		const preTrimmedLeft: SlideNeighbor = {
			...left,
			trimStartTicks: 190_000,
			trimEndTicks: 10_000,
		};
		const result = computeSlideTarget({
			...base,
			left: preTrimmedLeft,
			deltaTicks: 500_000,
		});
		expect(result?.left?.trimEndTicks).toBe(0);
		expect(result?.left?.trimEndTicks).toBeGreaterThanOrEqual(0);
		// trimStart + duration*rate + trimEnd stays == sourceDuration on the left.
		const leftVisible =
			(result?.left?.durationTicks ?? 0) * 1; // rate 1
		expect(
			(result?.left?.trimStartTicks ?? 0) +
				leftVisible +
				(result?.left?.trimEndTicks ?? 0),
		).toBe(preTrimmedLeft.sourceDurationTicks);
		// The slide was capped at the available 10k of tail.
		expect(result?.startTimeTicks).toBe(110_000);
	});

	test("retimed left neighbour (rate 2): source delta scales by the rate", () => {
		// A rate-2 left neighbour consumes 2 source ticks per timeline tick. With
		// trimEnd 100k it can only grow 50k of timeline (50k*2 == 100k source). A
		// +40k drag is within range: trimEnd 100k -> 100k - 40k*2 == 20k.
		const retimedLeft: SlideNeighbor = { ...left, rate: 2 };
		const result = computeSlideTarget({
			...base,
			left: retimedLeft,
			deltaTicks: 40_000,
		});
		expect(result?.startTimeTicks).toBe(140_000);
		expect(result?.left?.durationTicks).toBe(140_000); // grew by the timeline 40k
		expect(result?.left?.trimEndTicks).toBe(20_000); // 100k - 40k*2
	});

	test("retimed left neighbour (rate 2): clamps at HALF the timeline delta", () => {
		// Same rate-2 left: a huge drag caps at 50k of timeline (its 100k tail / 2).
		const retimedLeft: SlideNeighbor = { ...left, rate: 2 };
		const result = computeSlideTarget({
			...base,
			left: retimedLeft,
			deltaTicks: 999_999,
		});
		expect(result?.startTimeTicks).toBe(150_000); // 100k + 50k
		expect(result?.left?.trimEndTicks).toBe(0);
	});

	test("missing LEFT neighbour: slide bounded by the RIGHT side only", () => {
		// No left neighbour (clip at the track's left edge against a gap). Slide
		// right is bounded only by right shrinking to min duration.
		const result = computeSlideTarget({
			...base,
			left: null,
			deltaTicks: 30_000,
		});
		expect(result).not.toBeNull();
		expect(result?.left).toBeNull();
		expect(result?.startTimeTicks).toBe(130_000);
		expect(result?.right?.startTimeTicks).toBe(230_000);
		expect(result?.right?.durationTicks).toBe(70_000);
	});

	test("missing RIGHT neighbour: slide bounded by the LEFT side only", () => {
		const result = computeSlideTarget({
			...base,
			right: null,
			deltaTicks: -30_000,
		});
		expect(result).not.toBeNull();
		expect(result?.right).toBeNull();
		expect(result?.startTimeTicks).toBe(70_000);
		expect(result?.left?.durationTicks).toBe(70_000);
	});

	test("missing LEFT, big slide-right clamps at the right neighbour's min duration", () => {
		const result = computeSlideTarget({
			...base,
			left: null,
			deltaTicks: 999_999,
		});
		// Right can shrink at most 100k - 1 = 99_999.
		expect(result?.startTimeTicks).toBe(100_000 + 99_999);
		expect(result?.right?.durationTicks).toBe(1);
	});

	test("both neighbours missing returns null (nothing to absorb the move)", () => {
		const result = computeSlideTarget({
			...base,
			left: null,
			right: null,
			deltaTicks: 30_000,
		});
		expect(result).toBeNull();
	});

	test("non-adjacent left neighbour returns null", () => {
		// Left ends at 90k, not at the clip's start (100k) — a gap. Not slideable.
		const gapLeft: SlideNeighbor = { ...left, durationTicks: 90_000 };
		const result = computeSlideTarget({
			...base,
			left: gapLeft,
			deltaTicks: 30_000,
		});
		expect(result).toBeNull();
	});

	test("non-adjacent right neighbour returns null", () => {
		// Right starts at 210k, not at the clip's end (200k) — a gap.
		const gapRight: SlideNeighbor = { ...right, startTimeTicks: 210_000 };
		const result = computeSlideTarget({
			...base,
			right: gapRight,
			deltaTicks: 30_000,
		});
		expect(result).toBeNull();
	});

	test("zero delta is a no-op (clip + neighbours unchanged)", () => {
		const result = computeSlideTarget({ ...base, deltaTicks: 0 });
		expect(result?.startTimeTicks).toBe(100_000);
		expect(result?.left).toEqual({
			startTimeTicks: 0,
			durationTicks: 100_000,
			trimStartTicks: 100_000,
			trimEndTicks: 100_000,
		});
		expect(result?.right).toEqual({
			startTimeTicks: 200_000,
			durationTicks: 100_000,
			trimStartTicks: 100_000,
			trimEndTicks: 100_000,
		});
	});

	test("round-trip recovers the original geometry", () => {
		const forward = computeSlideTarget({ ...base, deltaTicks: 30_000 })!;
		const back = computeSlideTarget({
			clip: { startTimeTicks: forward.startTimeTicks, durationTicks: 100_000 },
			left: {
				...left,
				startTimeTicks: forward.left!.startTimeTicks,
				durationTicks: forward.left!.durationTicks,
				trimStartTicks: forward.left!.trimStartTicks,
				trimEndTicks: forward.left!.trimEndTicks,
			},
			right: {
				...right,
				startTimeTicks: forward.right!.startTimeTicks,
				durationTicks: forward.right!.durationTicks,
				trimStartTicks: forward.right!.trimStartTicks,
				trimEndTicks: forward.right!.trimEndTicks,
			},
			deltaTicks: -30_000,
			minDurationTicks: 1,
		})!;
		expect(back.startTimeTicks).toBe(100_000);
		expect(back.left).toEqual({
			startTimeTicks: 0,
			durationTicks: 100_000,
			trimStartTicks: 100_000,
			trimEndTicks: 100_000,
		});
		expect(back.right).toEqual({
			startTimeTicks: 200_000,
			durationTicks: 100_000,
			trimStartTicks: 100_000,
			trimEndTicks: 100_000,
		});
	});

	test("an invalid (non-positive) neighbour rate falls back to 1x", () => {
		const result = computeSlideTarget({
			...base,
			left: { ...left, rate: 0 },
			deltaTicks: 30_000,
		});
		// rate 0 -> clamped to 1: trimEnd consumes the raw timeline delta.
		expect(result?.left?.trimEndTicks).toBe(70_000);
	});
});
