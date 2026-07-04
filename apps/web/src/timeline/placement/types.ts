import type { ElementType, TrackType } from "@/timeline";
import type { MediaTime } from "@/wasm";

export interface PlacementTimeSpan {
	startTime: MediaTime;
	duration: MediaTime;
	excludeElementId?: string;
}

export type PlacementSubject =
	| { elementType: ElementType }
	| { trackType: TrackType };

export type PlacementStrategy =
	| {
			type: "explicit";
			trackId: string;
			/**
			 * Opt out of the main-track snap-to-0 rule for THIS insert. Used by
			 * ripple-insert: the ripple already opened a gap-free hole at the exact
			 * insert point, so snapping the new clip to 0 would misplace it (and
			 * desync it from its linked audio, which inserts unsnapped). Default
			 * false = normal main-track enforcement.
			 */
			skipMainTrackStart?: boolean;
	  }
	| { type: "firstAvailable" }
	| {
			type: "preferIndex";
			trackIndex: number;
			hoverDirection: "above" | "below";
			verticalDragDirection?: "up" | "down" | null;
			createNewTrackOnly?: boolean;
	  }
	| { type: "aboveSource"; sourceTrackIndex: number }
	| { type: "alwaysNew"; position: "highest" | "default" };

export type PlacementResult =
	| {
			kind: "existingTrack";
			trackId: string;
			trackIndex: number;
			trackType: TrackType;
			adjustedStartTime?: MediaTime;
	  }
	| {
			kind: "newTrack";
			insertIndex: number;
			insertPosition: "above" | "below" | null;
			trackType: TrackType;
	  };
