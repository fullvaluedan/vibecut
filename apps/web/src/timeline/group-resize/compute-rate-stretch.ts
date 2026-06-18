import { type MediaTime, mediaTime, ZERO_MEDIA_TIME } from "@/wasm";
import { computeRateStretchTarget } from "./rate-stretch";
import type {
	GroupResizeMember,
	GroupResizeResult,
	GroupResizeUpdate,
	ResizeSide,
} from "./types";

/**
 * Build the resize updates for a Rate-Stretch edge drag.
 *
 * Mirrors `computeGroupResize`'s shape so the resize controller can swap it in
 * when the Rate-Stretch tool is armed. Unlike a trim, this keeps each member's
 * source window (`trimStart`/`trimEnd`) fixed and instead emits a new `retime`
 * rate; the update pipeline derives the matching on-timeline duration from that
 * rate, but we also carry the computed `duration` (and shifted `startTime` for
 * left-edge drags) so change-detection and the live preview stay exact.
 *
 * Members with no usable source window (generated elements without a
 * `sourceDuration`) aren't rate-stretchable and are simply left out of the
 * update set.
 */
export function computeGroupRateStretch({
	members,
	side,
	deltaTime,
	minDuration,
}: {
	members: GroupResizeMember[];
	side: ResizeSide;
	deltaTime: MediaTime;
	minDuration: MediaTime;
}): GroupResizeResult {
	const updates: GroupResizeUpdate[] = [];

	for (const member of members) {
		if (member.sourceDuration == null) continue;

		const target = computeRateStretchTarget({
			side,
			startTimeTicks: member.startTime,
			durationTicks: member.duration,
			trimStartTicks: member.trimStart,
			trimEndTicks: member.trimEnd,
			sourceDurationTicks: member.sourceDuration,
			deltaTicks: deltaTime,
			leftNeighborBoundTicks: member.leftNeighborBound,
			rightNeighborBoundTicks: member.rightNeighborBound,
			minDurationTicks: minDuration,
		});
		if (!target) continue;

		updates.push({
			trackId: member.trackId,
			elementId: member.elementId,
			patch: {
				trimStart: member.trimStart,
				trimEnd: member.trimEnd,
				startTime: mediaTime({ ticks: target.newStartTimeTicks }),
				duration: mediaTime({ ticks: target.newDurationTicks }),
				retime: {
					rate: target.rate,
					maintainPitch: member.retime?.maintainPitch ?? false,
				},
			},
		});
	}

	return { deltaTime: ZERO_MEDIA_TIME, updates };
}
