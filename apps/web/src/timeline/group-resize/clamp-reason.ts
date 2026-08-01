import type { MediaTime } from "@/wasm";
import { getResizeBoundBreakdown } from "./compute-resize";
import type { GroupResizeMember, ResizeSide } from "./types";

/**
 * Why an edge-drag delta is currently clamped, so the UI can show CapCut-style
 * feedback (a flash + tooltip, or a neighbor-edge highlight) instead of
 * silently refusing the drag. This file adds NO new clamp arithmetic: both
 * functions below classify the SAME bounds `computeResize`/`computeLinkedResize`
 * already enforce, read straight from `getResizeBoundBreakdown`.
 */
export type ClampReason = "source-limit" | "neighbor" | "min-duration";

/**
 * Clamp reason for a SINGLE member's own bound (its own source headroom and
 * its own neighbor), ignoring any other linked member. `requestedDeltaTime`
 * is the delta the drag is asking for BEFORE the per-member clamp; returns
 * `null` when that delta is within bounds (not currently clamped).
 */
export function getMemberClampReason({
	member,
	side,
	requestedDeltaTime,
	minDuration,
}: {
	member: GroupResizeMember;
	side: ResizeSide;
	requestedDeltaTime: MediaTime;
	minDuration: MediaTime;
}): ClampReason | null {
	const { minimum, minimumReason, maximum, maximumReason } =
		getResizeBoundBreakdown({ member, side, minDuration });

	if (requestedDeltaTime < minimum) return minimumReason;
	if (maximum !== null && requestedDeltaTime > maximum) return maximumReason;
	return null;
}

export interface GroupClampReason {
	reason: ClampReason;
	/** The linked member whose bound is actually binding the group (mirrors
	 * `computeLinkedResize`'s max-of-minimums / min-of-maximums reduction). A
	 * linked trim can be clamped by the AUDIO partner's neighbor while the
	 * VIDEO clip is the one being dragged. */
	elementId: string;
}

/**
 * Clamp reason for a LINKED resize gesture (the grabbed clip plus its linked
 * partners): the group is clamped by the MOST restrictive member, exactly
 * like `computeLinkedResize` reduces per-member bounds into one shared delta.
 * `rippleShrinkFloorDelta` mirrors the same optional ripple-trim floor
 * `computeLinkedResize` accepts for a right-handle shrink with ripple
 * editing ON; when it binds, the reason is reported as "neighbor" (a
 * downstream clip on another track is the wall).
 */
export function getGroupClampReason({
	members,
	side,
	requestedDeltaTime,
	minDuration,
	rippleShrinkFloorDelta = null,
}: {
	members: GroupResizeMember[];
	side: ResizeSide;
	requestedDeltaTime: MediaTime;
	minDuration: MediaTime;
	rippleShrinkFloorDelta?: MediaTime | null;
}): GroupClampReason | null {
	if (members.length === 0) return null;

	let groupMinimum: MediaTime | null = null;
	let groupMinimumReason: ClampReason | null = null;
	let groupMinimumElementId: string | null = null;
	let groupMaximum: MediaTime | null = null;
	let groupMaximumReason: ClampReason | null = null;
	let groupMaximumElementId: string | null = null;
	let anyFiniteMaximum = false;

	for (const member of members) {
		const breakdown = getResizeBoundBreakdown({ member, side, minDuration });
		if (groupMinimum === null || breakdown.minimum > groupMinimum) {
			groupMinimum = breakdown.minimum;
			groupMinimumReason = breakdown.minimumReason;
			groupMinimumElementId = member.elementId;
		}
		if (
			breakdown.maximum !== null &&
			(!anyFiniteMaximum || breakdown.maximum < (groupMaximum as MediaTime))
		) {
			groupMaximum = breakdown.maximum;
			groupMaximumReason = breakdown.maximumReason;
			groupMaximumElementId = member.elementId;
			anyFiniteMaximum = true;
		}
	}

	if (
		side === "right" &&
		rippleShrinkFloorDelta != null &&
		(groupMinimum === null || rippleShrinkFloorDelta > groupMinimum)
	) {
		groupMinimum = rippleShrinkFloorDelta;
		groupMinimumReason = "neighbor";
		groupMinimumElementId = members[0].elementId;
	}

	if (
		groupMinimum !== null &&
		groupMinimumReason !== null &&
		groupMinimumElementId !== null &&
		requestedDeltaTime < groupMinimum
	) {
		return { reason: groupMinimumReason, elementId: groupMinimumElementId };
	}
	if (
		groupMaximum !== null &&
		groupMaximumReason !== null &&
		groupMaximumElementId !== null &&
		requestedDeltaTime > groupMaximum
	) {
		return { reason: groupMaximumReason, elementId: groupMaximumElementId };
	}
	return null;
}
