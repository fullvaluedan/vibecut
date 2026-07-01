import { describe, expect, test } from "bun:test";
import {
	DragDropController,
	type DragDropConfig,
} from "@/timeline/controllers/drag-drop-controller";
import {
	InsertElementCommand,
	UpdateElementsCommand,
	AddTrackCommand,
	DeleteElementsCommand,
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
import type { ElementAnimations } from "@/animation/types";
import { mediaTime, ZERO_MEDIA_TIME } from "@/wasm";

const TPS = 120_000; // ticks per second (matches @/wasm mock)

/** A minimal two-key volume fade (1 -> 0) over `duration` ticks. */
function volumeFade({ duration }: { duration: number }): ElementAnimations {
	return {
		volume: {
			keys: [
				{
					id: "vk-0",
					time: ZERO_MEDIA_TIME,
					value: 1,
					segmentToNext: "linear",
					tangentMode: "flat",
				},
				{
					id: "vk-1",
					time: mediaTime({ ticks: duration }),
					value: 0,
					segmentToNext: "linear",
					tangentMode: "flat",
				},
			],
		},
	};
}

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
	trimStart = 0,
	trimEnd = 0,
	sourceDuration,
	retime,
	linkId,
	animations,
}: {
	id: string;
	startTime: number;
	duration: number;
	trimStart?: number;
	trimEnd?: number;
	sourceDuration?: number;
	retime?: { rate: number; maintainPitch?: boolean };
	linkId?: string;
	animations?: ElementAnimations;
}): AudioElement {
	return {
		id,
		type: "audio",
		name: id,
		startTime: mediaTime({ ticks: startTime }),
		duration: mediaTime({ ticks: duration }),
		trimStart: mediaTime({ ticks: trimStart }),
		trimEnd: mediaTime({ ticks: trimEnd }),
		...(sourceDuration !== undefined
			? { sourceDuration: mediaTime({ ticks: sourceDuration }) }
			: {}),
		...(retime ? { retime } : {}),
		...(linkId ? { linkId } : {}),
		...(animations ? { animations } : {}),
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

	test("(F2) multi-select insert onto an occupied clip lands ALL assets, lane ripples by the SUMMED duration, one undo", () => {
		// Lane: clip 'a' [0, TPS], clip 'b' [TPS, 2*TPS]. Drop a 3-asset selection
		// (each 1s) onto 'b' (insertStart = TPS). The pre-fix ripple path inserted
		// only dragData.id (m1) and rippled by TPS — the other two were silently
		// lost. Now: 'b' ripples right by the SUMMED 3*TPS and m1/m2/m3 land
		// back-to-back at TPS / 2*TPS / 3*TPS. One BatchCommand => one undo.
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
			assets: [
				asset({ id: "m1", type: "video", duration: 1 }),
				asset({ id: "m2", type: "video", duration: 1 }),
				asset({ id: "m3", type: "video", duration: 1 }),
			],
		});

		(
			controller as unknown as {
				executeMediaRippleInsert: (args: {
					dragData: {
						type: "media";
						id: string;
						mediaType: string;
						name: string;
						mediaIds: string[];
					};
					targetTrackId: string;
					dropX: number;
				}) => void;
			}
		).executeMediaRippleInsert({
			dragData: {
				type: "media",
				id: "m1",
				mediaType: "video",
				name: "m1",
				mediaIds: ["m1", "m2", "m3"],
			},
			targetTrackId: "video-main",
			dropX: mediaTime({ ticks: TPS }),
		});

		// ONE executed command => single Ctrl+Z undoes the whole multi-drop.
		expect(executed).toHaveLength(1);
		const cmds = batchCommands(executed[0]);

		// The lane rippled ONCE by the summed duration: 'b' (start TPS) shifts to
		// TPS + 3*TPS = 4*TPS.
		const shifts = cmds.filter(
			(c) => c instanceof UpdateElementsCommand,
		) as unknown as Array<{
			updates: Array<{
				trackId: string;
				elementId: string;
				patch: { startTime?: number };
			}>;
		}>;
		const bShift = shifts
			.flatMap((c) => c.updates)
			.find((u) => u.elementId === "b");
		expect(bShift?.patch.startTime).toBe(4 * TPS);

		// All three selected assets land, back-to-back at TPS / 2*TPS / 3*TPS.
		const inserted = cmds
			.filter((c) => c instanceof InsertElementCommand)
			.map(
				(c) =>
					(c as unknown as {
						element: { mediaId: string; startTime: number };
						placement: { trackId: string };
					}),
			);
		const byMedia = new Map(
			inserted.map((c) => [c.element.mediaId, c.element.startTime]),
		);
		expect(byMedia.get("m1")).toBe(TPS);
		expect(byMedia.get("m2")).toBe(2 * TPS);
		expect(byMedia.get("m3")).toBe(3 * TPS);
		// Everything lands on the target lane (nothing diverted / lost).
		for (const c of inserted) {
			expect(c.placement.trackId).toBe("video-main");
		}
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

	test("insert onto the earliest main clip (start != 0) lands at that start, not 0", () => {
		// Main clip starts at TPS (a leading gap). Dropping on it anchors insertStart
		// = TPS and ripples the clip right. The inserted clip must land at TPS: it
		// carries skipMainTrackStart so the main-track snap-to-0 rule doesn't slide
		// it to 0 (which would also desync it from its linked audio).
		const track: VideoTrack = {
			id: "video-main",
			type: "video",
			name: "video-main",
			muted: false,
			hidden: false,
			elements: [videoClip({ id: "a", startTime: TPS, duration: TPS })],
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
			dropX: mediaTime({ ticks: TPS }),
		});

		const cmds = batchCommands(executed[0]);
		const insert = cmds.find(
			(c) => c instanceof InsertElementCommand,
		) as unknown as {
			element: { startTime: number };
			placement: { mode: string; trackId: string; skipMainTrackStart?: boolean };
		};
		expect(insert.element.startTime).toBe(TPS);
		expect(insert.placement.skipMainTrackStart).toBe(true);
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

	test("separated audio splits a straddling audio clip so nothing overlaps", () => {
		// Video boundary (insertStart) = TPS (v2's start). The audio lane holds a
		// single clip that STARTS before TPS and EXTENDS past it — a straddler that
		// computeRippleInsertShifts would leave in place, so the separated audio
		// would land on top of it. The fix splits the straddler at TPS.
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
			// [TPS/2, TPS/2 + 2*TPS] straddles insertStart = TPS.
			elements: [audioClip({ id: "straddle", startTime: TPS / 2, duration: 2 * TPS })],
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

		// Reconstruct the audio lane after the batch: apply head-shrink updates and
		// tail/audio inserts, so we can assert the final layout has no overlap.
		type Span = { id: string; start: number; end: number; linkId?: string };
		const spans: Span[] = audioTrack.elements.map((el) => ({
			id: el.id,
			start: el.startTime,
			end: el.startTime + el.duration,
			linkId: (el as { linkId?: string }).linkId,
		}));
		for (const cmd of cmds) {
			if (cmd instanceof UpdateElementsCommand) {
				const { updates } = cmd as unknown as {
					updates: Array<{
						trackId: string;
						elementId: string;
						patch: { startTime?: number; duration?: number };
					}>;
				};
				for (const u of updates) {
					if (u.trackId !== "audio-1") continue;
					const span = spans.find((s) => s.id === u.elementId);
					if (!span) continue;
					if (u.patch.startTime !== undefined) {
						const width = span.end - span.start;
						span.start = u.patch.startTime;
						span.end = span.start + width;
					}
					if (u.patch.duration !== undefined) {
						span.end = span.start + u.patch.duration;
					}
				}
			}
			if (cmd instanceof InsertElementCommand) {
				const el = (cmd as unknown as { element: {
					type: string;
					startTime: number;
					duration: number;
					linkId?: string;
					mediaId?: string;
				} }).element;
				if (el.type !== "audio") continue;
				// Two audio inserts land here: the split TAIL of the straddler (keeps
				// the straddler's media) and the separated PAIR audio (carries the
				// video's fresh linkId). Tag them apart.
				spans.push({
					id: el.mediaId === "media-straddle" ? "tail" : "inserted",
					start: el.startTime,
					end: el.startTime + el.duration,
					linkId: el.linkId,
				});
			}
		}

		// No two audio spans overlap.
		const sorted = [...spans].sort((a, b) => a.start - b.start);
		for (let i = 1; i < sorted.length; i++) {
			expect(sorted[i].start).toBeGreaterThanOrEqual(sorted[i - 1].end);
		}

		// The inserted separated audio starts at the video boundary (insertStart)
		// and is linked to the inserted video.
		const insertedAudio = spans.find((s) => s.id === "inserted");
		expect(insertedAudio?.start).toBe(TPS);
		const videoInsert = cmds.find(
			(c) =>
				c instanceof InsertElementCommand &&
				(c as unknown as { element: { type: string } }).element.type === "video",
		) as unknown as { element: { linkId?: string; startTime: number } };
		expect(insertedAudio?.linkId).toBeDefined();
		expect(insertedAudio?.linkId).toBe(videoInsert.element.linkId);
		expect(videoInsert.element.startTime).toBe(TPS);
	});
});

describe("straddle split is source-aligned (S1-S3)", () => {
	// Shared driver: an A/V asset dropped over v2 (insertStart = TPS) forces the
	// separated audio to split the single straddling audio clip on `audio-1`.
	function runWithStraddler(straddler: AudioElement): {
		headPatch:
			| { startTime?: number; duration?: number; trimEnd?: number; animations?: unknown }
			| undefined;
		tail:
			| {
					type: string;
					startTime: number;
					duration: number;
					trimStart: number;
					trimEnd: number;
					mediaId?: string;
					linkId?: string;
					retime?: { rate: number };
					animations?: ElementAnimations;
				}
			| undefined;
		videoLinkId: string | undefined;
	} {
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
			elements: [straddler],
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

		const cmds = batchCommands(executed[0]);
		// Head-shrink patch: the UpdateElementsCommand that touches the straddler id.
		let headPatch:
			| { startTime?: number; duration?: number; trimEnd?: number; animations?: unknown }
			| undefined;
		for (const cmd of cmds) {
			if (!(cmd instanceof UpdateElementsCommand)) continue;
			const { updates } = cmd as unknown as {
				updates: Array<{
					elementId: string;
					patch: {
						startTime?: number;
						duration?: number;
						trimEnd?: number;
						animations?: unknown;
					};
				}>;
			};
			const found = updates.find((u) => u.elementId === straddler.id);
			if (found) headPatch = found.patch;
		}
		// Tail insert: the audio insert carrying the straddler's media.
		const inserts = cmds.filter((c) => c instanceof InsertElementCommand);
		const tail = inserts
			.map(
				(c) =>
					(c as unknown as {
						element: {
							type: string;
							startTime: number;
							duration: number;
							trimStart: number;
							trimEnd: number;
							mediaId?: string;
							linkId?: string;
							retime?: { rate: number };
							animations?: ElementAnimations;
						};
					}).element,
			)
			.find(
				(el) =>
					el.type === "audio" && el.mediaId === `media-${straddler.id}`,
			);
		const videoInsert = inserts
			.map(
				(c) =>
					(c as unknown as { element: { type: string; linkId?: string } }).element,
			)
			.find((el) => el.type === "video");
		return { headPatch, tail, videoLinkId: videoInsert?.linkId };
	}

	test("head trimEnd + tail trimStart absorb the WHOLE source span (rate 1)", () => {
		// Straddler [TPS/2, TPS/2 + 2*TPS], trims 0. insertStart = TPS => head
		// visible = TPS/2, tail visible = 3*TPS/2. At rate 1, source spans equal
		// visible: head consumes TPS/2, so tail.trimStart advances by TPS/2 and
		// head.trimEnd grows by the TAIL span 3*TPS/2 (source-aligned invariant).
		const { headPatch, tail } = runWithStraddler(
			audioClip({ id: "straddle", startTime: TPS / 2, duration: 2 * TPS }),
		);
		expect(headPatch).toBeDefined();
		expect(tail).toBeDefined();
		const headVisible = TPS / 2;
		const tailVisible = (3 * TPS) / 2;
		expect(headPatch?.duration).toBe(headVisible);
		expect(tail?.duration).toBe(tailVisible);
		// rate 1: source span == visible span. tail.trimStart advances by the HEAD
		// span; head.trimEnd grows by the TAIL span (the source cut off after the
		// split) — the pre-fix bug added the HEAD span to head.trimEnd instead.
		expect(tail?.trimStart).toBe(headVisible); // element.trimStart(0) + headSpan
		expect(headPatch?.trimEnd).toBe(tailVisible); // element.trimEnd(0) + tailSpan
		// Conservation: head span (=tail.trimStart) + tail span (=head.trimEnd) tile
		// the whole source with no gap/overlap. At rate 1 that is the full visible
		// duration (2*TPS), since trims started at 0.
		expect((tail?.trimStart ?? 0) + (headPatch?.trimEnd ?? 0)).toBe(2 * TPS);
	});

	test("retimed straddler (rate 2) splits the SOURCE span, not the visible span", () => {
		// rate 2 => 1 visible tick consumes 2 source ticks. Straddler [TPS/2, +2*TPS]
		// rate 2. head visible = TPS/2 => head source span = TPS. tail source span =
		// (2*TPS)*2 - TPS = 3*TPS. So tail.trimStart = 0 + TPS, head.trimEnd = 0 +
		// 3*TPS. This is the getSourceSpanAtClipTime path the bespoke code skipped.
		const { headPatch, tail } = runWithStraddler(
			audioClip({
				id: "straddle",
				startTime: TPS / 2,
				duration: 2 * TPS,
				sourceDuration: 4 * TPS,
				retime: { rate: 2 },
			}),
		);
		expect(tail?.retime?.rate).toBe(2);
		expect(tail?.trimStart).toBe(TPS); // head source span
		expect(headPatch?.trimEnd).toBe(3 * TPS); // tail source span
		// head source span + tail source span == total source span (2*TPS visible *
		// rate 2 = 4*TPS).
		expect((tail?.trimStart ?? 0) + (headPatch?.trimEnd ?? 0)).toBe(4 * TPS);
	});

	test("linked straddler gives the tail a FRESH linkId (no false A/V gang)", () => {
		// The straddler carries a linkId (it is itself linked to some video). The
		// split tail must NOT inherit it — else two audio clips would claim the same
		// gang as one unsplit video and corrupt linked selection / A/V sync.
		const { tail, videoLinkId } = runWithStraddler(
			audioClip({
				id: "straddle",
				startTime: TPS / 2,
				duration: 2 * TPS,
				linkId: "orig-link",
			}),
		);
		expect(tail?.linkId).toBeDefined();
		expect(tail?.linkId).not.toBe("orig-link"); // fresh, not the straddler's
		expect(tail?.linkId).not.toBe(videoLinkId); // not the inserted video's gang
	});

	test("volume fade is partitioned: head keeps left, tail keeps right", () => {
		// A 2*TPS-long fade (1 -> 0) on the straddler. Split at head visible = TPS/2.
		// splitAnimationsAtTime must give the head the [0, TPS/2] keys and the tail
		// the [TPS/2, 2*TPS] keys (re-based to 0), each with a boundary key.
		const { headPatch, tail } = runWithStraddler(
			audioClip({
				id: "straddle",
				startTime: TPS / 2,
				duration: 2 * TPS,
				animations: volumeFade({ duration: 2 * TPS }),
			}),
		);
		const headAnim = headPatch?.animations as ElementAnimations | undefined;
		const tailAnim = tail?.animations as ElementAnimations | undefined;
		expect(headAnim?.volume).toBeDefined();
		expect(tailAnim?.volume).toBeDefined();
		const headKeys = (headAnim?.volume as { keys: Array<{ time: number }> }).keys;
		const tailKeys = (tailAnim?.volume as { keys: Array<{ time: number }> }).keys;
		// Head keys live in [0, headVisible]; tail keys are re-based to start at 0.
		expect(Math.max(...headKeys.map((k) => k.time))).toBe(TPS / 2);
		expect(Math.min(...tailKeys.map((k) => k.time))).toBe(0);
		// Nothing shifted past the tail's own length.
		expect(Math.max(...tailKeys.map((k) => k.time))).toBe((3 * TPS) / 2);
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

	// Ordered tracks = [video-main (65px), audio-1 (50px)] with a 6px gap, so the
	// audio lane spans y=[71,121). mouseY must land there to hover it.
	const AUDIO_LANE_Y = 90;

	test("returns the hovered audio lane id when a clip occupies the drop point", () => {
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
			coords: { mouseX: 0, mouseY: AUDIO_LANE_Y },
		});
		expect(found).toBe("audio-1");
	});

	test("returns null when the hovered lane is empty at the drop point", () => {
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
			coords: { mouseX: 0, mouseY: AUDIO_LANE_Y },
		});
		expect(found).toBeNull();
	});

	test("returns null when the cursor is over a DIFFERENT audio lane than the occupied one", () => {
		// Two audio lanes: lane 1 has a clip at the drop point, lane 2 is empty. A
		// drop hovering lane 2 must NOT ripple lane 1 (the pre-fix bug: it took the
		// first occupied compatible lane regardless of mouseY).
		const audio1: AudioTrack = {
			id: "audio-1",
			type: "audio",
			name: "audio-1",
			muted: false,
			elements: [audioClip({ id: "x", startTime: 0, duration: TPS })],
		};
		const audio2: AudioTrack = {
			id: "audio-2",
			type: "audio",
			name: "audio-2",
			muted: false,
			elements: [],
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
			audio: [audio1, audio2],
		};
		const controller = makeController({ tracks, assets: [] }).controller;
		// Ordered = [video(65), audio-1(50), audio-2(50)] with 6px gaps.
		// audio-1: [71,121), audio-2: [127,177). Hover audio-2 (empty) at y=150.
		const found = (
			controller as unknown as {
				findOccupiedLaneForInsert: (args: {
					mediaType: string;
					dropX: number;
					coords: { mouseX: number; mouseY: number } | null;
				}) => string | null;
			}
		).findOccupiedLaneForInsert({
			mediaType: "audio",
			dropX: mediaTime({ ticks: TPS / 2 }),
			coords: { mouseX: 0, mouseY: 150 },
		});
		expect(found).toBeNull();
	});

	test("returns the hovered lane id (not lane 1) when it is the occupied one", () => {
		// Mirror image: lane 2 holds the clip, and the cursor hovers lane 2 — the
		// drop must ripple lane 2, not fall through to lane 1.
		const audio1: AudioTrack = {
			id: "audio-1",
			type: "audio",
			name: "audio-1",
			muted: false,
			elements: [],
		};
		const audio2: AudioTrack = {
			id: "audio-2",
			type: "audio",
			name: "audio-2",
			muted: false,
			elements: [audioClip({ id: "y", startTime: 0, duration: TPS })],
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
			audio: [audio1, audio2],
		};
		const controller = makeController({ tracks, assets: [] }).controller;
		// audio-2 spans [127,177); hover it at y=150.
		const found = (
			controller as unknown as {
				findOccupiedLaneForInsert: (args: {
					mediaType: string;
					dropX: number;
					coords: { mouseX: number; mouseY: number } | null;
				}) => string | null;
			}
		).findOccupiedLaneForInsert({
			mediaType: "audio",
			dropX: mediaTime({ ticks: TPS / 2 }),
			coords: { mouseX: 0, mouseY: 150 },
		});
		expect(found).toBe("audio-2");
	});
});

describe("authored / HyperFrames clip guard (never ripple/overwrite)", () => {
	function authoredVideoClip({
		id,
		startTime,
		duration,
	}: {
		id: string;
		startTime: number;
		duration: number;
	}): VideoElement {
		return {
			...videoClip({ id, startTime, duration }),
			framecutAi: {
				compId: "comp-1",
				templateId: "hyperframes:overlay",
				variables: {},
				groupId: "group-1",
			},
		};
	}

	function makeAuthoredScene() {
		// An authored HyperFrames render (video + framecutAi) on an overlay lane,
		// plus an empty main track. A media drop hit-tests the overlay video clip.
		const overlay: VideoTrack = {
			id: "overlay-authored",
			type: "video",
			name: "overlay-authored",
			muted: false,
			hidden: false,
			elements: [authoredVideoClip({ id: "hf", startTime: 0, duration: TPS })],
		};
		const tracks: SceneTracks = {
			overlay: [overlay],
			main: {
				id: "video-main",
				type: "video",
				name: "video-main",
				muted: false,
				hidden: false,
				elements: [],
			},
			audio: [],
		};
		return makeController({
			tracks,
			assets: [asset({ id: "dropped", type: "video", duration: 1 })],
		});
	}

	function drop(
		controller: DragDropController,
		mode: "insert" | "overwrite",
	): void {
		const target = {
			trackIndex: 0,
			isNewTrack: false,
			insertPosition: null,
			xPosition: mediaTime({ ticks: TPS / 2 }),
			targetElement: { trackId: "overlay-authored", elementId: "hf" },
		};
		(
			controller as unknown as {
				executeMediaDrop: (args: {
					target: typeof target;
					dragData: { type: "media"; id: string; mediaType: string; name: string };
					coords: { mouseX: number; mouseY: number } | null;
					mode: "insert" | "overwrite";
				}) => void;
			}
		).executeMediaDrop({
			target,
			dragData: {
				type: "media",
				id: "dropped",
				mediaType: "video",
				name: "dropped",
			},
			coords: { mouseX: 0, mouseY: 0 },
			mode,
		});
	}

	test("INSERT onto an authored clip diverts to a new track (no ripple of the authored clip)", () => {
		const { controller, executed } = makeAuthoredScene();
		drop(controller, "insert");

		expect(executed).toHaveLength(1);
		const cmds = batchCommands(executed[0]);
		// Diverted: a fresh track is added + the media inserted onto it. No
		// UpdateElementsCommand (which is how a ripple would shift the authored clip).
		expect(cmds.some((c) => c instanceof AddTrackCommand)).toBe(true);
		expect(cmds.some((c) => c instanceof InsertElementCommand)).toBe(true);
		expect(cmds.some((c) => c instanceof UpdateElementsCommand)).toBe(false);
		// The insert targets the NEW track, never the authored overlay lane.
		const insert = cmds.find(
			(c) => c instanceof InsertElementCommand,
		) as unknown as { placement: { trackId: string } };
		expect(insert.placement.trackId).not.toBe("overlay-authored");
	});

	test("OVERWRITE onto an authored clip also diverts (never clears the authored clip)", () => {
		const { controller, executed } = makeAuthoredScene();
		drop(controller, "overwrite");

		expect(executed).toHaveLength(1);
		const cmds = batchCommands(executed[0]);
		// No DeleteElementsCommand => the authored clip is never cleared. It diverts
		// to a new track exactly like the insert case.
		expect(cmds.some((c) => c instanceof AddTrackCommand)).toBe(true);
		const insert = cmds.find(
			(c) => c instanceof InsertElementCommand,
		) as unknown as { placement: { trackId: string } };
		expect(insert.placement.trackId).not.toBe("overlay-authored");
	});

	test("(G1/G2) audio INSERT drop onto an authored render's separated-audio lane does NOT ripple it", () => {
		// An authored HyperFrames video (framecutAi) with its source audio separated
		// onto `audio-hf`: the audio clip carries the video's linkId but NOT
		// framecutAi (video-only). A bare framecutAi check would miss it; the guard
		// follows the linkId back to the authored video. A direct audio INSERT drop
		// on that lane must divert to a fresh track, never shift the authored audio.
		const overlay: VideoTrack = {
			id: "overlay-authored",
			type: "video",
			name: "overlay-authored",
			muted: false,
			hidden: false,
			elements: [
				{
					...authoredVideoClip({ id: "hf", startTime: 0, duration: 2 * TPS }),
					linkId: "hf-link",
					isSourceAudioEnabled: false,
				},
			],
		};
		const authoredAudio: AudioTrack = {
			id: "audio-hf",
			type: "audio",
			name: "audio-hf",
			muted: false,
			elements: [
				audioClip({
					id: "hf-audio",
					startTime: 0,
					duration: 2 * TPS,
					linkId: "hf-link",
				}),
			],
		};
		const tracks: SceneTracks = {
			overlay: [overlay],
			main: {
				id: "video-main",
				type: "video",
				name: "video-main",
				muted: false,
				hidden: false,
				elements: [],
			},
			audio: [authoredAudio],
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
			targetTrackId: "audio-hf",
			dropX: mediaTime({ ticks: TPS }),
		});

		expect(executed).toHaveLength(1);
		const cmds = batchCommands(executed[0]);
		// Diverted to a fresh track: AddTrack + insert, and NO UpdateElementsCommand
		// (a ripple/split of the authored lane would be one). The insert never lands
		// on the authored audio lane.
		expect(cmds.some((c) => c instanceof AddTrackCommand)).toBe(true);
		expect(cmds.some((c) => c instanceof UpdateElementsCommand)).toBe(false);
		const insert = cmds.find(
			(c) => c instanceof InsertElementCommand,
		) as unknown as { placement: { trackId: string } };
		expect(insert.placement.trackId).not.toBe("audio-hf");
	});

	test("(G3) multi-select drop onto an authored clip lands ALL selected assets", () => {
		const overlay: VideoTrack = {
			id: "overlay-authored",
			type: "video",
			name: "overlay-authored",
			muted: false,
			hidden: false,
			elements: [authoredVideoClip({ id: "hf", startTime: 0, duration: TPS })],
		};
		const tracks: SceneTracks = {
			overlay: [overlay],
			main: {
				id: "video-main",
				type: "video",
				name: "video-main",
				muted: false,
				hidden: false,
				elements: [],
			},
			audio: [],
		};
		const { controller, executed } = makeController({
			tracks,
			assets: [
				asset({ id: "m1", type: "video", duration: 1 }),
				asset({ id: "m2", type: "video", duration: 1 }),
				asset({ id: "m3", type: "video", duration: 1 }),
			],
		});

		const target = {
			trackIndex: 0,
			isNewTrack: false,
			insertPosition: null,
			xPosition: mediaTime({ ticks: TPS / 2 }),
			targetElement: { trackId: "overlay-authored", elementId: "hf" },
		};
		(
			controller as unknown as {
				executeMediaDrop: (args: {
					target: typeof target;
					dragData: {
						type: "media";
						id: string;
						mediaType: string;
						name: string;
						mediaIds: string[];
					};
					coords: { mouseX: number; mouseY: number } | null;
					mode: "insert" | "overwrite";
				}) => void;
			}
		).executeMediaDrop({
			target,
			dragData: {
				type: "media",
				id: "m1",
				mediaType: "video",
				name: "m1",
				mediaIds: ["m1", "m2", "m3"],
			},
			coords: { mouseX: 0, mouseY: 0 },
			mode: "insert",
		});

		expect(executed).toHaveLength(1);
		const cmds = batchCommands(executed[0]);
		// All three selected assets land (previously only dragData.id did). None on
		// the authored overlay lane.
		const videoInserts = cmds.filter(
			(c) =>
				c instanceof InsertElementCommand &&
				(c as unknown as { element: { type: string } }).element.type === "video",
		) as unknown as Array<{
			element: { mediaId: string };
			placement: { trackId: string };
		}>;
		const mediaIds = videoInserts.map((c) => c.element.mediaId).sort();
		expect(mediaIds).toEqual(["m1", "m2", "m3"]);
		for (const insert of videoInserts) {
			expect(insert.placement.trackId).not.toBe("overlay-authored");
		}
		// No ripple/overwrite of the authored clip.
		expect(cmds.some((c) => c instanceof UpdateElementsCommand)).toBe(false);
	});

	test("(G4) video+audio divert is a SINGLE undo entry with the pair in one batch", () => {
		const overlay: VideoTrack = {
			id: "overlay-authored",
			type: "video",
			name: "overlay-authored",
			muted: false,
			hidden: false,
			elements: [authoredVideoClip({ id: "hf", startTime: 0, duration: TPS })],
		};
		const tracks: SceneTracks = {
			overlay: [overlay],
			main: {
				id: "video-main",
				type: "video",
				name: "video-main",
				muted: false,
				hidden: false,
				elements: [],
			},
			audio: [],
		};
		const { controller, executed } = makeController({
			tracks,
			assets: [asset({ id: "av", type: "video", duration: 1, hasAudio: true })],
		});

		const target = {
			trackIndex: 0,
			isNewTrack: false,
			insertPosition: null,
			xPosition: mediaTime({ ticks: TPS / 2 }),
			targetElement: { trackId: "overlay-authored", elementId: "hf" },
		};
		(
			controller as unknown as {
				executeMediaDrop: (args: {
					target: typeof target;
					dragData: { type: "media"; id: string; mediaType: string; name: string };
					coords: { mouseX: number; mouseY: number } | null;
					mode: "insert" | "overwrite";
				}) => void;
			}
		).executeMediaDrop({
			target,
			dragData: { type: "media", id: "av", mediaType: "video", name: "av" },
			coords: { mouseX: 0, mouseY: 0 },
			mode: "insert",
		});

		// ONE executed command => a single Ctrl+Z undoes the whole divert. Previously
		// the divert was insert-then-toggle (two undo steps). The batch carries the
		// linked video + its separated audio.
		expect(executed).toHaveLength(1);
		const cmds = batchCommands(executed[0]);
		const inserts = cmds.filter(
			(c) => c instanceof InsertElementCommand,
		) as unknown as Array<{ element: { type: string; linkId?: string } }>;
		const videoInsert = inserts.find((c) => c.element.type === "video");
		const audioInsert = inserts.find((c) => c.element.type === "audio");
		expect(videoInsert).toBeDefined();
		expect(audioInsert).toBeDefined();
		// The separated audio is ganged to the diverted video (shared fresh linkId).
		expect(audioInsert?.element.linkId).toBeDefined();
		expect(audioInsert?.element.linkId).toBe(videoInsert?.element.linkId);
	});

	test("(F1) OVERWRITE over a non-authored clip never clears a DOWNSTREAM authored clip", () => {
		// One lane: non-authored clip N [0, TPS], authored HyperFrames clip HF
		// [TPS, 2*TPS]. The covered clip under the cursor (N) is NOT authored, so the
		// entry guard passes; but a 2s overwrite region [0, 2*TPS] reaches HF, which
		// planRegionOverwrite would delete with no authored check. The region guard
		// must divert to a fresh track: HF is never deleted/trimmed.
		const track: VideoTrack = {
			id: "video-main",
			type: "video",
			name: "video-main",
			muted: false,
			hidden: false,
			elements: [
				videoClip({ id: "n", startTime: 0, duration: TPS }),
				authoredVideoClip({ id: "hf", startTime: TPS, duration: TPS }),
			],
		};
		const tracks: SceneTracks = { overlay: [], main: track, audio: [] };
		const { controller, executed } = makeController({
			tracks,
			// 2s asset => region [0, 2*TPS] covers both N and HF.
			assets: [asset({ id: "dropped", type: "video", duration: 2 })],
		});

		const target = {
			trackIndex: 0,
			isNewTrack: false,
			insertPosition: null,
			xPosition: mediaTime({ ticks: TPS / 2 }),
			targetElement: { trackId: "video-main", elementId: "n" },
		};
		(
			controller as unknown as {
				executeMediaDrop: (args: {
					target: typeof target;
					dragData: { type: "media"; id: string; mediaType: string; name: string };
					coords: { mouseX: number; mouseY: number } | null;
					mode: "insert" | "overwrite";
				}) => void;
			}
		).executeMediaDrop({
			target,
			dragData: {
				type: "media",
				id: "dropped",
				mediaType: "video",
				name: "dropped",
			},
			coords: { mouseX: 0, mouseY: 0 },
			mode: "overwrite",
		});

		expect(executed).toHaveLength(1);
		const cmds = batchCommands(executed[0]);
		// No DeleteElementsCommand touches the authored id (the pre-fix bug deleted it).
		for (const cmd of cmds) {
			if (!(cmd instanceof DeleteElementsCommand)) continue;
			const { elements } = cmd as unknown as {
				elements: Array<{ elementId: string }>;
			};
			expect(elements.some((e) => e.elementId === "hf")).toBe(false);
		}
		// Diverted to a fresh track: AddTrack + insert onto it, never the authored lane.
		expect(cmds.some((c) => c instanceof AddTrackCommand)).toBe(true);
		const insert = cmds.find(
			(c) => c instanceof InsertElementCommand,
		) as unknown as { placement: { trackId: string } };
		expect(insert.placement.trackId).not.toBe("video-main");
	});
});
