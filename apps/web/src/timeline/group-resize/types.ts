import type { FrameRate } from "opencut-wasm";
import type { ElementRef, RetimeConfig } from "@/timeline/types";
import type { MediaTime } from "@/wasm";

export type ResizeSide = "left" | "right";

export interface GroupResizeMember extends ElementRef {
	startTime: MediaTime;
	duration: MediaTime;
	trimStart: MediaTime;
	trimEnd: MediaTime;
	sourceDuration?: MediaTime;
	/**
	 * True for element types that always have REAL source footage backing them
	 * (video, audio): a missing `sourceDuration` on one of these is a data
	 * anomaly (metadata not loaded yet), not "no source limit". Left `false`/
	 * unset for images, text, and other types that legitimately never have a
	 * `sourceDuration` and must keep free extension. See
	 * `getResizeBoundBreakdown` in `compute-resize.ts`.
	 */
	sourceDurationRequired?: boolean;
	retime?: RetimeConfig;
	leftNeighborBound: MediaTime | null;
	rightNeighborBound: MediaTime | null;
}

export interface GroupResizeUpdate extends ElementRef {
	patch: {
		trimStart: MediaTime;
		trimEnd: MediaTime;
		startTime: MediaTime;
		duration: MediaTime;
	};
}

export interface GroupResizeResult {
	deltaTime: MediaTime;
	updates: GroupResizeUpdate[];
}

export interface ComputeResizeArgs {
	member: GroupResizeMember;
	side: ResizeSide;
	deltaTime: MediaTime;
	fps: FrameRate;
}

export interface ComputeLinkedResizeArgs {
	/** The grabbed clip first, then its linked partners (never a multi-select). */
	members: GroupResizeMember[];
	side: ResizeSide;
	deltaTime: MediaTime;
	fps: FrameRate;
	/**
	 * Ripple trim (right handle with ripple editing ON): downstream clips shift
	 * with the commit, so a shrink is floored by the cross-track headroom the
	 * caller computed via `computeRippleShrinkFloor` (`null` = unbounded). The
	 * caller also lifts shifting neighbors' bounds on the members themselves
	 * (`liftShiftingNeighborBounds`); the source-extent ceiling always stays.
	 */
	rippleTrim?: { shrinkFloorDelta: MediaTime | null };
}
