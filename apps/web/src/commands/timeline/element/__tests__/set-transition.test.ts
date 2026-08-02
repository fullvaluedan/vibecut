import { describe, expect, mock, test } from "bun:test";
import type { SceneTracks, VideoElement, VideoTrack } from "@/timeline";
import {
	reconcileSceneTransitions,
	type TransitionSpec,
} from "@/timeline/transitions";
import { mediaTime, TICKS_PER_SECOND } from "@/wasm";

// EditorCore stand-in. `updateTracks` runs the SAME reconciler the real
// TimelineManager chokepoint runs, so this exercises the real contract: a
// command writes one field, the chokepoint normalises the result.
let currentTracks: SceneTracks;
mock.module("@/core", () => ({
	EditorCore: {
		getInstance: () => ({
			scenes: { getActiveScene: () => ({ tracks: currentTracks }) },
			timeline: {
				updateTracks: (tracks: SceneTracks) => {
					currentTracks = reconcileSceneTransitions({ tracks });
				},
			},
		}),
	},
}));

import { SetElementTransitionCommand } from "@/commands/timeline/element/transitions";

const SEC = TICKS_PER_SECOND;

function clip({
	id,
	startSec,
	durationSec,
	transitionIn,
}: {
	id: string;
	startSec: number;
	durationSec: number;
	transitionIn?: TransitionSpec;
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
	} as unknown as VideoElement;
}

function buildTracks({ elements }: { elements: VideoElement[] }): SceneTracks {
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

function readB(): VideoElement {
	const element = currentTracks.main.elements.find((e) => e.id === "b");
	if (element?.type !== "video") throw new Error("expected b");
	return element;
}

function pair(): SceneTracks {
	return buildTracks({
		elements: [
			clip({ id: "a", startSec: 0, durationSec: 4 }),
			clip({ id: "b", startSec: 4, durationSec: 4 }),
		],
	});
}

describe("SetElementTransitionCommand", () => {
	test("apply writes the spec on the join's right neighbour", () => {
		currentTracks = pair();
		new SetElementTransitionCommand({
			trackId: "main",
			elementId: "b",
			field: "transitionIn",
			spec: { id: "x", kind: "crossDissolve", durationSec: 0.5 },
		}).execute();

		expect(readB().transitionIn).toEqual({
			id: "x",
			kind: "crossDissolve",
			durationSec: 0.5,
		});
	});

	test("changing the duration keeps the transition's identity", () => {
		currentTracks = pair();
		new SetElementTransitionCommand({
			trackId: "main",
			elementId: "b",
			field: "transitionIn",
			spec: { id: "x", kind: "crossDissolve", durationSec: 0.5 },
		}).execute();
		new SetElementTransitionCommand({
			trackId: "main",
			elementId: "b",
			field: "transitionIn",
			spec: { id: "x", kind: "crossDissolve", durationSec: 1 },
		}).execute();

		expect(readB().transitionIn?.id).toBe("x");
		expect(readB().transitionIn?.durationSec).toBe(1);
	});

	test("remove is spec: null", () => {
		currentTracks = buildTracks({
			elements: [
				clip({ id: "a", startSec: 0, durationSec: 4 }),
				clip({
					id: "b",
					startSec: 4,
					durationSec: 4,
					transitionIn: { id: "x", kind: "crossDissolve", durationSec: 0.5 },
				}),
			],
		});
		new SetElementTransitionCommand({
			trackId: "main",
			elementId: "b",
			field: "transitionIn",
			spec: null,
		}).execute();

		expect("transitionIn" in readB()).toBe(false);
	});

	test("an over-long duration is normalised INSIDE the same undo scope", () => {
		currentTracks = buildTracks({
			elements: [
				clip({ id: "a", startSec: 0, durationSec: 4 }),
				clip({ id: "b", startSec: 4, durationSec: 1 }),
			],
		});
		const command = new SetElementTransitionCommand({
			trackId: "main",
			elementId: "b",
			field: "transitionIn",
			spec: { id: "x", kind: "crossDissolve", durationSec: 3 },
		});
		command.execute();

		expect(readB().transitionIn?.durationSec).toBeCloseTo(0.5, 6);

		command.undo();
		expect("transitionIn" in readB()).toBe(false);
	});

	test("undo restores the exact pre-command tracks", () => {
		const before = pair();
		currentTracks = before;
		const command = new SetElementTransitionCommand({
			trackId: "main",
			elementId: "b",
			field: "transitionIn",
			spec: { id: "x", kind: "dipToWhite", durationSec: 0.25 },
		});
		command.execute();
		expect(readB().transitionIn?.kind).toBe("dipToWhite");
		command.undo();
		expect(currentTracks).toBe(before);
	});
});
