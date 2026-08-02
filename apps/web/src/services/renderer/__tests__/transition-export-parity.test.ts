import { describe, expect, test } from "bun:test";
import type { MediaAsset } from "@/media/types";
import type { TBackground, TCanvasSize } from "@/project/types";
import type { SceneTracks, VideoElement, VideoTrack } from "@/timeline";
import type { TransitionSpec } from "@/timeline/transitions";
import { getSourceTimeAtClipTime } from "@/retime";
import { mediaTime, TICKS_PER_SECOND } from "@/wasm";
import { buildScene } from "../scene-builder";
import { SolidColorNode } from "../nodes/solid-color-node";
import { VideoNode } from "../nodes/video-node";
import {
	clampTransitionSourceTicks,
	isTransitionExtendedTime,
	resolveTransitionClipTime,
	resolveTransitionOpacityFactor,
} from "../transition-window";

const SEC = TICKS_PER_SECOND;
const CANVAS: TCanvasSize = { width: 1920, height: 1080 };
const BACKGROUND: TBackground = { type: "color", color: "transparent" };

/**
 * EXPORT PARITY. Preview and export both render through `buildScene`, so
 * asserting on the built tree with the same three helpers `resolve.ts` calls
 * is an assertion about BOTH paths at once - there is no second code path to
 * drift from.
 */
function videoAsset({ id }: { id: string }): MediaAsset {
	return {
		id,
		type: "video",
		name: id,
		file: new File(["bytes"], `${id}.mp4`, { type: "video/mp4" }),
		url: `blob:${id}`,
		width: 1920,
		height: 1080,
	} as unknown as MediaAsset;
}

function clip({
	id,
	mediaId,
	startSec,
	durationSec,
	trimStartSec = 0,
	trimEndSec = 0,
	opacity = 1,
	transitionIn,
}: {
	id: string;
	mediaId: string;
	startSec: number;
	durationSec: number;
	trimStartSec?: number;
	trimEndSec?: number;
	opacity?: number;
	transitionIn?: TransitionSpec;
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
		params: { opacity },
		...(transitionIn ? { transitionIn } : {}),
	} as unknown as VideoElement;
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

function build({
	elements,
	mediaAssets,
}: {
	elements: VideoElement[];
	mediaAssets: MediaAsset[];
}) {
	return buildScene({
		canvasSize: CANVAS,
		tracks: scene({ elements }),
		mediaAssets,
		duration: 8 * SEC,
		background: BACKGROUND,
	});
}

/** Exactly what `resolveVideoNode` computes before it hits the decoder. */
function sample({ node, time }: { node: VideoNode; time: number }) {
	const clipTime = resolveTransitionClipTime({
		timeOffset: node.params.timeOffset,
		duration: node.params.duration,
		transitions: node.params.transitions,
		time,
	});
	if (clipTime === null) return null;

	const raw =
		node.params.trimStart +
		getSourceTimeAtClipTime({
			clipTime,
			retime: node.params.retime,
			clipDuration: node.params.duration,
		});
	const sourceTicks = isTransitionExtendedTime({
		timeOffset: node.params.timeOffset,
		duration: node.params.duration,
		time,
	})
		? clampTransitionSourceTicks({
				ticks: raw,
				trimStart: node.params.trimStart,
				trimEnd: node.params.trimEnd,
				duration: node.params.duration,
				retime: node.params.retime,
			})
		: raw;

	return {
		sourceTicks,
		opacity:
			node.params.opacity *
			resolveTransitionOpacityFactor({
				transitions: node.params.transitions,
				time,
			}),
	};
}

function videoNodes(root: { children: unknown[] }): VideoNode[] {
	return root.children.filter(
		(child): child is VideoNode => child instanceof VideoNode,
	);
}

describe("crossDissolve export parity: sampled source times + opacities", () => {
	// Both clips have 2s of trimmed-away source on the facing side, so neither
	// needs to edge-hold at a 1s transition (needs 0.5s per side).
	const elements = [
		clip({
			id: "a",
			mediaId: "one",
			startSec: 0,
			durationSec: 4,
			trimStartSec: 1,
			trimEndSec: 2,
		}),
		clip({
			id: "b",
			mediaId: "two",
			startSec: 4,
			durationSec: 4,
			trimStartSec: 2,
			trimEndSec: 1,
			transitionIn: { id: "t", kind: "crossDissolve", durationSec: 1 },
		}),
	];
	const root = build({
		elements,
		mediaAssets: [videoAsset({ id: "one" }), videoAsset({ id: "two" })],
	});
	const [left, right] = videoNodes(root);

	test("the scene builder attached the two roles", () => {
		expect(left.params.transitions?.tail?.direction).toBe("out");
		expect(right.params.transitions?.head?.direction).toBe("in");
	});

	test("one frame BEFORE the window: hard cut, only the left clip renders", () => {
		const time = 3.5 * SEC - 4_000;
		expect(sample({ node: left, time })?.opacity).toBeCloseTo(1, 6);
		expect(sample({ node: right, time })).toBeNull();
	});

	test("window START: left at full, right just appearing before its in point", () => {
		const time = 3.5 * SEC;
		expect(sample({ node: left, time })).toEqual({
			// trimStart 1s + 3.5s into the clip.
			sourceTicks: 4.5 * SEC,
			opacity: 1,
		});
		expect(sample({ node: right, time })).toEqual({
			// trimStart 2s minus the 0.5s it reaches back into trimmed source.
			sourceTicks: 1.5 * SEC,
			opacity: 0,
		});
	});

	test("window MIDPOINT (the cut): both at half, left past its out point", () => {
		const time = 4 * SEC;
		const l = sample({ node: left, time });
		const r = sample({ node: right, time });
		// Left clip's own span ended at 4s; it is now sampling 4s of source
		// (trimStart 1s + 4s wall) inside its 2s of trimmed-away tail.
		expect(l?.sourceTicks).toBe(5 * SEC);
		expect(r?.sourceTicks).toBe(2 * SEC);
		expect(l?.opacity).toBeCloseTo(0.5, 6);
		expect(r?.opacity).toBeCloseTo(0.5, 6);
	});

	test("window END: left gone, right at full", () => {
		const time = 4.5 * SEC;
		expect(sample({ node: left, time })).toBeNull();
		expect(sample({ node: right, time })).toEqual({
			sourceTicks: 2.5 * SEC,
			opacity: 1,
		});
	});

	test("one frame AFTER the window: hard cut again", () => {
		const time = 4.5 * SEC + 4_000;
		expect(sample({ node: left, time })).toBeNull();
		expect(sample({ node: right, time })?.opacity).toBeCloseTo(1, 6);
	});
});

describe("crossDissolve with no headroom holds its edge frame", () => {
	const root = build({
		elements: [
			clip({ id: "a", mediaId: "one", startSec: 0, durationSec: 4 }),
			clip({
				id: "b",
				mediaId: "two",
				startSec: 4,
				durationSec: 4,
				transitionIn: { id: "t", kind: "crossDissolve", durationSec: 1 },
			}),
		],
		mediaAssets: [videoAsset({ id: "one" }), videoAsset({ id: "two" })],
	});
	const [left, right] = videoNodes(root);

	test("the outgoing clip freezes on its last source frame", () => {
		expect(sample({ node: left, time: 4 * SEC })?.sourceTicks).toBe(4 * SEC);
		expect(sample({ node: left, time: 4.25 * SEC })?.sourceTicks).toBe(4 * SEC);
	});

	test("the incoming clip freezes on its first source frame", () => {
		expect(sample({ node: right, time: 3.5 * SEC })?.sourceTicks).toBe(0);
		expect(sample({ node: right, time: 3.9 * SEC })?.sourceTicks).toBe(0);
	});

	test("the opacity ramp is unaffected by the freeze", () => {
		expect(sample({ node: left, time: 4 * SEC })?.opacity).toBeCloseTo(0.5, 6);
		expect(sample({ node: right, time: 4 * SEC })?.opacity).toBeCloseTo(0.5, 6);
	});
});

describe("authored opacity is multiplied, never clobbered", () => {
	const root = build({
		elements: [
			clip({
				id: "a",
				mediaId: "one",
				startSec: 0,
				durationSec: 4,
				opacity: 0.4,
			}),
			clip({
				id: "b",
				mediaId: "two",
				startSec: 4,
				durationSec: 4,
				transitionIn: { id: "t", kind: "crossDissolve", durationSec: 1 },
			}),
		],
		mediaAssets: [videoAsset({ id: "one" }), videoAsset({ id: "two" })],
	});
	const [left] = videoNodes(root);

	test("a clip held at 40% dissolves 0.4 -> 0", () => {
		expect(sample({ node: left, time: 3.5 * SEC })?.opacity).toBeCloseTo(0.4, 6);
		expect(sample({ node: left, time: 4 * SEC })?.opacity).toBeCloseTo(0.2, 6);
	});
});

describe("dip to black emits a colour layer, not an overlap", () => {
	const root = build({
		elements: [
			clip({ id: "a", mediaId: "one", startSec: 0, durationSec: 4 }),
			clip({
				id: "b",
				mediaId: "two",
				startSec: 4,
				durationSec: 4,
				transitionIn: { id: "t", kind: "dipToBlack", durationSec: 1 },
			}),
		],
		mediaAssets: [videoAsset({ id: "one" }), videoAsset({ id: "two" })],
	});

	const dip = root.children.find(
		(child): child is SolidColorNode => child instanceof SolidColorNode,
	);

	test("the colour layer spans the cut and is drawn ABOVE the main clips", () => {
		expect(dip).toBeDefined();
		expect(dip?.params.color).toBe("#000000");
		expect(dip?.params.timeOffset).toBe(3.5 * SEC);
		expect(dip?.params.duration).toBe(1 * SEC);
		const nodes = root.children;
		expect(nodes.indexOf(dip as never)).toBeGreaterThan(
			nodes.findIndex((child) => child instanceof VideoNode),
		);
	});

	test("its alpha ramps 0 -> 1 at the cut -> 0", () => {
		const at = (time: number) =>
			(dip as SolidColorNode).params.opacity *
			resolveTransitionOpacityFactor({
				transitions: (dip as SolidColorNode).params.transitions,
				time,
			});
		expect(at(3.5 * SEC)).toBeCloseTo(0, 6);
		expect(at(4 * SEC)).toBeCloseTo(1, 6);
		expect(at(4.5 * SEC)).toBeCloseTo(0, 6);
	});

	test("neither clip gets a ramp or an extended window", () => {
		const [left, right] = videoNodes(root);
		expect(left.params.transitions).toBeUndefined();
		expect(right.params.transitions).toBeUndefined();
		expect(sample({ node: left, time: 4.2 * SEC })).toBeNull();
		expect(sample({ node: right, time: 3.8 * SEC })).toBeNull();
	});
});

describe("same-source crossDissolve asks for its own decode sink", () => {
	test("the right side carries decodeConsumerId, the left keeps the shared sink", () => {
		const root = build({
			elements: [
				clip({ id: "a", mediaId: "same", startSec: 0, durationSec: 4 }),
				clip({
					id: "b",
					mediaId: "same",
					startSec: 4,
					durationSec: 4,
					transitionIn: { id: "t", kind: "crossDissolve", durationSec: 1 },
				}),
			],
			mediaAssets: [videoAsset({ id: "same" })],
		});
		const [left, right] = videoNodes(root);
		expect(left.params.decodeConsumerId).toBeUndefined();
		expect(right.params.decodeConsumerId).toBe("b");
	});
});
