import { describe, expect, test } from "bun:test";
import { resolveGroupMove } from "@/timeline/group-move";
import type { GroupMember, MoveGroup } from "@/timeline/group-move";
import type {
	AudioElement,
	AudioTrack,
	SceneTracks,
	VideoElement,
	VideoTrack,
} from "@/timeline";
import { mediaTime, ZERO_MEDIA_TIME } from "@/wasm";

// TICKS_PER_SECOND is 120_000 under the test wasm mock; 1 frame at 30fps = 4_000.
const SECOND = 120_000;
const FRAME = 4_000;

function videoElement({
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

function mainOnlyTracks(elements: VideoElement[]): SceneTracks {
	const main: VideoTrack = {
		id: "main-track",
		type: "video",
		name: "Main",
		muted: false,
		hidden: false,
		elements,
	};
	return { overlay: [], main, audio: [] };
}

/** A one-member group anchored on a main-track clip (what a nudge/drag builds). */
function singleMemberGroup({
	elementId,
	duration,
}: {
	elementId: string;
	duration: number;
}): MoveGroup {
	const member = {
		trackId: "main-track",
		elementId,
		elementType: "video" as const,
		duration: mediaTime({ ticks: duration }),
		timeOffset: ZERO_MEDIA_TIME,
		trackSection: "main" as const,
		sectionIndex: 0,
		displayIndex: 0,
	};
	return { anchor: member, members: [member] };
}

function audioElement({
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
	};
}

/** Tracks fixture with `overlayVideoCount` empty overlay video tracks above
 * main and `audioCount` empty audio tracks below, for exercising the
 * new-track budget caps (video and audio) in `resolveNewTrackMove`. */
function tracksWithSections({
	overlayVideoCount,
	audioCount,
}: {
	overlayVideoCount: number;
	audioCount: number;
}): SceneTracks {
	const overlay: VideoTrack[] = Array.from(
		{ length: overlayVideoCount },
		(_unused, index) => ({
			id: `ov${index}`,
			type: "video",
			name: `Overlay ${index}`,
			muted: false,
			hidden: false,
			elements: [],
		}),
	);
	const audio: AudioTrack[] = Array.from(
		{ length: audioCount },
		(_unused, index) => ({
			id: `a${index}`,
			type: "audio",
			name: `Audio ${index}`,
			muted: false,
			elements: [],
		}),
	);
	const main: VideoTrack = {
		id: "main-track",
		type: "video",
		name: "Main",
		muted: false,
		hidden: false,
		elements: [],
	};
	return { overlay, main, audio };
}

/** A group member sourced from an existing AUDIO track, for the newTracks
 * (vertical drag creates fresh lanes) path. */
function audioTrackMember({
	trackId,
	elementId,
	sectionIndex,
	overlayVideoCount,
}: {
	trackId: string;
	elementId: string;
	sectionIndex: number;
	overlayVideoCount: number;
}): GroupMember {
	return {
		trackId,
		elementId,
		elementType: "audio",
		duration: mediaTime({ ticks: SECOND }),
		timeOffset: ZERO_MEDIA_TIME,
		trackSection: "audio",
		sectionIndex,
		displayIndex: overlayVideoCount + 1 + sectionIndex,
	};
}

/** A group member sourced from an existing OVERLAY video track, for the
 * newTracks path. */
function overlayVideoMember({
	trackId,
	elementId,
	sectionIndex,
}: {
	trackId: string;
	elementId: string;
	sectionIndex: number;
}): GroupMember {
	return {
		trackId,
		elementId,
		elementType: "video",
		duration: mediaTime({ ticks: SECOND }),
		timeOffset: ZERO_MEDIA_TIME,
		trackSection: "overlay",
		sectionIndex,
		displayIndex: sectionIndex,
	};
}

function resolveOnMain({
	tracks,
	group,
	anchorStartTime,
}: {
	tracks: SceneTracks;
	group: MoveGroup;
	anchorStartTime: number;
}) {
	return resolveGroupMove({
		group,
		tracks,
		anchorStartTime: mediaTime({ ticks: anchorStartTime }),
		target: { kind: "existingTrack", anchorTargetTrackId: "main-track" },
	});
}

describe("resolveGroupMove main-track head gravity (Dan's fork)", () => {
	test("a one-frame nudge from 0 stays at 0 (under gravity)", () => {
		const tracks = mainOnlyTracks([
			videoElement({ id: "a", startTime: 0, duration: 5 * SECOND }),
			videoElement({ id: "b", startTime: 10 * SECOND, duration: 5 * SECOND }),
		]);
		const result = resolveOnMain({
			tracks,
			group: singleMemberGroup({ elementId: "a", duration: 5 * SECOND }),
			anchorStartTime: FRAME,
		});
		expect(result).not.toBeNull();
		expect(result?.moves[0]?.newStartTime).toBe(0);
	});

	test("a clip at 3s nudges freely (no snap-back beyond the 2s zone)", () => {
		const tracks = mainOnlyTracks([
			videoElement({ id: "a", startTime: 3 * SECOND, duration: SECOND }),
		]);
		const result = resolveOnMain({
			tracks,
			group: singleMemberGroup({ elementId: "a", duration: SECOND }),
			anchorStartTime: 3 * SECOND + FRAME,
		});
		expect(result).not.toBeNull();
		expect(result?.moves[0]?.newStartTime).toBe(3 * SECOND + FRAME);
	});

	test("the head clip dragged to 5s lands at 5s (old rule snapped it back to 0)", () => {
		const tracks = mainOnlyTracks([
			videoElement({ id: "a", startTime: 0, duration: SECOND }),
			videoElement({ id: "b", startTime: 10 * SECOND, duration: SECOND }),
		]);
		const result = resolveOnMain({
			tracks,
			group: singleMemberGroup({ elementId: "a", duration: SECOND }),
			anchorStartTime: 5 * SECOND,
		});
		expect(result).not.toBeNull();
		expect(result?.moves[0]?.newStartTime).toBe(5 * SECOND);
	});

	test("the head clip dragged to 1.5s snaps to 0 (inside the gravity zone)", () => {
		const tracks = mainOnlyTracks([
			videoElement({ id: "a", startTime: 0, duration: SECOND }),
			videoElement({ id: "b", startTime: 10 * SECOND, duration: SECOND }),
		]);
		const result = resolveOnMain({
			tracks,
			group: singleMemberGroup({ elementId: "a", duration: SECOND }),
			anchorStartTime: 1.5 * SECOND,
		});
		expect(result).not.toBeNull();
		expect(result?.moves[0]?.newStartTime).toBe(0);
	});

	test("a sub-2s move that is not head-bound keeps its spot (gravity yields to an occupied head)", () => {
		const tracks = mainOnlyTracks([
			videoElement({ id: "head", startTime: 0, duration: SECOND }),
			videoElement({ id: "a", startTime: 10 * SECOND, duration: SECOND }),
		]);
		const result = resolveOnMain({
			tracks,
			group: singleMemberGroup({ elementId: "a", duration: SECOND }),
			anchorStartTime: 1.5 * SECOND,
		});
		expect(result).not.toBeNull();
		expect(result?.moves[0]?.newStartTime).toBe(1.5 * SECOND);
	});
});

describe("resolveGroupMove new-track budget caps", () => {
	test("below the AUDIO cap, a vertical drag creates a new audio track per source track", () => {
		const tracks = tracksWithSections({ overlayVideoCount: 0, audioCount: 2 });
		const memberA = audioTrackMember({
			trackId: "a0",
			elementId: "elA",
			sectionIndex: 0,
			overlayVideoCount: 0,
		});
		const memberB = audioTrackMember({
			trackId: "a1",
			elementId: "elB",
			sectionIndex: 1,
			overlayVideoCount: 0,
		});
		const group: MoveGroup = { anchor: memberA, members: [memberA, memberB] };
		const result = resolveGroupMove({
			group,
			tracks,
			anchorStartTime: ZERO_MEDIA_TIME,
			target: {
				kind: "newTracks",
				anchorInsertIndex: tracks.overlay.length + 1 + tracks.audio.length,
				newTrackIds: ["n1", "n2"],
			},
		});
		expect(result).not.toBeNull();
		expect(result?.createTracks).toHaveLength(2);
		expect(result?.createTracks.map((t) => t.type)).toEqual(["audio", "audio"]);
		const targetIds = new Set(result?.moves.map((move) => move.targetTrackId));
		expect(targetIds.has("a0")).toBe(false);
		expect(targetIds.has("a1")).toBe(false);
	});

	test("at the AUDIO cap, the over-budget source keeps its current lane instead of a new one", () => {
		const tracks = tracksWithSections({ overlayVideoCount: 0, audioCount: 7 });
		const memberA = audioTrackMember({
			trackId: "a0",
			elementId: "elA",
			sectionIndex: 0,
			overlayVideoCount: 0,
		});
		const memberB = audioTrackMember({
			trackId: "a1",
			elementId: "elB",
			sectionIndex: 1,
			overlayVideoCount: 0,
		});
		const group: MoveGroup = { anchor: memberA, members: [memberA, memberB] };
		const result = resolveGroupMove({
			group,
			tracks,
			anchorStartTime: ZERO_MEDIA_TIME,
			target: {
				kind: "newTracks",
				anchorInsertIndex: tracks.overlay.length + 1 + tracks.audio.length,
				newTrackIds: ["n1", "n2"],
			},
		});
		expect(result).not.toBeNull();
		// Only 1 more audio track fits (7 existing + main's video budget is
		// unrelated); the first member gets it, the second collapses onto its
		// own already-existing lane rather than spawning a 9th.
		expect(result?.createTracks).toHaveLength(1);
		expect(result?.createTracks[0]?.type).toBe("audio");
		const moveA = result?.moves.find((move) => move.elementId === "elA");
		const moveB = result?.moves.find((move) => move.elementId === "elB");
		expect(moveA?.targetTrackId).not.toBe("a0");
		expect(moveB?.targetTrackId).toBe("a1");
	});

	test("below the VIDEO cap, a vertical drag creates a new overlay video track per source track", () => {
		const tracks = tracksWithSections({ overlayVideoCount: 2, audioCount: 0 });
		const memberA = overlayVideoMember({
			trackId: "ov0",
			elementId: "elA",
			sectionIndex: 0,
		});
		const memberB = overlayVideoMember({
			trackId: "ov1",
			elementId: "elB",
			sectionIndex: 1,
		});
		const group: MoveGroup = { anchor: memberA, members: [memberA, memberB] };
		const result = resolveGroupMove({
			group,
			tracks,
			anchorStartTime: ZERO_MEDIA_TIME,
			target: { kind: "newTracks", anchorInsertIndex: 0, newTrackIds: ["n1", "n2"] },
		});
		expect(result).not.toBeNull();
		expect(result?.createTracks).toHaveLength(2);
		expect(result?.createTracks.map((t) => t.type)).toEqual(["video", "video"]);
	});

	test("at the VIDEO cap, the over-budget source keeps its current lane instead of a new one", () => {
		// main (1) + 6 overlay = 7, budget 1: only room for one more video track.
		const tracks = tracksWithSections({ overlayVideoCount: 6, audioCount: 0 });
		const memberA = overlayVideoMember({
			trackId: "ov0",
			elementId: "elA",
			sectionIndex: 0,
		});
		const memberB = overlayVideoMember({
			trackId: "ov1",
			elementId: "elB",
			sectionIndex: 1,
		});
		const group: MoveGroup = { anchor: memberA, members: [memberA, memberB] };
		const result = resolveGroupMove({
			group,
			tracks,
			anchorStartTime: ZERO_MEDIA_TIME,
			target: { kind: "newTracks", anchorInsertIndex: 0, newTrackIds: ["n1", "n2"] },
		});
		expect(result).not.toBeNull();
		expect(result?.createTracks).toHaveLength(1);
		const moveA = result?.moves.find((move) => move.elementId === "elA");
		const moveB = result?.moves.find((move) => move.elementId === "elB");
		expect(moveA?.targetTrackId).not.toBe("ov0");
		expect(moveB?.targetTrackId).toBe("ov1");
	});

	test("a mixed video+audio group never creates new tracks (both budgets moot)", () => {
		const tracks = tracksWithSections({ overlayVideoCount: 2, audioCount: 2 });
		const videoMember = overlayVideoMember({
			trackId: "ov0",
			elementId: "elVideo",
			sectionIndex: 0,
		});
		const audioMember = audioTrackMember({
			trackId: "a0",
			elementId: "elAudio",
			sectionIndex: 0,
			overlayVideoCount: 2,
		});
		const group: MoveGroup = {
			anchor: videoMember,
			members: [videoMember, audioMember],
		};
		const result = resolveGroupMove({
			group,
			tracks,
			anchorStartTime: ZERO_MEDIA_TIME,
			target: { kind: "newTracks", anchorInsertIndex: 0, newTrackIds: ["n1", "n2"] },
		});
		expect(result).toBeNull();
	});
});
