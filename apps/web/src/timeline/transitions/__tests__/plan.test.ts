import { describe, expect, test } from "bun:test";
import type { VideoElement } from "@/timeline";
import { mediaTime, TICKS_PER_SECOND } from "@/wasm";
import { buildTransitionRenderPlan } from "../plan";
import type { TransitionSpec } from "../types";

const SEC = TICKS_PER_SECOND;

function clip({
	id,
	startSec,
	durationSec,
	mediaId = "m",
	transitionIn,
	transitionOut,
}: {
	id: string;
	startSec: number;
	durationSec: number;
	mediaId?: string;
	transitionIn?: TransitionSpec;
	transitionOut?: TransitionSpec;
}): VideoElement {
	return {
		id,
		type: "video",
		name: id,
		mediaId,
		startTime: mediaTime({ ticks: Math.round(startSec * SEC) }),
		duration: mediaTime({ ticks: Math.round(durationSec * SEC) }),
		trimStart: mediaTime({ ticks: 0 }),
		trimEnd: mediaTime({ ticks: 0 }),
		params: {},
		...(transitionIn ? { transitionIn } : {}),
		...(transitionOut ? { transitionOut } : {}),
	} as VideoElement;
}

describe("transition render plan", () => {
	test("a crossDissolve centres a window on the cut and extends BOTH neighbours", () => {
		const plan = buildTransitionRenderPlan({
			elements: [
				clip({ id: "a", startSec: 0, durationSec: 4 }),
				clip({
					id: "b",
					startSec: 4,
					durationSec: 4,
					mediaId: "n",
					transitionIn: { id: "t", kind: "crossDissolve", durationSec: 1 },
				}),
			],
		});

		const left = plan.rolesByElementId.get("a");
		const right = plan.rolesByElementId.get("b");
		// The outgoing side HOLDS at full opacity; only the incoming side ramps.
		// Both ramping composited to 0.75 * luminance at the midpoint (the
		// source-over derivation is on TransitionRamp in plan.ts).
		expect(left?.tail).toEqual({
			startTicks: 3.5 * SEC,
			endTicks: 4.5 * SEC,
			direction: "hold",
			extendTicks: 0.5 * SEC,
		});
		expect(right?.head).toEqual({
			startTicks: 3.5 * SEC,
			endTicks: 4.5 * SEC,
			direction: "in",
			extendTicks: 0.5 * SEC,
		});
		expect(plan.dipLayers).toHaveLength(0);
	});

	test("a same-source crossDissolve marks the RIGHT clip for its own decode sink", () => {
		const plan = buildTransitionRenderPlan({
			elements: [
				clip({ id: "a", startSec: 0, durationSec: 4, mediaId: "same" }),
				clip({
					id: "b",
					startSec: 4,
					durationSec: 4,
					mediaId: "same",
					transitionIn: { id: "t", kind: "crossDissolve", durationSec: 1 },
				}),
			],
		});
		expect([...plan.secondarySinkElementIds]).toEqual(["b"]);
	});

	test("different sources keep sharing the default per-mediaId sink", () => {
		const plan = buildTransitionRenderPlan({
			elements: [
				clip({ id: "a", startSec: 0, durationSec: 4, mediaId: "one" }),
				clip({
					id: "b",
					startSec: 4,
					durationSec: 4,
					mediaId: "two",
					transitionIn: { id: "t", kind: "crossDissolve", durationSec: 1 },
				}),
			],
		});
		expect(plan.secondarySinkElementIds.size).toBe(0);
	});

	test("a dip emits a colour layer over the cut and NO clip ramps", () => {
		const plan = buildTransitionRenderPlan({
			elements: [
				clip({ id: "a", startSec: 0, durationSec: 4 }),
				clip({
					id: "b",
					startSec: 4,
					durationSec: 4,
					transitionIn: { id: "t", kind: "dipToBlack", durationSec: 1 },
				}),
			],
		});

		expect(plan.rolesByElementId.size).toBe(0);
		expect(plan.dipLayers).toHaveLength(1);
		expect(plan.dipLayers[0].color).toBe("#000000");
		expect(plan.dipLayers[0].startTicks).toBe(3.5 * SEC);
		expect(plan.dipLayers[0].durationTicks).toBe(1 * SEC);
		expect(plan.dipLayers[0].ramp.direction).toBe("dip");
	});

	test("dip to white uses white", () => {
		const plan = buildTransitionRenderPlan({
			elements: [
				clip({ id: "a", startSec: 0, durationSec: 4 }),
				clip({
					id: "b",
					startSec: 4,
					durationSec: 4,
					transitionIn: { id: "t", kind: "dipToWhite", durationSec: 0.5 },
				}),
			],
		});
		expect(plan.dipLayers[0].color).toBe("#ffffff");
	});

	test("a fade is single-sided and never extends the source", () => {
		const plan = buildTransitionRenderPlan({
			elements: [
				clip({
					id: "a",
					startSec: 2,
					durationSec: 4,
					transitionIn: { id: "t1", kind: "fade", durationSec: 1 },
					transitionOut: { id: "t2", kind: "fade", durationSec: 0.5 },
				}),
			],
		});

		const roles = plan.rolesByElementId.get("a");
		expect(roles?.head).toEqual({
			startTicks: 2 * SEC,
			endTicks: 3 * SEC,
			direction: "in",
			extendTicks: 0,
		});
		expect(roles?.tail).toEqual({
			startTicks: 5.5 * SEC,
			endTicks: 6 * SEC,
			direction: "out",
			extendTicks: 0,
		});
	});

	test("a stale spec whose boundary no longer matches produces nothing", () => {
		// A fade parked on a real join: the plan ignores it (and the reconciler
		// would have stripped it before this ever reached the renderer).
		const plan = buildTransitionRenderPlan({
			elements: [
				clip({ id: "a", startSec: 0, durationSec: 4 }),
				clip({
					id: "b",
					startSec: 4,
					durationSec: 4,
					transitionIn: { id: "t", kind: "fade", durationSec: 1 },
				}),
			],
		});
		expect(plan.rolesByElementId.size).toBe(0);
		expect(plan.dipLayers).toHaveLength(0);
	});
});
