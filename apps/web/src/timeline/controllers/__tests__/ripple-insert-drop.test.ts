import { describe, expect, test } from "bun:test";
import {
	DragDropController,
	type DragDropConfig,
} from "@/timeline/controllers/drag-drop-controller";
import {
	InsertElementCommand,
	UpdateElementsCommand,
	AddTrackCommand,
} from "@/commands/timeline";
import { BatchCommand } from "@/commands";
import type { Command } from "@/commands/base-command";
import type {
	AudioTrack,
	SceneTracks,
	VideoElement,
	VideoTrack,
	AudioElement,
} from "@/timeline";
import type { MediaAsset } from "@/media/types";
import { mediaTime, ZERO_MEDIA_TIME } from "@/wasm";

const TPS = 120_000; // ticks per second (matches @/wasm mock)

function videoClip({
	id,
	startTime,
	duration,
}: {
	id: string;
	startTime: number;
	duration: number;
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

function audioClip({
	id,
	startTime,
	duration,
}: {
	id: string;
	startTime: number;
	duration: number;
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
		params: { volume: 1, muted: false },
	};
}

function asset(overrides: Partial<MediaAsset> & { id: string }): MediaAsset {
	return {
		id: overrides.id,
		name: overrides.id,
		type: "video",
		duration: 1, // 1s => 120_000 ticks
		hasAudio: false,
		...overrides,
	} as MediaAsset;
}

function makeController({
	tracks,
	assets,
}: {
	tracks: SceneTracks;
	assets: MediaAsset[];
}): { controller: DragDropController; executed: Command[] } {
	const executed: Command[] = [];
	const config = {
		zoomLevel: 1,
		getContainerEl: () => null,
		getHeaderEl: () => null,
		getTracksScrollEl: () => null,
		getActiveProjectFps: () => ({ numerator: 30, denominator: 1 }),
		getActiveProjectId: () => "p",
		getSceneTracks: () => tracks,
		getCurrentPlayheadTime: () => ZERO_MEDIA_TIME,
		getMediaAssets: () => assets,
		dragSource: {
			isActive: () => true,
			getActive: () => null,
			begin: () => {},
			end: () => {},
		},
		addMediaAsset: async () => null,
		executeCommand: (command: Command) => executed.push(command),
		insertElement: () => {},
		addClipEffect: () => {},
	} as unknown as DragDropConfig;
	const configRef = { current: config };
	return {
		controller: new DragDropController({ configRef }),
		executed,
	};
}

function batchCommands(command: Command): Command[] {
	expect(command).toBeInstanceOf(BatchCommand);
	// commands is a private field; read it for the shape assertion.
	return (command as unknown as { commands: Command[] }).commands;
}

describe("drag-to-insert (U5) BatchCommand shape", () => {
	test("insert on an occupied video lane emits [UpdateElements, InsertElement], no delete", () => {
		const track: VideoTrack = {
			id: "video-main",
			type: "video",
			name: "video-main",
			muted: false,
			hidden: false,
			elements: [
				videoClip({ id: "a", startTime: 0, duration: TPS }),
				videoClip({ id: "b", startTime: TPS, duration: TPS }),
			],
		};
		const tracks: SceneTracks = { overlay: [], main: track, audio: [] };
		const { controller, executed } = makeController({
			tracks,
			assets: [asset({ id: "new", duration: 1 })],
		});

		// Drop the new clip over clip 'b' (insert at b's start = TPS).
		(
			controller as unknown as {
				executeMediaRippleInsert: (args: {
					dragData: { type: "media"; id: string; mediaType: string; name: string };
					targetTrackId: string;
					dropX: number;
				}) => void;
			}
		).executeMediaRippleInsert({
			dragData: { type: "media", id: "new", mediaType: "video", name: "new" },
			targetTrackId: "video-main",
			dropX: mediaTime({ ticks: TPS }),
		});

		expect(executed).toHaveLength(1);
		const cmds = batchCommands(executed[0]);
		expect(cmds).toHaveLength(2);
		expect(cmds[0]).toBeInstanceOf(UpdateElementsCommand);
		expect(cmds[1]).toBeInstanceOf(InsertElementCommand);
		// downstream clip 'b' (start TPS) shifts right by the insert duration (TPS).
		const shift = cmds[0] as unknown as {
			updates: Array<{ elementId: string; patch: { startTime: number } }>;
		};
		expect(shift.updates).toEqual([
			{ trackId: "video-main", elementId: "b", patch: { startTime: 2 * TPS } },
		]);
	});

	test("insert at the end of a lane emits only InsertElement (no shift)", () => {
		const track: VideoTrack = {
			id: "video-main",
			type: "video",
			name: "video-main",
			muted: false,
			hidden: false,
			elements: [videoClip({ id: "a", startTime: 0, duration: TPS })],
		};
		const tracks: SceneTracks = { overlay: [], main: track, audio: [] };
		const { controller, executed } = makeController({
			tracks,
			assets: [asset({ id: "new", duration: 1 })],
		});

		(
			controller as unknown as {
				executeMediaRippleInsert: (args: {
					dragData: { type: "media"; id: string; mediaType: string; name: string };
					targetTrackId: string;
					dropX: number;
				}) => void;
			}
		).executeMediaRippleInsert({
			dragData: { type: "media", id: "new", mediaType: "video", name: "new" },
			targetTrackId: "video-main",
			dropX: mediaTime({ ticks: 2 * TPS }), // past the only clip
		});

		const cmds = batchCommands(executed[0]);
		expect(cmds).toHaveLength(1);
		expect(cmds[0]).toBeInstanceOf(InsertElementCommand);
	});

	test("audio insert on an occupied lane ripples that lane, no AddTrack", () => {
		const audioTrack: AudioTrack = {
			id: "audio-1",
			type: "audio",
			name: "audio-1",
			muted: false,
			elements: [
				audioClip({ id: "x", startTime: 0, duration: TPS }),
				audioClip({ id: "y", startTime: TPS, duration: TPS }),
			],
		};
		const tracks: SceneTracks = {
			overlay: [],
			main: {
				id: "video-main",
				type: "video",
				name: "video-main",
				muted: false,
				hidden: false,
				elements: [],
			},
			audio: [audioTrack],
		};
		const { controller, executed } = makeController({
			tracks,
			assets: [asset({ id: "na", type: "audio", duration: 1 })],
		});

		(
			controller as unknown as {
				executeMediaRippleInsert: (args: {
					dragData: { type: "media"; id: string; mediaType: string; name: string };
					targetTrackId: string;
					dropX: number;
				}) => void;
			}
		).executeMediaRippleInsert({
			dragData: { type: "media", id: "na", mediaType: "audio", name: "na" },
			targetTrackId: "audio-1",
			dropX: mediaTime({ ticks: TPS }),
		});

		const cmds = batchCommands(executed[0]);
		expect(cmds.some((c) => c instanceof AddTrackCommand)).toBe(false);
		expect(cmds).toHaveLength(2);
		expect(cmds[0]).toBeInstanceOf(UpdateElementsCommand);
		expect(cmds[1]).toBeInstanceOf(InsertElementCommand);
	});

	test("linked A/V insert ripples both lanes and inserts both, one batch", () => {
		const videoTrack: VideoTrack = {
			id: "video-main",
			type: "video",
			name: "video-main",
			muted: false,
			hidden: false,
			elements: [
				videoClip({ id: "v1", startTime: 0, duration: TPS }),
				videoClip({ id: "v2", startTime: TPS, duration: TPS }),
			],
		};
		const audioTrack: AudioTrack = {
			id: "audio-1",
			type: "audio",
			name: "audio-1",
			muted: false,
			elements: [audioClip({ id: "a2", startTime: TPS, duration: TPS })],
		};
		const tracks: SceneTracks = {
			overlay: [],
			main: videoTrack,
			audio: [audioTrack],
		};
		const { controller, executed } = makeController({
			tracks,
			assets: [asset({ id: "av", type: "video", duration: 1, hasAudio: true })],
		});

		(
			controller as unknown as {
				executeMediaRippleInsert: (args: {
					dragData: { type: "media"; id: string; mediaType: string; name: string };
					targetTrackId: string;
					dropX: number;
				}) => void;
			}
		).executeMediaRippleInsert({
			dragData: { type: "media", id: "av", mediaType: "video", name: "av" },
			targetTrackId: "video-main",
			dropX: mediaTime({ ticks: TPS }),
		});

		expect(executed).toHaveLength(1);
		const cmds = batchCommands(executed[0]);
		// [video-lane shift, video insert, audio-lane shift, audio insert]
		const inserts = cmds.filter((c) => c instanceof InsertElementCommand);
		const updates = cmds.filter((c) => c instanceof UpdateElementsCommand);
		expect(inserts).toHaveLength(2);
		expect(updates).toHaveLength(2);
		expect(cmds.some((c) => c instanceof AddTrackCommand)).toBe(false);
	});
});

describe("findOccupiedLaneForInsert", () => {
	function ctrl() {
		const audioTrack: AudioTrack = {
			id: "audio-1",
			type: "audio",
			name: "audio-1",
			muted: false,
			elements: [audioClip({ id: "x", startTime: 0, duration: TPS })],
		};
		const tracks: SceneTracks = {
			overlay: [],
			main: {
				id: "video-main",
				type: "video",
				name: "video-main",
				muted: false,
				hidden: false,
				elements: [],
			},
			audio: [audioTrack],
		};
		return makeController({ tracks, assets: [] }).controller;
	}

	test("returns the audio lane id when a clip occupies the drop point", () => {
		const found = (
			ctrl() as unknown as {
				findOccupiedLaneForInsert: (args: {
					mediaType: string;
					dropX: number;
					coords: { mouseX: number; mouseY: number } | null;
				}) => string | null;
			}
		).findOccupiedLaneForInsert({
			mediaType: "audio",
			dropX: mediaTime({ ticks: TPS / 2 }),
			coords: { mouseX: 0, mouseY: 0 },
		});
		expect(found).toBe("audio-1");
	});

	test("returns null when the lane is empty at the drop point", () => {
		const found = (
			ctrl() as unknown as {
				findOccupiedLaneForInsert: (args: {
					mediaType: string;
					dropX: number;
					coords: { mouseX: number; mouseY: number } | null;
				}) => string | null;
			}
		).findOccupiedLaneForInsert({
			mediaType: "audio",
			dropX: mediaTime({ ticks: 5 * TPS }),
			coords: { mouseX: 0, mouseY: 0 },
		});
		expect(found).toBeNull();
	});
});
