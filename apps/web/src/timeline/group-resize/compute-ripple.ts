import { type MediaTime, mediaTime, ZERO_MEDIA_TIME } from "@/wasm";
import type { SceneTracks, TimelineTrack } from "@/timeline";
import { computeRippleTrimTarget } from "@/timeline/trim-tools/ripple";
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

/**
 * Build the resize updates for a Ripple (B) edge drag.
 *
 * Trims the dragged clip's edge (keeping its `startTime` anchored, per the pure
 * `computeRippleTrimTarget`) and shifts every OTHER clip on the same track at or
 * past the ripple boundary by the resulting duration delta, so no gap/overlap
 * opens. v1 ripples a single dragged clip (the first member); the dragged clip
 * is always excluded from the downstream shift.
 *
 * Returns multi-element updates the resize controller's preview/commit already
 * handle (a single atomic `updateElements`). Non-rippleable members (no source
 * window) yield no updates.
 */
export function computeGroupRippleTrim({
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
	if (!member || member.sourceDuration == null) return EMPTY;

	const track = findTrack({ tracks, trackId: member.trackId });
	if (!track) return EMPTY;

	const target = computeRippleTrimTarget({
		side,
		startTimeTicks: member.startTime,
		durationTicks: member.duration,
		trimStartTicks: member.trimStart,
		trimEndTicks: member.trimEnd,
		sourceDurationTicks: member.sourceDuration,
		deltaTicks: deltaTime,
		rate: member.retime?.rate ?? 1,
		minDurationTicks: minDuration,
	});
	if (!target) return EMPTY;

	const updates: GroupResizeUpdate[] = [
		{
			trackId: member.trackId,
			elementId: member.elementId,
			patch: {
				trimStart: mediaTime({ ticks: target.trimStartTicks }),
				trimEnd: mediaTime({ ticks: target.trimEndTicks }),
				startTime: mediaTime({ ticks: target.startTimeTicks }),
				duration: mediaTime({ ticks: target.durationTicks }),
			},
		},
	];

	if (target.rippleShiftDeltaTicks !== 0) {
		for (const element of track.elements) {
			if (element.id === member.elementId) continue;
			if ((element.startTime as number) >= target.rippleShiftBoundaryTicks) {
				updates.push({
					trackId: track.id,
					elementId: element.id,
					patch: {
						trimStart: element.trimStart,
						trimEnd: element.trimEnd,
						startTime: mediaTime({
							ticks:
								(element.startTime as number) + target.rippleShiftDeltaTicks,
						}),
						duration: element.duration,
					},
				});
			}
		}
	}

	return { deltaTime, updates };
}
