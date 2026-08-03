import { describe, expect, test } from "bun:test";
import { TICKS_PER_SECOND } from "@/wasm";
import type { TransitionRoles } from "@/timeline/transitions";
import {
	clampTransitionSourceTicks,
	isTransitionExtendedTime,
	resolveTransitionClipTime,
	resolveTransitionOpacityFactor,
} from "../transition-window";

const SEC = TICKS_PER_SECOND;

// A 4s + 4s pair joined at t=4s with a 1s crossDissolve: window [3.5s, 4.5s].
const LEFT = { timeOffset: 0, duration: 4 * SEC };
const RIGHT = { timeOffset: 4 * SEC, duration: 4 * SEC };
const leftRoles: TransitionRoles = {
	tail: {
		startTicks: 3.5 * SEC,
		endTicks: 4.5 * SEC,
		direction: "hold",
		extendTicks: 0.5 * SEC,
	},
};
const rightRoles: TransitionRoles = {
	head: {
		startTicks: 3.5 * SEC,
		endTicks: 4.5 * SEC,
		direction: "in",
		extendTicks: 0.5 * SEC,
	},
};

describe("visibility gate", () => {
	test("without a transition role the gate is the untouched [0, duration) test", () => {
		expect(
			resolveTransitionClipTime({ ...LEFT, time: 0 }),
		).toBe(0);
		expect(
			resolveTransitionClipTime({ ...LEFT, time: 4 * SEC - 1 }),
		).toBe(4 * SEC - 1);
		expect(resolveTransitionClipTime({ ...LEFT, time: 4 * SEC })).toBeNull();
		expect(resolveTransitionClipTime({ ...LEFT, time: -1 })).toBeNull();
	});

	test("the outgoing clip is admitted PAST its own end, out to the window end", () => {
		expect(
			resolveTransitionClipTime({
				...LEFT,
				transitions: leftRoles,
				time: 4.25 * SEC,
			}),
		).toBe(4.25 * SEC);
		// One frame past the window: gone again.
		expect(
			resolveTransitionClipTime({
				...LEFT,
				transitions: leftRoles,
				time: 4.5 * SEC,
			}),
		).toBeNull();
	});

	test("the incoming clip is admitted BEFORE its own start, back to the window start", () => {
		expect(
			resolveTransitionClipTime({
				...RIGHT,
				transitions: rightRoles,
				time: 3.75 * SEC,
			}),
		).toBe(-0.25 * SEC);
		expect(
			resolveTransitionClipTime({
				...RIGHT,
				transitions: rightRoles,
				time: 3.5 * SEC - 1,
			}),
		).toBeNull();
	});

	test("a ramp with no extension (fade, dip) never widens the gate", () => {
		const fade: TransitionRoles = {
			head: {
				startTicks: 0,
				endTicks: 1 * SEC,
				direction: "in",
				extendTicks: 0,
			},
		};
		expect(
			resolveTransitionClipTime({ ...RIGHT, transitions: fade, time: 3.9 * SEC }),
		).toBeNull();
	});

	test("isTransitionExtendedTime marks only the out-of-span frames", () => {
		expect(isTransitionExtendedTime({ ...LEFT, time: 2 * SEC })).toBe(false);
		expect(isTransitionExtendedTime({ ...LEFT, time: 4.2 * SEC })).toBe(true);
		expect(isTransitionExtendedTime({ ...RIGHT, time: 3.7 * SEC })).toBe(true);
	});
});

describe("opacity ramp math", () => {
	test("constant-colour sources compose to the FLAT linear blend at every t", () => {
		// The renderer composites the INCOMING clip last (scene-builder pushes
		// the right clip's node after the left's, and items draw in order
		// source-over), so the frame is `U*fU + (L*fL)*(1 - fU)`. A flat
		// dissolve needs `U*t + L*(1-t)`, which holds iff the outgoing layer
		// keeps fL = 1 and only the incoming ramps fU = t. Both ramping gave
		// `U*t + L*(1-t)^2` - the 25% midpoint luminance dip. Assert the
		// COMPOSITED result, not the per-layer factors: the old factors summed
		// to 1 and still dipped.
		const L = 0.2;
		const U = 0.8;
		for (const sec of [3.5, 3.75, 4, 4.25, 4.5]) {
			const time = sec * SEC;
			const t = sec - 3.5;
			const fL = resolveTransitionOpacityFactor({
				transitions: leftRoles,
				time,
			});
			const fU = resolveTransitionOpacityFactor({
				transitions: rightRoles,
				time,
			});
			const composited = U * fU + L * fL * (1 - fU);
			expect(composited).toBeCloseTo(U * t + L * (1 - t), 6);
		}
	});

	test("midpoint (t=0.5): the outgoing layer holds at 1, the incoming is at half", () => {
		expect(
			resolveTransitionOpacityFactor({ transitions: leftRoles, time: 4 * SEC }),
		).toBe(1);
		expect(
			resolveTransitionOpacityFactor({
				transitions: rightRoles,
				time: 4 * SEC,
			}),
		).toBeCloseTo(0.5, 6);
	});

	test("outside the window the factor is a plain 1 (or 0 past an out-ramp)", () => {
		expect(
			resolveTransitionOpacityFactor({ transitions: leftRoles, time: 1 * SEC }),
		).toBe(1);
		// A held layer never dips, even past its own window (the visibility
		// gate is what removes it there).
		expect(
			resolveTransitionOpacityFactor({ transitions: leftRoles, time: 9 * SEC }),
		).toBe(1);
		const fadeOut: TransitionRoles = {
			tail: {
				startTicks: 3.5 * SEC,
				endTicks: 4.5 * SEC,
				direction: "out",
				extendTicks: 0,
			},
		};
		expect(
			resolveTransitionOpacityFactor({ transitions: fadeOut, time: 9 * SEC }),
		).toBe(0);
		expect(resolveTransitionOpacityFactor({ time: 1 * SEC })).toBe(1);
	});

	test("a dip ramps 0 -> 1 at the midpoint -> 0", () => {
		const dip: TransitionRoles = {
			head: {
				startTicks: 3.5 * SEC,
				endTicks: 4.5 * SEC,
				direction: "dip",
				extendTicks: 0,
			},
		};
		expect(
			resolveTransitionOpacityFactor({ transitions: dip, time: 3.5 * SEC }),
		).toBeCloseTo(0, 6);
		expect(
			resolveTransitionOpacityFactor({ transitions: dip, time: 3.75 * SEC }),
		).toBeCloseTo(0.5, 6);
		expect(
			resolveTransitionOpacityFactor({ transitions: dip, time: 4 * SEC }),
		).toBeCloseTo(1, 6);
		expect(
			resolveTransitionOpacityFactor({ transitions: dip, time: 4.25 * SEC }),
		).toBeCloseTo(0.5, 6);
		expect(
			resolveTransitionOpacityFactor({ transitions: dip, time: 4.5 * SEC }),
		).toBeCloseTo(0, 6);
	});

	test("the ramp MULTIPLIES authored opacity instead of replacing it", () => {
		// The renderer does `authored * factor` (see resolve.ts). An incoming
		// clip held at 40% by the user (or by an opacity keyframe) dissolves
		// 0 -> 0.4, and the outgoing side HOLDS its authored 0.4 while it is
		// covered - the transition never clobbers authored opacity.
		const authored = 0.4;
		const midpoint = resolveTransitionOpacityFactor({
			transitions: rightRoles,
			time: 4 * SEC,
		});
		expect(authored * midpoint).toBeCloseTo(0.2, 6);
		const end = resolveTransitionOpacityFactor({
			transitions: rightRoles,
			time: 4.5 * SEC,
		});
		expect(authored * end).toBeCloseTo(0.4, 6);
		const held = resolveTransitionOpacityFactor({
			transitions: leftRoles,
			time: 4 * SEC,
		});
		expect(authored * held).toBeCloseTo(0.4, 6);
	});

	test("head and tail ramps on one clip multiply", () => {
		const both: TransitionRoles = {
			head: {
				startTicks: 0,
				endTicks: 1 * SEC,
				direction: "in",
				extendTicks: 0,
			},
			tail: {
				startTicks: 3 * SEC,
				endTicks: 4 * SEC,
				direction: "out",
				extendTicks: 0,
			},
		};
		expect(
			resolveTransitionOpacityFactor({ transitions: both, time: 0.5 * SEC }),
		).toBeCloseTo(0.5, 6);
		expect(
			resolveTransitionOpacityFactor({ transitions: both, time: 2 * SEC }),
		).toBeCloseTo(1, 6);
		expect(
			resolveTransitionOpacityFactor({ transitions: both, time: 3.5 * SEC }),
		).toBeCloseTo(0.5, 6);
	});
});

describe("edge hold (source clamp)", () => {
	const clip = {
		trimStart: 2 * SEC,
		trimEnd: 3 * SEC,
		duration: 4 * SEC,
	};

	test("a sample inside the real source passes through untouched", () => {
		expect(
			clampTransitionSourceTicks({ ...clip, ticks: 5 * SEC }),
		).toBe(5 * SEC);
	});

	test("sampling past the file's end holds the LAST frame", () => {
		// Real source length = trimStart + duration + trimEnd = 9s.
		expect(clampTransitionSourceTicks({ ...clip, ticks: 12 * SEC })).toBe(
			9 * SEC,
		);
	});

	test("sampling before the file's start holds the FIRST frame", () => {
		expect(clampTransitionSourceTicks({ ...clip, ticks: -1 * SEC })).toBe(0);
	});

	test("a clip trimmed hard against both file ends edge-holds on both sides", () => {
		const noHeadroom = { trimStart: 0, trimEnd: 0, duration: 4 * SEC };
		expect(
			clampTransitionSourceTicks({ ...noHeadroom, ticks: -0.5 * SEC }),
		).toBe(0);
		expect(
			clampTransitionSourceTicks({ ...noHeadroom, ticks: 4.5 * SEC }),
		).toBe(4 * SEC);
	});
});
