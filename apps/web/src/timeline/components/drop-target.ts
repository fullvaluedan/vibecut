import type { TimelineTrack, TimelineElement } from "@/timeline";
import type { ComputeDropTargetParams, DropTarget } from "@/timeline";
import { resolveTrackPlacement } from "@/timeline/placement";
import { getTrackTypeForElementType } from "@/timeline/placement/compatibility";
import {
	TIMELINE_CONTENT_TOP_PADDING_PX,
	TIMELINE_TRACK_GAP_PX,
} from "./layout";
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

/** Y of the first track row inside the tracks scroll content. */
export const TRACKS_CONTENT_TOP_PX = TIMELINE_CONTENT_TOP_PADDING_PX;

export function getTrackAtY({
	mouseY,
	tracks,
	verticalDragDirection,
	getExtraHeight,
}: {
	mouseY: number;
	tracks: TimelineTrack[];
	verticalDragDirection?: "up" | "down" | null;
	// Extra height of a track beyond its base height: the expanded keyframe
	// rows. The rows render that tall, so a hit-test that ignores them drifts by
	// one lane height per expanded track below the cursor.
	getExtraHeight?: (trackIndex: number) => number;
}): { trackIndex: number; relativeY: number } | null {
	// Rows start at TIMELINE_CONTENT_TOP_PADDING_PX, not 0 (see the track-row
	// `top` in timeline/components/index.tsx); starting at 0 shifted every hit.
	let cumulativeHeight = TRACKS_CONTENT_TOP_PX;

	for (let i = 0; i < tracks.length; i++) {
		const trackHeight =
			getTrackHeight({ type: tracks[i].type }) + (getExtraHeight?.(i) ?? 0);
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

function existingTrackDropTarget({
	trackIndex,
	adjustedStartTime,
	xPosition,
}: {
	trackIndex: number;
	adjustedStartTime: MediaTime | undefined;
	xPosition: MediaTime;
}): DropTarget {
	return {
		trackIndex,
		isNewTrack: false,
		insertPosition: null,
		xPosition:
			adjustedStartTime !== undefined
				? roundMediaTime({ time: adjustedStartTime })
				: xPosition,
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
	excludeElementIds,
	targetElementTypes,
	preferMainTrack,
	getExtraTrackHeight,
}: ComputeDropTargetParams): DropTarget {
	const orderedTracks = [...tracks.overlay, tracks.main, ...tracks.audio];
	const mainTrackIndex = tracks.overlay.length;
	const xPosition =
		startTimeOverride !== undefined
			? startTimeOverride
			: isExternalDrop
				? playheadTime
				: mediaTime({
						ticks: Math.round(
							Math.max(0, mouseX / (pixelsPerSecond * zoomLevel)) *
								TICKS_PER_SECOND,
						),
					});

	if (orderedTracks.length === 0) {
		const placementResult = resolveTrackPlacement({
			tracks,
			elementType,
			timeSpans: [{ startTime: xPosition, duration: elementDuration, excludeElementId }],
			excludeElementIds,
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

	// T15.1 main-track gravity, for media drops only (bin drags + file drops). A
	// video/image drop belongs on V1 unless the pointer is clearly in the overlay
	// area ABOVE an already-used main track. Clip drags inside the timeline leave
	// the flag off and keep free placement.
	const wantsMainTrack =
		preferMainTrack === true &&
		getTrackTypeForElementType({ elementType }) === "video";
	const isMainTrackEmpty = tracks.main.elements.length === 0;
	const mainTrackTarget = (): DropTarget | null => {
		// Explicit placement: main every time, head gravity applied, and no
		// overlap veto, so an occupied main resolves to main and the caller's
		// insert flow opens a hole instead of the drop silently spawning a V2.
		const result = resolveTrackPlacement({
			tracks,
			elementType,
			timeSpans: [
				{ startTime: xPosition, duration: elementDuration, excludeElementId },
			],
			excludeElementIds,
			strategy: { type: "explicit", trackId: tracks.main.id },
		});
		if (result?.kind !== "existingTrack") return null;
		return existingTrackDropTarget({
			trackIndex: mainTrackIndex,
			adjustedStartTime: result.adjustedStartTime,
			xPosition,
		});
	};

	const trackAtMouse = getTrackAtY({
		mouseY,
		tracks: orderedTracks,
		verticalDragDirection,
		getExtraHeight: getExtraTrackHeight,
	});

	if (!trackAtMouse) {
		// The ruler/toolbar strip sits ABOVE the tracks scroll area, so a drop on
		// it arrives as a negative mouseY (the content padding is above row 0).
		const isAboveAllTracks = mouseY < TRACKS_CONTENT_TOP_PX;

		// Above = the ruler strip, below = the empty area under the lanes. For a
		// media drop both mean main (T15.1 causes 1 and 2), never a new track.
		if (wantsMainTrack) {
			const mainTarget = mainTrackTarget();
			if (mainTarget) return mainTarget;
		}

		const placementResult = resolveTrackPlacement({
			tracks,
			elementType,
			timeSpans: [{ startTime: xPosition, duration: elementDuration, excludeElementId }],
			excludeElementIds,
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
		if (!placementResult) {
			return fallbackNewTrackDropTarget({ xPosition });
		}

		// The below-the-tracks branch asks for an EXISTING lane; that result used
		// to be thrown away and a new top track made instead (T15.1 cause 5).
		if (placementResult.kind === "existingTrack") {
			return existingTrackDropTarget({
				trackIndex: placementResult.trackIndex,
				adjustedStartTime: placementResult.adjustedStartTime,
				xPosition,
			});
		}

		return {
			trackIndex: placementResult.insertIndex,
			isNewTrack: true,
			insertPosition: placementResult.insertPosition,
			xPosition,
			targetElement: EMPTY_TARGET_ELEMENT,
		};
	}

	const { trackIndex, relativeY } = trackAtMouse;
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

	// Main gravity for the in-bounds lanes: only the overlay area ABOVE main can
	// ask for a new overlay lane, and only once main holds something. Everything
	// from main downwards (main itself, the audio lanes, which can never take a
	// video anyway) lands on main.
	if (wantsMainTrack && (trackIndex >= mainTrackIndex || isMainTrackEmpty)) {
		const mainTarget = mainTrackTarget();
		if (mainTarget) return mainTarget;
	}

	const trackHeight =
		getTrackHeight({ type: track.type }) +
		(getExtraTrackHeight?.(trackIndex) ?? 0);
	const placementResult = resolveTrackPlacement({
		tracks,
		elementType,
		timeSpans: [{ startTime: xPosition, duration: elementDuration, excludeElementId }],
		excludeElementIds,
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
		return existingTrackDropTarget({
			trackIndex: placementResult.trackIndex,
			adjustedStartTime: placementResult.adjustedStartTime,
			xPosition,
		});
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
