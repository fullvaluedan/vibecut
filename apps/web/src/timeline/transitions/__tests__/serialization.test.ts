import { describe, expect, test } from "bun:test";
import type { SceneTracks, VideoElement, VideoTrack } from "@/timeline";
import { mediaTime, TICKS_PER_SECOND } from "@/wasm";
import { buildTransitionRenderPlan } from "../plan";
import { reconcileSceneTransitions } from "../model";
import type { TransitionSpec } from "../types";

const SEC = TICKS_PER_SECOND;

/**
 * `StorageService.saveProject` hands `scene.tracks` straight into the adapter
 * (only audio buffers are stripped), so persistence is a structural clone of
 * the track objects. A JSON round-trip is therefore a faithful stand-in for
 * "save, reload the editor, open the project again".
 */
function roundTrip({ tracks }: { tracks: SceneTracks }): SceneTracks {
	return JSON.parse(JSON.stringify(tracks)) as SceneTracks;
}

function clip({
	id,
	startSec,
	durationSec,
	transitionIn,
	transitionOut,
}: {
	id: string;
	startSec: number;
	durationSec: number;
	transitionIn?: TransitionSpec;
	transitionOut?: TransitionSpec;
}): VideoElement {
	return {
		id,
		type: "video",
		name: id,
		mediaId: "m",
		startTime: mediaTime({ ticks: Math.round(startSec * SEC) }),
		duration: mediaTime({ ticks: Math.round(durationSec * SEC) }),
		trimStart: mediaTime({ ticks: 0 }),
		trimEnd: mediaTime({ ticks: 0 }),
		params: {},
		...(transitionIn ? { transitionIn } : {}),
		...(transitionOut ? { transitionOut } : {}),
	} as VideoElement;
}

function scene({ elements }: { elements: VideoElement[] }): SceneTracks {
	return {
		overlay: [],
		main: {
			id: "main",
			type: "video",
			name: "V1",
			muted: false,
			hidden: false,
			elements,
		} as unknown as VideoTrack,
		audio: [],
	};
}

describe("transition serialization", () => {
	test("specs survive a save/load round-trip unchanged", () => {
		const tracks = scene({
			elements: [
				clip({
					id: "a",
					startSec: 0,
					durationSec: 4,
					transitionIn: { id: "fade-in", kind: "fade", durationSec: 0.25 },
				}),
				clip({
					id: "b",
					startSec: 4,
					durationSec: 4,
					transitionIn: {
						id: "x",
						kind: "crossDissolve",
						durationSec: 1,
					},
					transitionOut: { id: "fade-out", kind: "fade", durationSec: 0.5 },
				}),
			],
		});

		const loaded = roundTrip({ tracks });
		const reloadedB = loaded.main.elements.find((e) => e.id === "b");
		expect(reloadedB?.type).toBe("video");
		if (reloadedB?.type !== "video") throw new Error("unreachable");
		expect(reloadedB.transitionIn).toEqual({
			id: "x",
			kind: "crossDissolve",
			durationSec: 1,
		});
		expect(reloadedB.transitionOut).toEqual({
			id: "fade-out",
			kind: "fade",
			durationSec: 0.5,
		});

		// And it still reconciles + plans identically after the round-trip.
		expect(reconcileSceneTransitions({ tracks: loaded })).toBe(loaded);
		const plan = buildTransitionRenderPlan({ elements: loaded.main.elements });
		expect(plan.rolesByElementId.get("b")?.head?.direction).toBe("in");
	});

	test("an OLD project (no transition fields at all) loads as all hard cuts", () => {
		// Exactly what a pre-T19.3 project looks like: the keys do not exist.
		const legacy = roundTrip({
			tracks: scene({
				elements: [
					clip({ id: "a", startSec: 0, durationSec: 4 }),
					clip({ id: "b", startSec: 4, durationSec: 4 }),
				],
			}),
		});

		for (const element of legacy.main.elements) {
			expect("transitionIn" in element).toBe(false);
			expect("transitionOut" in element).toBe(false);
		}
		// No migration needed: absent means "no transition", and the reconciler
		// is a no-op on it.
		expect(reconcileSceneTransitions({ tracks: legacy })).toBe(legacy);
		const plan = buildTransitionRenderPlan({ elements: legacy.main.elements });
		expect(plan.rolesByElementId.size).toBe(0);
		expect(plan.dipLayers).toHaveLength(0);
	});

	test("a spec that no longer fits its boundary is repaired on load, not carried", () => {
		const stale = roundTrip({
			tracks: scene({
				elements: [
					clip({ id: "a", startSec: 0, durationSec: 4 }),
					// Saved when 'b' was long; the project was later edited elsewhere
					// and 'b' is now 0.6s, so 2s no longer fits.
					clip({
						id: "b",
						startSec: 4,
						durationSec: 0.6,
						transitionIn: { id: "x", kind: "crossDissolve", durationSec: 2 },
					}),
				],
			}),
		});

		const repaired = reconcileSceneTransitions({ tracks: stale });
		const b = repaired.main.elements.find((e) => e.id === "b");
		if (b?.type !== "video") throw new Error("unreachable");
		expect(b.transitionIn?.durationSec).toBeCloseTo(0.3, 6);
	});
});
