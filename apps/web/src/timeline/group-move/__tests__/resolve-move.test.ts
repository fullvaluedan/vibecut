import { describe, expect, test } from "bun:test";
import { resolveGroupMove } from "@/timeline/group-move";
import type { MoveGroup } from "@/timeline/group-move";
import type { SceneTracks, VideoElement, VideoTrack } from "@/timeline";
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
