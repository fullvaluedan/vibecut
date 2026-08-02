import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { SceneTracks, VideoElement, VideoTrack } from "@/timeline";
import { mediaTime, ZERO_MEDIA_TIME } from "@/wasm";

/**
 * The "Cutout" affordance in the clip Effects tab is a THIN WRAPPER: enabling
 * chroma key runs `AddClipEffectCommand` and removing it runs
 * `RemoveClipEffectCommand`, the same two commands the effect list uses. This
 * exercises that round trip end to end (add -> params present -> remove ->
 * gone -> undo restores), which is the contract the wrapper depends on.
 */

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

import { AddClipEffectCommand } from "@/commands/timeline/element/effects/add-effect";
import { RemoveClipEffectCommand } from "@/commands/timeline/element/effects/remove-effect";
import { effectsRegistry } from "@/effects";
import { registerDefaultEffects } from "@/effects/definitions";
import { CHROMA_KEY_EFFECT_TYPE } from "@/effects/definitions/chroma-key";
import { buildEmptyTrack } from "@/timeline/placement/track-factory";

const TRACK_ID = "main";
const ELEMENT_ID = "clip-1";

function videoElement(): VideoElement {
	return {
		id: ELEMENT_ID,
		type: "video",
		name: ELEMENT_ID,
		startTime: mediaTime({ ticks: 0 }),
		duration: mediaTime({ ticks: 100 }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		mediaId: "m1",
		params: {
			"transform.positionX": 0,
			"transform.positionY": 0,
			"transform.scaleX": 1,
			"transform.scaleY": 1,
			"transform.rotate": 0,
			opacity: 1,
		},
	};
}

function readEffects() {
	const track = currentTracks.main;
	const element = track.elements.find((item) => item.id === ELEMENT_ID);
	return element && "effects" in element ? (element.effects ?? []) : [];
}

describe("Cutout enable/remove round trip", () => {
	beforeEach(() => {
		if (!effectsRegistry.has(CHROMA_KEY_EFFECT_TYPE)) registerDefaultEffects();
		const main: VideoTrack = {
			...buildEmptyTrack({ id: TRACK_ID, type: "video" }),
			elements: [videoElement()],
		} as VideoTrack;
		currentTracks = { main, overlay: [] };
	});

	test("enabling adds one chroma-key effect with its declared defaults", () => {
		const add = new AddClipEffectCommand({
			trackId: TRACK_ID,
			elementId: ELEMENT_ID,
			effectType: CHROMA_KEY_EFFECT_TYPE,
		});
		add.execute();

		const effects = readEffects();
		expect(effects).toHaveLength(1);
		expect(effects[0].type).toBe(CHROMA_KEY_EFFECT_TYPE);
		expect(effects[0].enabled).toBe(true);
		expect(effects[0].params).toEqual({
			keyColor: "#00FF00",
			similarity: 20,
			smoothness: 10,
			spill: 50,
			shadow: 0,
		});
		expect(add.getEffectId()).toBe(effects[0].id);
	});

	test("removing takes exactly that instance back off the clip", () => {
		const add = new AddClipEffectCommand({
			trackId: TRACK_ID,
			elementId: ELEMENT_ID,
			effectType: CHROMA_KEY_EFFECT_TYPE,
		});
		add.execute();
		const effectId = add.getEffectId();
		expect(effectId).not.toBeNull();

		new RemoveClipEffectCommand({
			trackId: TRACK_ID,
			elementId: ELEMENT_ID,
			effectId: effectId as string,
		}).execute();

		expect(readEffects()).toHaveLength(0);
	});

	test("undo puts the effect back with its params intact", () => {
		const add = new AddClipEffectCommand({
			trackId: TRACK_ID,
			elementId: ELEMENT_ID,
			effectType: CHROMA_KEY_EFFECT_TYPE,
		});
		add.execute();
		const added = readEffects()[0];

		const remove = new RemoveClipEffectCommand({
			trackId: TRACK_ID,
			elementId: ELEMENT_ID,
			effectId: added.id,
		});
		remove.execute();
		expect(readEffects()).toHaveLength(0);

		remove.undo();
		expect(readEffects()).toEqual([added]);
	});

	test("undoing the enable leaves the clip with no effects at all", () => {
		const add = new AddClipEffectCommand({
			trackId: TRACK_ID,
			elementId: ELEMENT_ID,
			effectType: CHROMA_KEY_EFFECT_TYPE,
		});
		add.execute();
		add.undo();
		expect(readEffects()).toHaveLength(0);
	});

	test("chroma key coexists with another effect instead of replacing it", () => {
		new AddClipEffectCommand({
			trackId: TRACK_ID,
			elementId: ELEMENT_ID,
			effectType: "blur",
		}).execute();
		const addKey = new AddClipEffectCommand({
			trackId: TRACK_ID,
			elementId: ELEMENT_ID,
			effectType: CHROMA_KEY_EFFECT_TYPE,
		});
		addKey.execute();

		expect(readEffects().map((effect) => effect.type)).toEqual([
			"blur",
			CHROMA_KEY_EFFECT_TYPE,
		]);

		new RemoveClipEffectCommand({
			trackId: TRACK_ID,
			elementId: ELEMENT_ID,
			effectId: addKey.getEffectId() as string,
		}).execute();

		expect(readEffects().map((effect) => effect.type)).toEqual(["blur"]);
	});

	test("two chroma-key instances get distinct ids", () => {
		const first = new AddClipEffectCommand({
			trackId: TRACK_ID,
			elementId: ELEMENT_ID,
			effectType: CHROMA_KEY_EFFECT_TYPE,
		});
		first.execute();
		const second = new AddClipEffectCommand({
			trackId: TRACK_ID,
			elementId: ELEMENT_ID,
			effectType: CHROMA_KEY_EFFECT_TYPE,
		});
		second.execute();

		expect(first.getEffectId()).not.toBe(second.getEffectId());
		expect(readEffects()).toHaveLength(2);
	});
});
