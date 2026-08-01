import { beforeEach, describe, expect, test } from "bun:test";
import type { EditorCore } from "@/core";
import { Command, type CommandResult } from "@/commands/base-command";
import type {
	AudioElement,
	AudioTrack,
	SceneTracks,
	VideoElement,
	VideoTrack,
} from "@/timeline";
import { mediaTime, ZERO_MEDIA_TIME } from "@/wasm";

// The whole magnet path runs against the editor the manager was constructed
// with (never the singleton), so a plain stub is enough - no module mocking,
// and nothing leaks into other suites.
let currentTracks: SceneTracks;

import { CommandManager } from "@/core/managers/commands";

const FRAME = 4_000;

function vid({
	id,
	startTime,
	duration,
	linkId,
}: {
	id: string;
	startTime: number;
	duration: number;
	linkId?: string;
}): VideoElement {
	return {
		id,
		type: "video",
		name: id,
		startTime: mediaTime({ ticks: startTime }),
		duration: mediaTime({ ticks: duration }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		mediaId: `media-${id}`,
		...(linkId ? { linkId } : {}),
		params: {
			"transform.positionX": 0,
			"transform.positionY": 0,
			"transform.scaleX": 1,
			"transform.scaleY": 1,
			"transform.rotate": 0,
			opacity: 1,
		},
	} as VideoElement;
}

function aud({
	id,
	startTime,
	duration,
	linkId,
}: {
	id: string;
	startTime: number;
	duration: number;
	linkId?: string;
}): AudioElement {
	return {
		id,
		type: "audio",
		name: id,
		startTime: mediaTime({ ticks: startTime }),
		duration: mediaTime({ ticks: duration }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		sourceType: "upload",
		mediaId: `media-${id}`,
		...(linkId ? { linkId } : {}),
		params: {},
	} as unknown as AudioElement;
}

/** Three butted main clips with separated audio, an overlay title, and an
 * unlinked music bed: the layout the magnet spec is written against. */
function buildProject(): SceneTracks {
	const main: VideoTrack = {
		id: "main",
		type: "video",
		name: "V1",
		muted: false,
		hidden: false,
		elements: [
			vid({ id: "a", startTime: 0, duration: 10 * FRAME, linkId: "l-a" }),
			vid({ id: "b", startTime: 10 * FRAME, duration: 10 * FRAME, linkId: "l-b" }),
			vid({ id: "c", startTime: 20 * FRAME, duration: 10 * FRAME, linkId: "l-c" }),
		],
	};
	const overlay: VideoTrack = {
		id: "overlay-0",
		type: "video",
		name: "V2",
		muted: false,
		hidden: false,
		elements: [vid({ id: "title", startTime: 25 * FRAME, duration: 5 * FRAME })],
	};
	const voice = {
		id: "audio-0",
		type: "audio",
		name: "A1",
		muted: false,
		elements: [
			aud({ id: "a-au", startTime: 0, duration: 10 * FRAME, linkId: "l-a" }),
			aud({ id: "b-au", startTime: 10 * FRAME, duration: 10 * FRAME, linkId: "l-b" }),
			aud({ id: "c-au", startTime: 20 * FRAME, duration: 10 * FRAME, linkId: "l-c" }),
		],
	} as unknown as AudioTrack;
	const music = {
		id: "audio-1",
		type: "audio",
		name: "A2",
		muted: false,
		elements: [aud({ id: "bed", startTime: 0, duration: 40 * FRAME })],
	} as unknown as AudioTrack;
	return { overlay: [overlay], main, audio: [voice, music] };
}

/** Every element's start time, keyed `track:element`, for whole-timeline asserts. */
function startTimes(tracks: SceneTracks): Record<string, number> {
	const result: Record<string, number> = {};
	for (const track of [...tracks.overlay, tracks.main, ...tracks.audio]) {
		for (const element of track.elements) {
			result[`${track.id}:${element.id}`] = element.startTime as number;
		}
	}
	return result;
}

/** Deletes the middle main clip and its linked audio half, the way a plain
 * Delete on a linked selection does. */
class DeleteMiddleCommand extends Command {
	private saved: SceneTracks | null = null;

	execute(): CommandResult | undefined {
		this.saved = currentTracks;
		currentTracks = {
			...currentTracks,
			main: {
				...currentTracks.main,
				elements: currentTracks.main.elements.filter((el) => el.id !== "b"),
			},
			audio: currentTracks.audio.map((track) => ({
				...track,
				elements: track.elements.filter((el) => el.id !== "b-au"),
			})),
		};
		return undefined;
	}

	undo(): void {
		if (this.saved) currentTracks = this.saved;
	}
}

function newManager(): CommandManager {
	const stubEditor = {
		scenes: { getActiveSceneOrNull: () => ({ tracks: currentTracks }) },
		timeline: {
			updateTracks: (tracks: SceneTracks) => {
				currentTracks = tracks;
			},
		},
		selection: {
			getSnapshot: () => ({
				selectedElements: [],
				selectedKeyframes: [],
				keyframeSelectionAnchor: null,
				selectedMaskPoints: null,
			}),
			applySelectionPatch: () => ({
				selectedElements: [],
				selectedKeyframes: [],
				keyframeSelectionAnchor: null,
				selectedMaskPoints: null,
			}),
			restoreSnapshot: () => {},
		},
	} as unknown as EditorCore;
	return new CommandManager(stubEditor);
}

describe("magnetic main track: gap close after a command", () => {
	beforeEach(() => {
		currentTracks = buildProject();
	});

	test("magnet OFF is exactly today's behavior: the gap stays open", () => {
		const manager = newManager();
		manager.execute({ command: new DeleteMiddleCommand() });

		expect(startTimes(currentTracks)).toEqual({
			"overlay-0:title": 25 * FRAME,
			"main:a": 0,
			"main:c": 20 * FRAME,
			"audio-0:a-au": 0,
			"audio-0:c-au": 20 * FRAME,
			"audio-1:bed": 0,
		});
	});

	test("magnet ON closes the gap on main and drags the linked audio with it; overlay and the music bed never move", () => {
		const manager = newManager();
		manager.isMagnetEnabled = true;
		manager.execute({ command: new DeleteMiddleCommand() });

		expect(startTimes(currentTracks)).toEqual({
			"overlay-0:title": 25 * FRAME,
			"main:a": 0,
			"main:c": 10 * FRAME,
			"audio-0:a-au": 0,
			"audio-0:c-au": 10 * FRAME,
			"audio-1:bed": 0,
		});
	});

	test("one undo reverts the delete AND the magnet shift; redo puts both back", () => {
		const before = startTimes(currentTracks);
		const manager = newManager();
		manager.isMagnetEnabled = true;
		manager.execute({ command: new DeleteMiddleCommand() });
		const afterExecute = startTimes(currentTracks);

		manager.undo();
		expect(startTimes(currentTracks)).toEqual(before);

		manager.redo();
		expect(startTimes(currentTracks)).toEqual(afterExecute);
	});

	test("ripple editing takes precedence: both toggles on lands exactly where ripple alone lands", () => {
		const rippleOnly = newManager();
		rippleOnly.isRippleEnabled = true;
		rippleOnly.execute({ command: new DeleteMiddleCommand() });
		const rippleResult = startTimes(currentTracks);

		currentTracks = buildProject();
		const both = newManager();
		both.isRippleEnabled = true;
		both.isMagnetEnabled = true;
		both.execute({ command: new DeleteMiddleCommand() });

		expect(startTimes(currentTracks)).toEqual(rippleResult);
	});

	test("suppressRipple opts the magnet out too (a command that carries its own shifts)", () => {
		const manager = newManager();
		manager.isMagnetEnabled = true;
		manager.execute({
			command: new DeleteMiddleCommand(),
			suppressRipple: true,
		});

		expect(startTimes(currentTracks)["main:c"]).toBe(20 * FRAME);
	});

	test("the caller's own command stays the top of the undo stack (peek identity survives)", () => {
		const manager = newManager();
		manager.isMagnetEnabled = true;
		const command = new DeleteMiddleCommand();
		manager.execute({ command });

		expect(manager.peekUndoCommand()).toBe(command);
	});
});
