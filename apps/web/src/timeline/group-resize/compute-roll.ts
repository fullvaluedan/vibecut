import { type MediaTime, mediaTime, ZERO_MEDIA_TIME } from "@/wasm";
import { isRetimableElement } from "@/timeline";
import type { SceneTracks, TimelineElement, TimelineTrack } from "@/timeline";
import { computeRollTarget } from "@/timeline/trim-tools/roll";
import type {
	GroupResizeMember,
	GroupResizeResult,
	GroupResizeUpdate,
	ResizeSide,
} from "./types";

function findTrack({
	tracks,
	trackId,
}: {
	tracks: SceneTracks;
	trackId: string;
}): TimelineTrack | null {
	if (tracks.main.id === trackId) return tracks.main;
	return (
		tracks.overlay.find((track) => track.id === trackId) ??
		tracks.audio.find((track) => track.id === trackId) ??
		null
	);
}

const EMPTY: GroupResizeResult = { deltaTime: ZERO_MEDIA_TIME, updates: [] };

function rateOf(element: TimelineElement): number {
	return isRetimableElement(element) ? (element.retime?.rate ?? 1) : 1;
}

/**
 * Build the resize updates for a Roll edge drag.
 *
 * Dragging an edge with the Roll tool moves the CUT between the dragged clip and
 * its adjacent neighbour: one clip grows from its tail, the other shrinks from
 * its head, the combined span and every other clip stay put (no ripple). This
 * glue resolves which two clips share the dragged cut, then defers the math to
 * the pure, tested `computeRollTarget`.
 *
 * - RIGHT edge of the dragged clip: A = dragged, B = the clip starting exactly
 *   at the dragged clip's end. `+delta` (drag right) grows A, shrinks B.
 * - LEFT edge: B = dragged, A = the clip ending exactly at the dragged clip's
 *   start. `+delta` still moves the cut right (grows A, shrinks B), matching the
 *   resize-controller's left-edge delta sign.
 *
 * Returns no updates when there is no adjacent clip (Roll needs a cut), or when
 * either side has no source window (generated element) — Roll is a media-clip
 * tool. The two updates apply as one atomic commit via the controller.
 */
export function computeGroupRoll({
	members,
	tracks,
	side,
	deltaTime,
	minDuration,
}: {
	members: GroupResizeMember[];
	tracks: SceneTracks;
	side: ResizeSide;
	deltaTime: MediaTime;
	minDuration: MediaTime;
}): GroupResizeResult {
	const member = members[0];
	if (!member) return EMPTY;

	const track = findTrack({ tracks, trackId: member.trackId });
	if (!track) return EMPTY;

	const dragged = track.elements.find(
		(element) => element.id === member.elementId,
	);
	if (!dragged) return EMPTY;

	const draggedStart = dragged.startTime as number;
	const draggedEnd = draggedStart + (dragged.duration as number);

	let a: TimelineElement | undefined;
	let b: TimelineElement | undefined;
	if (side === "right") {
		a = dragged;
		b = track.elements.find(
			(element) => (element.startTime as number) === draggedEnd,
		);
	} else {
		b = dragged;
		a = track.elements.find(
			(element) =>
				(element.startTime as number) + (element.duration as number) ===
				draggedStart,
		);
	}
	if (!a || !b) return EMPTY;

	const aSource = a.sourceDuration;
	const bSource = b.sourceDuration;
	if (aSource == null || bSource == null) return EMPTY;

	const target = computeRollTarget({
		clipAStartTimeTicks: a.startTime,
		clipADurationTicks: a.duration,
		clipATrimStartTicks: a.trimStart,
		clipATrimEndTicks: a.trimEnd,
		clipASourceDurationTicks: aSource,
		clipARate: rateOf(a),
		clipBStartTimeTicks: b.startTime,
		clipBDurationTicks: b.duration,
		clipBTrimStartTicks: b.trimStart,
		clipBTrimEndTicks: b.trimEnd,
		clipBSourceDurationTicks: bSource,
		clipBRate: rateOf(b),
		deltaTicks: deltaTime,
		minDurationTicks: minDuration,
	});
	if (!target) return EMPTY;

	const updates: GroupResizeUpdate[] = [
		{
			trackId: track.id,
			elementId: a.id,
			patch: {
				trimStart: mediaTime({ ticks: target.clipATrimStartTicks }),
				trimEnd: mediaTime({ ticks: target.clipATrimEndTicks }),
				startTime: mediaTime({ ticks: target.clipAStartTimeTicks }),
				duration: mediaTime({ ticks: target.clipADurationTicks }),
			},
		},
		{
			trackId: track.id,
			elementId: b.id,
			patch: {
				trimStart: mediaTime({ ticks: target.clipBTrimStartTicks }),
				trimEnd: mediaTime({ ticks: target.clipBTrimEndTicks }),
				startTime: mediaTime({ ticks: target.clipBStartTimeTicks }),
				duration: mediaTime({ ticks: target.clipBDurationTicks }),
			},
		},
	];

	return { deltaTime, updates };
}
