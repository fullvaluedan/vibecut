import type { SceneTracks, TrackType, TimelineTrack } from "@/timeline";
import {
	getDefaultInsertIndexForTrack,
	getHighestInsertIndexForTrack,
	resolvePreferredNewTrackPlacement,
} from "./insert-index";
import { getTrackTypeForElementType } from "./compatibility";
import { enforceMainTrackStart } from "./main-track";
import { canPlaceTimeSpansOnTrack } from "./overlap";
import type {
	PlacementResult,
	PlacementStrategy,
	PlacementSubject,
	PlacementTimeSpan,
} from "./types";
import { isAtVideoTrackCap, lastVideoTrackId } from "./track-cap";
import { ZERO_MEDIA_TIME } from "@/wasm";

type ResolveTrackPlacementParams = PlacementSubject & {
	tracks: SceneTracks;
	timeSpans: PlacementTimeSpan[];
	strategy: PlacementStrategy;
	// Elements skipped from the overlap test on every candidate track (the whole
	// moving set of a multi-clip drag). See `canPlaceTimeSpansOnTrack`.
	excludeElementIds?: ReadonlySet<string>;
};

function buildExistingTrackResult({
	track,
	trackIndex,
	tracks,
	timeSpans,
}: {
	track: TimelineTrack;
	trackIndex: number;
	tracks: SceneTracks;
	timeSpans: PlacementTimeSpan[];
}): PlacementResult {
	const firstSpan = timeSpans[0];
	const requestedStartTime = firstSpan?.startTime ?? ZERO_MEDIA_TIME;
	const adjustedStartTime = enforceMainTrackStart({
		tracks,
		targetTrackId: track.id,
		requestedStartTime,
		excludeElementId: firstSpan?.excludeElementId,
	});
	return {
		kind: "existingTrack",
		trackId: track.id,
		trackIndex,
		trackType: track.type,
		...(adjustedStartTime !== requestedStartTime ? { adjustedStartTime } : {}),
	};
}

function buildNewTrackResult({
	trackType,
	insertIndex,
	insertPosition,
}: {
	trackType: TrackType;
	insertIndex: number;
	insertPosition: "above" | "below" | null;
}): PlacementResult {
	return {
		kind: "newTrack",
		trackType,
		insertIndex,
		insertPosition,
	};
}

function findFirstAvailableTrackIndex({
	tracks,
	trackType,
	timeSpans,
	excludeElementIds,
}: {
	tracks: TimelineTrack[];
	trackType: TrackType;
	timeSpans: PlacementTimeSpan[];
	excludeElementIds?: ReadonlySet<string>;
}): number {
	return tracks.findIndex((track) => {
		return (
			track.type === trackType &&
			canPlaceTimeSpansOnTrack({
				track,
				timeSpans,
				excludeElementIds,
			})
		);
	});
}

function resolveAlwaysNewTrack({
	tracks,
	trackType,
	position,
}: {
	tracks: SceneTracks;
	trackType: TrackType;
	position: "highest" | "default";
}): PlacementResult {
	const insertIndex =
		position === "highest"
			? getHighestInsertIndexForTrack({
					tracks,
					trackType,
				})
			: getDefaultInsertIndexForTrack({
					tracks,
					trackType,
				});

	return buildNewTrackResult({
		trackType,
		insertIndex,
		insertPosition: null,
	});
}

function getInsertDirection({
	hoverDirection,
	verticalDragDirection,
}: {
	hoverDirection: "above" | "below";
	verticalDragDirection?: "up" | "down" | null;
}): "above" | "below" {
	if (verticalDragDirection === "up") {
		return "above";
	}

	if (verticalDragDirection === "down") {
		return "below";
	}

	return hoverDirection;
}

export function resolveTrackPlacement(
	params: ResolveTrackPlacementParams,
): PlacementResult | null {
	const result = resolveTrackPlacementUncapped(params);

	// Hard cap: never resolve to a 9th video track. Clamp the placement onto an
	// existing video lane (first that can hold the span, else the topmost one) so
	// drops/inserts/moves land there instead of spawning V9. Audio/text/graphic/
	// effect placements are untouched. See `track-cap.ts`.
	if (
		result?.kind === "newTrack" &&
		result.trackType === "video" &&
		isAtVideoTrackCap(params.tracks)
	) {
		return clampToExistingVideoTrack({
			tracks: params.tracks,
			timeSpans: params.timeSpans,
			excludeElementIds: params.excludeElementIds,
		});
	}

	return result;
}

function clampToExistingVideoTrack({
	tracks,
	timeSpans,
	excludeElementIds,
}: {
	tracks: SceneTracks;
	timeSpans: PlacementTimeSpan[];
	excludeElementIds?: ReadonlySet<string>;
}): PlacementResult | null {
	const orderedTracks = [...tracks.overlay, tracks.main, ...tracks.audio];
	const availableIndex = findFirstAvailableTrackIndex({
		tracks: orderedTracks,
		trackType: "video",
		timeSpans,
		excludeElementIds,
	});
	const trackIndex =
		availableIndex >= 0
			? availableIndex
			: orderedTracks.findIndex(
					(track) => track.id === lastVideoTrackId(tracks),
				);
	if (trackIndex < 0) {
		return null;
	}

	return buildExistingTrackResult({
		track: orderedTracks[trackIndex],
		trackIndex,
		tracks,
		timeSpans,
	});
}

function resolveTrackPlacementUncapped({
	tracks,
	...placement
}: ResolveTrackPlacementParams): PlacementResult | null {
	const orderedTracks = [...tracks.overlay, tracks.main, ...tracks.audio];
	const trackType =
		"trackType" in placement
			? placement.trackType
			: getTrackTypeForElementType({
					elementType: placement.elementType,
				});
	const { timeSpans, strategy, excludeElementIds } = placement;

	if (strategy.type === "explicit") {
		const trackIndex = orderedTracks.findIndex(
			(track) => track.id === strategy.trackId,
		);
		if (trackIndex < 0) {
			return null;
		}

		const track = orderedTracks[trackIndex];
		if (track.type !== trackType) {
			return null;
		}

		return buildExistingTrackResult({
			track,
			trackIndex,
			tracks,
			timeSpans,
		});
	}

	if (strategy.type === "firstAvailable") {
		// An imported video should default to the main (V1) track. orderedTracks
		// lists overlay BEFORE main, so plain first-available would grab an empty
		// V2 overlay video track whenever one exists — divert video to main when
		// it can hold the span (text/graphic/audio keep filling overlay/audio
		// first; Assemble already targets main explicitly).
		if (
			trackType === "video" &&
			canPlaceTimeSpansOnTrack({
				track: tracks.main,
				timeSpans,
				excludeElementIds,
			})
		) {
			return buildExistingTrackResult({
				track: tracks.main,
				trackIndex: orderedTracks.findIndex(
					(track) => track.id === tracks.main.id,
				),
				tracks,
				timeSpans,
			});
		}

		const existingTrackIndex = findFirstAvailableTrackIndex({
			tracks: orderedTracks,
			trackType,
			timeSpans,
			excludeElementIds,
		});
		if (existingTrackIndex >= 0) {
			return buildExistingTrackResult({
				track: orderedTracks[existingTrackIndex],
				trackIndex: existingTrackIndex,
				tracks,
				timeSpans,
			});
		}

		return resolveAlwaysNewTrack({
			tracks,
			trackType,
			position: "highest",
		});
	}

	if (strategy.type === "preferIndex") {
		const preferredTrack = orderedTracks[strategy.trackIndex];
		const isPreferredTrackCompatible =
			!!preferredTrack && preferredTrack.type === trackType;
		const canUseExistingTrack =
			!strategy.createNewTrackOnly &&
			isPreferredTrackCompatible &&
			canPlaceTimeSpansOnTrack({
				track: preferredTrack,
				timeSpans,
				excludeElementIds,
			});
		if (canUseExistingTrack) {
			return buildExistingTrackResult({
				track: preferredTrack,
				trackIndex: strategy.trackIndex,
				tracks,
				timeSpans,
			});
		}

		const { insertIndex, insertPosition } = resolvePreferredNewTrackPlacement({
			tracks,
			trackType,
			preferredIndex: strategy.trackIndex,
			direction: getInsertDirection({
				hoverDirection: strategy.hoverDirection,
				verticalDragDirection: !isPreferredTrackCompatible
					? strategy.verticalDragDirection
					: null,
			}),
		});
		return buildNewTrackResult({
			trackType,
			insertIndex,
			insertPosition,
		});
	}

	if (strategy.type === "aboveSource") {
		const aboveTrackIndex = strategy.sourceTrackIndex - 1;
		const aboveTrack = orderedTracks[aboveTrackIndex];
		if (
			aboveTrack &&
			aboveTrack.type === trackType &&
			canPlaceTimeSpansOnTrack({
				track: aboveTrack,
				timeSpans,
				excludeElementIds,
			})
		) {
			return buildExistingTrackResult({
				track: aboveTrack,
				trackIndex: aboveTrackIndex,
				tracks,
				timeSpans,
			});
		}

		const firstAvailableTrackIndex = findFirstAvailableTrackIndex({
			tracks: orderedTracks,
			trackType,
			timeSpans,
			excludeElementIds,
		});
		if (firstAvailableTrackIndex >= 0) {
			return buildExistingTrackResult({
				track: orderedTracks[firstAvailableTrackIndex],
				trackIndex: firstAvailableTrackIndex,
				tracks,
				timeSpans,
			});
		}

		const insertIndex = getHighestInsertIndexForTrack({
			tracks,
			trackType,
		});

		return buildNewTrackResult({
			trackType,
			insertIndex,
			insertPosition: null,
		});
	}

	return resolveAlwaysNewTrack({
		tracks,
		trackType,
		position: strategy.position,
	});
}
