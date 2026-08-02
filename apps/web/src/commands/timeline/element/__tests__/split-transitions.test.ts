import { describe, expect, mock, test } from "bun:test";
import type { SceneTracks, VideoElement, VideoTrack } from "@/timeline";
import type { TransitionSpec } from "@/timeline/transitions";
import { mediaTime, TICKS_PER_SECOND } from "@/wasm";

// Minimal EditorCore stand-in, mirroring split-elements-linkid.test.ts.
let currentTracks: SceneTracks;
mock.module("@/core", () => ({
	EditorCore: {
		getInstance: () => ({
			scenes: { getActiveScene: () => ({ tracks: currentTracks }) },
			timeline: {
				updateTracks: (tracks: SceneTracks) => {
					currentTracks = tracks;
				},
			},
		}),
	},
}));

import { SplitElementsCommand } from "@/commands/timeline/element/split-elements";

const SEC = TICKS_PER_SECOND;

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

function videoAt({ index }: { index: number }): VideoElement {
	const element = currentTracks.main.elements[index];
	if (element.type !== "video") throw new Error("expected a video element");
	return element;
}

describe("SplitElementsCommand keeps a transition on its ORIGINAL boundary", () => {
	test("splitting the right neighbour keeps the join transition on the LEFT half", () => {
		currentTracks = buildTracks({
			elements: [
				clip({ id: "a", startSec: 0, durationSec: 4 }),
				clip({
					id: "b",
					startSec: 4,
					durationSec: 4,
					transitionIn: { id: "x", kind: "crossDissolve", durationSec: 1 },
				}),
			],
		});

		new SplitElementsCommand({
			elements: [{ trackId: "main", elementId: "b" }],
			splitTime: mediaTime({ ticks: 6 * SEC }),
		}).execute();

		expect(currentTracks.main.elements).toHaveLength(3);
		// The left half still owns the join with 'a'.
		expect(videoAt({ index: 1 }).transitionIn?.kind).toBe("crossDissolve");
		// The right half is a BRAND-NEW cut, so it starts hard.
		expect(videoAt({ index: 2 }).transitionIn).toBeUndefined();
	});

	test("splitting the left neighbour leaves the join transition where it was", () => {
		currentTracks = buildTracks({
			elements: [
				clip({ id: "a", startSec: 0, durationSec: 4 }),
				clip({
					id: "b",
					startSec: 4,
					durationSec: 4,
					transitionIn: { id: "x", kind: "crossDissolve", durationSec: 1 },
				}),
			],
		});

		new SplitElementsCommand({
			elements: [{ trackId: "main", elementId: "a" }],
			splitTime: mediaTime({ ticks: 2 * SEC }),
		}).execute();

		expect(currentTracks.main.elements).toHaveLength(3);
		expect(videoAt({ index: 2 }).id).toBe("b");
		expect(videoAt({ index: 2 }).transitionIn?.kind).toBe("crossDissolve");
	});

	test("a tail fade follows the RIGHT half, which now owns the tail", () => {
		currentTracks = buildTracks({
			elements: [
				clip({
					id: "a",
					startSec: 0,
					durationSec: 4,
					transitionIn: { id: "in", kind: "fade", durationSec: 0.5 },
					transitionOut: { id: "out", kind: "fade", durationSec: 0.5 },
				}),
			],
		});

		new SplitElementsCommand({
			elements: [{ trackId: "main", elementId: "a" }],
			splitTime: mediaTime({ ticks: 2 * SEC }),
		}).execute();

		expect(videoAt({ index: 0 }).transitionIn?.kind).toBe("fade");
		expect(videoAt({ index: 0 }).transitionOut).toBeUndefined();
		expect(videoAt({ index: 1 }).transitionIn).toBeUndefined();
		expect(videoAt({ index: 1 }).transitionOut?.kind).toBe("fade");
	});

	test("undo restores the pre-split transitions exactly", () => {
		const before = buildTracks({
			elements: [
				clip({ id: "a", startSec: 0, durationSec: 4 }),
				clip({
					id: "b",
					startSec: 4,
					durationSec: 4,
					transitionIn: { id: "x", kind: "crossDissolve", durationSec: 1 },
				}),
			],
		});
		currentTracks = before;

		const command = new SplitElementsCommand({
			elements: [{ trackId: "main", elementId: "b" }],
			splitTime: mediaTime({ ticks: 6 * SEC }),
		});
		command.execute();
		command.undo();

		expect(currentTracks).toBe(before);
		expect(videoAt({ index: 1 }).transitionIn?.durationSec).toBe(1);
	});
});
