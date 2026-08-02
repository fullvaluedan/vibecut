import { describe, expect, test } from "bun:test";
import type {
	ImageElement,
	SceneTracks,
	VideoElement,
	VideoTrack,
} from "@/timeline";
import { mediaTime, TICKS_PER_SECOND, ZERO_MEDIA_TIME } from "@/wasm";
import {
	canBoundaryHoldTransition,
	clampTransitionDurationSec,
	collectTransitionBoundaries,
	describeTransitionHeadroom,
	reconcileSceneTransitions,
	reconcileTrackTransitions,
} from "../model";
import {
	MAX_TRANSITION_DURATION_SEC,
	MIN_TRANSITION_DURATION_SEC,
	type TransitionSpec,
} from "../types";

const SEC = TICKS_PER_SECOND;

function spec({
	kind = "crossDissolve",
	durationSec = 0.5,
	id = "t1",
}: Partial<TransitionSpec> = {}): TransitionSpec {
	return { id, kind, durationSec } as TransitionSpec;
}

function clip({
	id,
	startSec,
	durationSec,
	trimStartSec = 0,
	trimEndSec = 0,
	mediaId = "m",
	transitionIn,
	transitionOut,
}: {
	id: string;
	startSec: number;
	durationSec: number;
	trimStartSec?: number;
	trimEndSec?: number;
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
		trimStart: mediaTime({ ticks: Math.round(trimStartSec * SEC) }),
		trimEnd: mediaTime({ ticks: Math.round(trimEndSec * SEC) }),
		params: {},
		...(transitionIn ? { transitionIn } : {}),
		...(transitionOut ? { transitionOut } : {}),
	} as VideoElement;
}

function mainTrack({ elements }: { elements: VideoElement[] }): VideoTrack {
	return {
		id: "main",
		type: "video",
		name: "V1",
		muted: false,
		hidden: false,
		elements,
	} as unknown as VideoTrack;
}

function scene({ elements }: { elements: VideoElement[] }): SceneTracks {
	return { overlay: [], main: mainTrack({ elements }), audio: [] };
}

function readIn({
	tracks,
	id,
}: {
	tracks: SceneTracks;
	id: string;
}): TransitionSpec | undefined {
	const element = tracks.main.elements.find((candidate) => candidate.id === id);
	return element && element.type === "video" ? element.transitionIn : undefined;
}

describe("transition boundaries", () => {
	test("a join is emitted once, owned by the RIGHT clip's transitionIn", () => {
		const boundaries = collectTransitionBoundaries({
			elements: [
				clip({ id: "a", startSec: 0, durationSec: 4 }),
				clip({ id: "b", startSec: 4, durationSec: 4 }),
			],
		});

		const joins = boundaries.filter((b) => b.kind === "join");
		expect(joins).toHaveLength(1);
		expect(joins[0].leftElementId).toBe("a");
		expect(joins[0].rightElementId).toBe("b");
		expect(joins[0].ownerElementId).toBe("b");
		expect(joins[0].ownerField).toBe("transitionIn");
		expect(joins[0].timeTicks).toBe(4 * SEC);
		expect(joins[0].allowedKinds).toEqual([
			"crossDissolve",
			"dipToBlack",
			"dipToWhite",
		]);
	});

	test("the first clip's head and the last clip's tail are OPEN boundaries that only take a fade", () => {
		const boundaries = collectTransitionBoundaries({
			elements: [
				clip({ id: "a", startSec: 0, durationSec: 4 }),
				clip({ id: "b", startSec: 4, durationSec: 4 }),
			],
		});

		const head = boundaries.find((b) => b.kind === "openHead");
		const tail = boundaries.find((b) => b.kind === "openTail");
		expect(head?.ownerElementId).toBe("a");
		expect(head?.ownerField).toBe("transitionIn");
		expect(tail?.ownerElementId).toBe("b");
		expect(tail?.ownerField).toBe("transitionOut");
		expect(head?.allowedKinds).toEqual(["fade"]);
		expect(tail?.allowedKinds).toEqual(["fade"]);
	});

	test("a gap between two clips makes an openTail and an openHead, not a join", () => {
		const boundaries = collectTransitionBoundaries({
			elements: [
				clip({ id: "a", startSec: 0, durationSec: 4 }),
				clip({ id: "b", startSec: 5, durationSec: 4 }),
			],
		});
		expect(boundaries.some((b) => b.kind === "join")).toBe(false);
		expect(boundaries.filter((b) => b.kind === "openHead")).toHaveLength(2);
		expect(boundaries.filter((b) => b.kind === "openTail")).toHaveLength(2);
	});

	test("maxDurationSec is the shorter neighbour's half", () => {
		const boundaries = collectTransitionBoundaries({
			elements: [
				clip({ id: "a", startSec: 0, durationSec: 4 }),
				clip({ id: "b", startSec: 4, durationSec: 1 }),
			],
		});
		const join = boundaries.find((b) => b.kind === "join");
		expect(join?.maxDurationSec).toBeCloseTo(0.5, 6);
	});

	test("a boundary too short for the minimum holds no transition", () => {
		const boundaries = collectTransitionBoundaries({
			elements: [
				clip({ id: "a", startSec: 0, durationSec: 4 }),
				clip({ id: "b", startSec: 4, durationSec: 0.05 }),
			],
		});
		const join = boundaries.find((b) => b.kind === "join");
		expect(join).toBeDefined();
		expect(canBoundaryHoldTransition({ boundary: join! })).toBe(false);
	});
});

describe("duration clamping", () => {
	test("clamps into [MIN, boundary max] and respects the global ceiling", () => {
		expect(
			clampTransitionDurationSec({ requestedSec: 10, maxDurationSec: 2 }),
		).toBe(2);
		expect(
			clampTransitionDurationSec({ requestedSec: 0.001, maxDurationSec: 2 }),
		).toBe(MIN_TRANSITION_DURATION_SEC);
		expect(
			clampTransitionDurationSec({ requestedSec: 99, maxDurationSec: 99 }),
		).toBe(MAX_TRANSITION_DURATION_SEC);
		expect(
			clampTransitionDurationSec({
				requestedSec: Number.NaN,
				maxDurationSec: 2,
			}),
		).toBe(MIN_TRANSITION_DURATION_SEC);
	});
});

describe("source headroom / edge hold", () => {
	test("a side trimmed to the end of its file must edge-hold", () => {
		const headroom = describeTransitionHeadroom({
			left: clip({ id: "a", startSec: 0, durationSec: 4, trimEndSec: 0 }),
			right: clip({
				id: "b",
				startSec: 4,
				durationSec: 4,
				trimStartSec: 2,
			}),
			durationSec: 1,
		});
		expect(headroom.leftSec).toBe(0);
		expect(headroom.leftEdgeHold).toBe(true);
		expect(headroom.rightSec).toBe(2);
		expect(headroom.rightEdgeHold).toBe(false);
	});

	test("an image never edge-holds - a still is its own edge frame", () => {
		const image = {
			id: "img",
			type: "image",
			name: "img",
			mediaId: "m",
			startTime: ZERO_MEDIA_TIME,
			duration: mediaTime({ ticks: 4 * SEC }),
			trimStart: ZERO_MEDIA_TIME,
			trimEnd: ZERO_MEDIA_TIME,
			params: {},
		} as unknown as ImageElement;

		const headroom = describeTransitionHeadroom({
			left: image,
			right: image,
			durationSec: 2,
		});
		expect(headroom.leftEdgeHold).toBe(false);
		expect(headroom.rightEdgeHold).toBe(false);
	});
});

describe("survive / die reconciliation", () => {
	test("a crossDissolve survives while its join exists", () => {
		const tracks = scene({
			elements: [
				clip({ id: "a", startSec: 0, durationSec: 4 }),
				clip({ id: "b", startSec: 4, durationSec: 4, transitionIn: spec() }),
			],
		});
		const next = reconcileSceneTransitions({ tracks });
		expect(next).toBe(tracks);
		expect(readIn({ tracks: next, id: "b" })?.kind).toBe("crossDissolve");
	});

	test("DELETE of the left neighbour kills the transition", () => {
		const tracks = scene({
			elements: [
				clip({ id: "b", startSec: 4, durationSec: 4, transitionIn: spec() }),
			],
		});
		expect(readIn({ tracks: reconcileSceneTransitions({ tracks }), id: "b" })).toBeUndefined();
	});

	test("DELETE of the right neighbour takes the spec with it (it lived there)", () => {
		const tracks = scene({
			elements: [clip({ id: "a", startSec: 0, durationSec: 4 })],
		});
		const next = reconcileSceneTransitions({ tracks });
		expect(next.main.elements).toHaveLength(1);
		expect(readIn({ tracks: next, id: "a" })).toBeUndefined();
	});

	test("MOVE that opens a gap kills the transition", () => {
		const tracks = scene({
			elements: [
				clip({ id: "a", startSec: 0, durationSec: 4 }),
				clip({ id: "b", startSec: 6, durationSec: 4, transitionIn: spec() }),
			],
		});
		expect(readIn({ tracks: reconcileSceneTransitions({ tracks }), id: "b" })).toBeUndefined();
	});

	test("RIPPLE / MAGNET shifts that keep the join keep the transition", () => {
		// Both clips shifted right by the same amount: the join still abuts.
		const tracks = scene({
			elements: [
				clip({ id: "a", startSec: 2, durationSec: 4 }),
				clip({ id: "b", startSec: 6, durationSec: 4, transitionIn: spec() }),
			],
		});
		expect(readIn({ tracks: reconcileSceneTransitions({ tracks }), id: "b" })?.durationSec).toBe(0.5);
	});

	test("TRIM that shortens a neighbour clamps the duration down", () => {
		const tracks = scene({
			elements: [
				clip({ id: "a", startSec: 0, durationSec: 4 }),
				clip({
					id: "b",
					startSec: 4,
					durationSec: 0.8,
					transitionIn: spec({ durationSec: 2 }),
				}),
			],
		});
		const next = reconcileSceneTransitions({ tracks });
		expect(readIn({ tracks: next, id: "b" })?.durationSec).toBeCloseTo(0.4, 6);
	});

	test("a fade cannot live on a join, and a crossDissolve cannot live on an open head", () => {
		const joinWithFade = scene({
			elements: [
				clip({ id: "a", startSec: 0, durationSec: 4 }),
				clip({
					id: "b",
					startSec: 4,
					durationSec: 4,
					transitionIn: spec({ kind: "fade" }),
				}),
			],
		});
		expect(
			readIn({ tracks: reconcileSceneTransitions({ tracks: joinWithFade }), id: "b" }),
		).toBeUndefined();

		const openWithDissolve = scene({
			elements: [clip({ id: "a", startSec: 0, durationSec: 4, transitionIn: spec() })],
		});
		expect(
			readIn({
				tracks: reconcileSceneTransitions({ tracks: openWithDissolve }),
				id: "a",
			}),
		).toBeUndefined();
	});

	test("a fade survives on an open head and on an open tail", () => {
		const tracks = scene({
			elements: [
				clip({
					id: "a",
					startSec: 0,
					durationSec: 4,
					transitionIn: spec({ kind: "fade" }),
					transitionOut: spec({ kind: "fade", id: "t2" }),
				}),
			],
		});
		const next = reconcileSceneTransitions({ tracks });
		expect(next).toBe(tracks);
	});

	test("moving a clip OFF the main track strips its transitions", () => {
		const overlay = mainTrack({
			elements: [
				clip({ id: "a", startSec: 0, durationSec: 4 }),
				clip({ id: "b", startSec: 4, durationSec: 4, transitionIn: spec() }),
			],
		});
		const tracks: SceneTracks = {
			overlay: [{ ...overlay, id: "overlay-0" }],
			main: mainTrack({ elements: [] }),
			audio: [],
		};
		const next = reconcileSceneTransitions({ tracks });
		const moved = next.overlay[0].elements.find((e) => e.id === "b");
		expect(moved && "transitionIn" in moved ? moved.transitionIn : undefined).toBeUndefined();
	});

	test("reconciling a track with no transitions returns the SAME object", () => {
		const track = mainTrack({
			elements: [clip({ id: "a", startSec: 0, durationSec: 4 })],
		});
		expect(reconcileTrackTransitions({ track })).toBe(track);
	});
});
