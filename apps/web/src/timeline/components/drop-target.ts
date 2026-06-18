import type { TimelineTrack, TimelineElement } from "@/timeline";
import type { ComputeDropTargetParams, DropTarget } from "@/timeline";
import {
	canElementGoOnTrack,
	preferMainTrackIndex,
	resolveTrackPlacement,
} from "@/timeline/placement";
import { TIMELINE_TRACK_GAP_PX } from "./layout";
import { getTrackHeight } from "./track-layout";
import {
	mediaTime,
	type MediaTime,
	roundMediaTime,
	TICKS_PER_SECOND,
} from "@/wasm";

function findElementAtPosition({
	mouseX,
	tracks,
	trackIndex,
	targetElementTypes,
	pixelsPerSecond,
	zoomLevel,
}: {
	mouseX: number;
	tracks: TimelineTrack[];
	trackIndex: number;
	targetElementTypes: string[];
	pixelsPerSecond: number;
	zoomLevel: number;
}): { elementId: string; trackId: string } | null {
	const time = mediaTime({
		ticks: Math.round(
			(mouseX / (pixelsPerSecond * zoomLevel)) * TICKS_PER_SECOND,
		),
	});
	const track = tracks[trackIndex];
	if (!track || !("elements" in track)) return null;

	const hit = track.elements.find(
		(element: TimelineElement) =>
			targetElementTypes.includes(element.type) &&
			element.startTime <= time &&
			time < element.startTime + element.duration,
	);
	if (!hit) return null;
	return { elementId: hit.id, trackId: track.id };
}

function getTrackAtY({
	mouseY,
	tracks,
	verticalDragDirection,
}: {
	mouseY: number;
	tracks: TimelineTrack[];
	verticalDragDirection?: "up" | "down" | null;
}): { trackIndex: number; relativeY: number } | null {
	let cumulativeHeight = 0;

	for (let i = 0; i < tracks.length; i++) {
		const trackHeight = getTrackHeight({ type: tracks[i].type });
		const trackTop = cumulativeHeight;
		const trackBottom = trackTop + trackHeight;

		if (mouseY >= trackTop && mouseY < trackBottom) {
			return {
				trackIndex: i,
				relativeY: mouseY - trackTop,
			};
		}

		if (i < tracks.length - 1 && verticalDragDirection) {
			const gapTop = trackBottom;
			const gapBottom = gapTop + TIMELINE_TRACK_GAP_PX;
			if (mouseY >= gapTop && mouseY < gapBottom) {
				const isDraggingUp = verticalDragDirection === "up";
				return {
					trackIndex: isDraggingUp ? i : i + 1,
					relativeY: isDraggingUp ? trackHeight - 1 : 0,
				};
			}
		}

		cumulativeHeight += trackHeight + TIMELINE_TRACK_GAP_PX;
	}

	return null;
}

const EMPTY_TARGET_ELEMENT = null;

// Does the incoming span [start, end) overlap any clip on the track? Touching
// edges (clip.end == start or clip.start == end) do not count — matches the
// half-open-interval geometry of the overwrite/insert planner.
function spanOverlapsTrack({
	track,
	start,
	end,
}: {
	track: TimelineTrack;
	start: number;
	end: number;
}): boolean {
	return track.elements.some(
		(element) =>
			(element.startTime as number) < end &&
			(element.startTime as number) + (element.duration as number) > start,
	);
}

// Premiere-style: a clip dropped near the timeline start snaps to 0:00 instead
// of leaving a tiny gap. Only applies to mouse-derived drops (not external-file
// drops, which land at the playhead), and only on DROP — moving an existing
// clip does not snap to the head (see group-move/snap.ts). A comfortable zone
// so it's easy to hit.
const SNAP_TO_START_PX = 28;

function dropXPosition({
	startTimeOverride,
	isExternalDrop,
	playheadTime,
	mouseX,
	pixelsPerSecond,
	zoomLevel,
}: {
	startTimeOverride: MediaTime | undefined;
	isExternalDrop: boolean;
	playheadTime: MediaTime;
	mouseX: number;
	pixelsPerSecond: number;
	zoomLevel: number;
}): MediaTime {
	if (startTimeOverride !== undefined) return startTimeOverride;
	if (isExternalDrop) return playheadTime;
	const pxToTicks = (px: number) =>
		(Math.max(0, px) / (pixelsPerSecond * zoomLevel)) * TICKS_PER_SECOND;
	const rawTicks = pxToTicks(mouseX);
	const snapThresholdTicks = pxToTicks(SNAP_TO_START_PX);
	return mediaTime({
		ticks: Math.round(rawTicks <= snapThresholdTicks ? 0 : rawTicks),
	});
}

function fallbackNewTrackDropTarget({
	xPosition,
}: {
	xPosition: MediaTime;
}): DropTarget {
	return {
		trackIndex: 0,
		isNewTrack: true,
		insertPosition: null,
		xPosition,
		targetElement: EMPTY_TARGET_ELEMENT,
	};
}

export function computeDropTarget({
	elementType,
	mouseX,
	mouseY,
	tracks,
	playheadTime,
	isExternalDrop,
	elementDuration,
	pixelsPerSecond,
	zoomLevel,
	verticalDragDirection,
	startTimeOverride,
	excludeElementId,
	targetElementTypes,
	editMode,
}: ComputeDropTargetParams): DropTarget {
	const orderedTracks = [...tracks.overlay, tracks.main, ...tracks.audio];
	const xPosition = dropXPosition({
		startTimeOverride,
		isExternalDrop,
		playheadTime,
		mouseX,
		pixelsPerSecond,
		zoomLevel,
	});

	if (orderedTracks.length === 0) {
		const placementResult = resolveTrackPlacement({
			tracks,
			elementType,
			timeSpans: [{ startTime: xPosition, duration: elementDuration, excludeElementId }],
			strategy: {
				type: "preferIndex",
				trackIndex: 0,
				hoverDirection: "below",
				createNewTrackOnly: true,
			},
		});
		const emptyTimelineResult =
			placementResult?.kind === "newTrack" ? placementResult : null;
		if (!emptyTimelineResult) {
			return fallbackNewTrackDropTarget({ xPosition });
		}

		return {
			trackIndex: emptyTimelineResult.insertIndex,
			isNewTrack: true,
			insertPosition: emptyTimelineResult.insertPosition,
			xPosition,
			targetElement: EMPTY_TARGET_ELEMENT,
		};
	}

	const trackAtMouse = getTrackAtY({
		mouseY,
		tracks: orderedTracks,
		verticalDragDirection,
	});

	if (!trackAtMouse) {
		const isAboveAllTracks = mouseY < 0;

		const placementResult = resolveTrackPlacement({
			tracks,
			elementType,
			timeSpans: [{ startTime: xPosition, duration: elementDuration, excludeElementId }],
			strategy: {
				type: "preferIndex",
				trackIndex: isAboveAllTracks ? 0 : orderedTracks.length - 1,
				hoverDirection: isAboveAllTracks ? "above" : "below",
				// Dropping ABOVE all tracks intentionally makes a new top track.
				// Dropping into the empty lane area BELOW should reuse the lowest
				// free video track (V1/main) — Premiere parity — not spawn a V2.
				createNewTrackOnly: isAboveAllTracks,
			},
		});
		const outOfBoundsResult =
			placementResult?.kind === "newTrack" ? placementResult : null;
		if (!outOfBoundsResult) {
			return fallbackNewTrackDropTarget({ xPosition });
		}

		return {
			trackIndex: outOfBoundsResult.insertIndex,
			isNewTrack: true,
			insertPosition: outOfBoundsResult.insertPosition,
			xPosition,
			targetElement: EMPTY_TARGET_ELEMENT,
		};
	}

	const { relativeY } = trackAtMouse;

	// Premiere edit model (OQ7): a NEW media drop that lands on an OCCUPIED region
	// of the hovered track stays on that track and carves it (overwrite default /
	// Ctrl=insert) instead of being slid aside or pushed to a new track. Gated on
	// an ACTUAL overlap so non-overlapping drops keep the existing placement
	// (prefer-V1 etc.) unchanged; only honored for new drops on a type-compatible
	// track. executeMediaDrop reads `carveMode` to apply the carve.
	const hoveredTrack = orderedTracks[trackAtMouse.trackIndex];
	if (
		editMode &&
		excludeElementId === undefined &&
		hoveredTrack &&
		canElementGoOnTrack({ elementType, trackType: hoveredTrack.type }) &&
		spanOverlapsTrack({
			track: hoveredTrack,
			start: xPosition as number,
			end: (xPosition as number) + (elementDuration as number),
		})
	) {
		return {
			trackIndex: trackAtMouse.trackIndex,
			isNewTrack: false,
			insertPosition: null,
			xPosition,
			targetElement: EMPTY_TARGET_ELEMENT,
			carveMode: editMode,
		};
	}

	// Premiere parity (#4): when DROPPING a NEW clip, a video/image prefers the
	// main track (V1) when it fits, instead of the overlay lane the cursor happens
	// to be over. When MOVING an existing clip (excludeElementId is set), honor the
	// hovered track — the user is deliberately relocating it, so don't yank it back
	// to V1. Without this, moving a video onto another track snaps it back to V1.
	const isMovingExistingElement = excludeElementId !== undefined;
	const trackIndex = isMovingExistingElement
		? trackAtMouse.trackIndex
		: preferMainTrackIndex({
				tracks,
				elementType,
				hoveredTrackIndex: trackAtMouse.trackIndex,
				timeSpans: [
					{ startTime: xPosition, duration: elementDuration, excludeElementId },
				],
			});
	const track = orderedTracks[trackIndex];

	if (targetElementTypes && targetElementTypes.length > 0) {
		const targetElement = findElementAtPosition({
			mouseX,
			tracks: orderedTracks,
			trackIndex,
			targetElementTypes,
			pixelsPerSecond,
			zoomLevel,
		});
		if (targetElement) {
			return {
				trackIndex,
				isNewTrack: false,
				insertPosition: null,
				xPosition,
				targetElement,
			};
		}
	}

	const trackHeight = getTrackHeight({ type: track.type });
	const placementResult = resolveTrackPlacement({
		tracks,
		elementType,
		timeSpans: [{ startTime: xPosition, duration: elementDuration, excludeElementId }],
		strategy: {
			type: "preferIndex",
			trackIndex,
			hoverDirection: relativeY < trackHeight / 2 ? "above" : "below",
			verticalDragDirection,
		},
	});
	if (!placementResult) {
		return fallbackNewTrackDropTarget({ xPosition });
	}

	if (placementResult.kind === "existingTrack") {
		const adjustedXPosition =
			placementResult.adjustedStartTime !== undefined
				? roundMediaTime({ time: placementResult.adjustedStartTime })
				: xPosition;

		return {
			trackIndex: placementResult.trackIndex,
			isNewTrack: false,
			insertPosition: null,
			xPosition: adjustedXPosition,
			targetElement: EMPTY_TARGET_ELEMENT,
		};
	}

	return {
		trackIndex: placementResult.insertIndex,
		isNewTrack: true,
		insertPosition: placementResult.insertPosition,
		xPosition,
		targetElement: EMPTY_TARGET_ELEMENT,
	};
}

export function getDropLineY({
	dropTarget,
	tracks,
}: {
	dropTarget: DropTarget;
	tracks: TimelineTrack[];
}): number {
	const safeTrackIndex = Math.min(
		Math.max(dropTarget.trackIndex, 0),
		tracks.length,
	);
	let y = 0;

	for (let i = 0; i < safeTrackIndex; i++) {
		y += getTrackHeight({ type: tracks[i].type }) + TIMELINE_TRACK_GAP_PX;
	}

	return y;
}
