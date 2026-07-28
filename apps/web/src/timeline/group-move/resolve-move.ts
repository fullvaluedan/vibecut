import type { SceneTracks } from "@/timeline";
import { getTrackTypeForElementType } from "@/timeline/placement/compatibility";
import { canPlaceTimeSpansOnTrack } from "@/timeline/placement/overlap";
import type {
	GroupMoveResult,
	MoveGroup,
	PlannedElementMove,
} from "./types";
import {
	getDisplayTracks,
	getTrackPlacementByDisplayIndex,
	getTrackPlacementById,
} from "./track-placement";
import { remainingVideoTrackBudget } from "@/timeline/placement/track-cap";
import { isUnderHeadGravity } from "@/timeline/head-gravity";
import { planCollapsedNewTracks } from "./collapse-new-tracks";
import {
	addMediaTime,
	maxMediaTime,
	type MediaTime,
	subMediaTime,
	ZERO_MEDIA_TIME,
} from "@/wasm";

type GroupMoveTarget =
	| {
			kind: "existingTrack";
			anchorTargetTrackId: string;
	  }
	| {
			kind: "newTracks";
			anchorInsertIndex: number;
			newTrackIds: string[];
	  };

export function resolveGroupMove({
	group,
	tracks,
	anchorStartTime,
	target,
}: {
	group: MoveGroup;
	tracks: SceneTracks;
	anchorStartTime: MediaTime;
	target: GroupMoveTarget;
}): GroupMoveResult | null {
	if (target.kind === "newTracks") {
		return resolveNewTrackMove({
			group,
			tracks,
			anchorStartTime,
			anchorInsertIndex: target.anchorInsertIndex,
			newTrackIds: target.newTrackIds,
		});
	}

	return resolveExistingTrackMove({
		group,
		tracks,
		anchorStartTime,
		anchorTargetTrackId: target.anchorTargetTrackId,
	});
}

function resolveExistingTrackMove({
	group,
	tracks,
	anchorStartTime,
	anchorTargetTrackId,
}: {
	group: MoveGroup;
	tracks: SceneTracks;
	anchorStartTime: MediaTime;
	anchorTargetTrackId: string;
}): GroupMoveResult | null {
	const anchorTargetPlacement = getTrackPlacementById({
		tracks,
		trackId: anchorTargetTrackId,
	});
	if (!anchorTargetPlacement) {
		return null;
	}

	const targetTrackIdsByElementId = resolveExistingTrackIdsByElementId({
		group,
		tracks,
		anchorTargetDisplayIndex: anchorTargetPlacement.displayIndex,
	});
	if (!targetTrackIdsByElementId) {
		return null;
	}

	const clampedAnchorStartTime = clampAnchorStartTime({
		group,
		tracks,
		anchorStartTime,
		targetTrackIdsByElementId,
	});

	const moves = group.members.map((member) => ({
		sourceTrackId: member.trackId,
		targetTrackId:
			targetTrackIdsByElementId.get(member.elementId) ?? member.trackId,
		elementId: member.elementId,
		newStartTime: addMediaTime({
			a: clampedAnchorStartTime,
			b: member.timeOffset,
		}),
	}));

	if (!canApplyMovesToExistingTracks({ tracks, moves })) {
		return null;
	}

	return {
		moves,
		createTracks: [],
		targetSelection: moves.map(({ elementId, targetTrackId }) => ({
			trackId: targetTrackId,
			elementId,
		})),
	};
}

function resolveNewTrackMove({
	group,
	tracks,
	anchorStartTime,
	anchorInsertIndex,
	newTrackIds,
}: {
	group: MoveGroup;
	tracks: SceneTracks;
	anchorStartTime: MediaTime;
	anchorInsertIndex: number;
	newTrackIds: string[];
}): GroupMoveResult | null {
	const sortedMembers = [...group.members].sort(
		(leftMember, rightMember) =>
			leftMember.displayIndex - rightMember.displayIndex,
	);
	const anchorMemberIndex = sortedMembers.findIndex(
		(member) => member.elementId === group.anchor.elementId,
	);
	if (anchorMemberIndex < 0 || newTrackIds.length < sortedMembers.length) {
		return null;
	}

	const hasAudioMember = sortedMembers.some(
		(member) => member.trackSection === "audio",
	);
	const hasNonAudioMember = sortedMembers.some(
		(member) => member.trackSection !== "audio",
	);
	if (hasAudioMember && hasNonAudioMember) {
		return null;
	}

	const clampedAnchorStartTime = clampAnchorStartTime({
		group,
		tracks,
		anchorStartTime,
		targetTrackIdsByElementId: new Map(),
	});
	const blockStartIndex = hasAudioMember
		? clampAudioInsertIndex({
				tracks,
				insertIndex: anchorInsertIndex - anchorMemberIndex,
			})
		: Math.max(
				0,
				Math.min(anchorInsertIndex - anchorMemberIndex, tracks.overlay.length),
			);

	// Collapse to one new track per DISTINCT SOURCE TRACK and cap new VIDEO
	// tracks to the remaining budget (pure logic in collapse-new-tracks.ts):
	// Track-Select-Forward grabbing N clips off a single track creates ONE new
	// track, never N, and a move can never push past MAX_VIDEO_TRACKS. Members
	// whose source track is capped out keep their current lane.
	const { createTracks, newTrackIdBySourceTrackId } = planCollapsedNewTracks({
		sortedMembers,
		videoBudget: remainingVideoTrackBudget(tracks),
		blockStartIndex,
		newTrackIds,
	});

	if (createTracks.length === 0) {
		// Every member capped out — there is no new-track move to make.
		return null;
	}

	const moves = sortedMembers.map((member) => ({
		sourceTrackId: member.trackId,
		targetTrackId:
			newTrackIdBySourceTrackId.get(member.trackId) ?? member.trackId,
		elementId: member.elementId,
		newStartTime: addMediaTime({
			a: clampedAnchorStartTime,
			b: member.timeOffset,
		}),
	}));

	return {
		moves,
		createTracks,
		targetSelection: moves.map(({ elementId, targetTrackId }) => ({
			trackId: targetTrackId,
			elementId,
		})),
	};
}

function clampAudioInsertIndex({
	tracks,
	insertIndex,
}: {
	tracks: SceneTracks;
	insertIndex: number;
}): number {
	const minimumAudioInsertIndex = tracks.overlay.length + 1;
	return Math.max(
		minimumAudioInsertIndex,
		Math.min(insertIndex, minimumAudioInsertIndex + tracks.audio.length),
	);
}

function resolveExistingTrackIdsByElementId({
	group,
	tracks,
	anchorTargetDisplayIndex,
}: {
	group: MoveGroup;
	tracks: SceneTracks;
	anchorTargetDisplayIndex: number;
}): Map<string, string> | null {
	const sortedMembers = [...group.members].sort(
		(leftMember, rightMember) =>
			leftMember.displayIndex - rightMember.displayIndex,
	);
	const anchorMemberIndex = sortedMembers.findIndex(
		(member) => member.elementId === group.anchor.elementId,
	);
	if (anchorMemberIndex < 0) {
		return null;
	}

	const targetTrackIdsByElementId = new Map<string, string>();
	const usedTrackIds = new Set<string>();
	const anchorPlacement = getTrackPlacementByDisplayIndex({
		tracks,
		displayIndex: anchorTargetDisplayIndex,
	});
	if (!anchorPlacement) {
		return null;
	}

	targetTrackIdsByElementId.set(
		group.anchor.elementId,
		anchorPlacement.trackId,
	);
	usedTrackIds.add(anchorPlacement.trackId);

	let upperBoundaryIndex = anchorTargetDisplayIndex;
	for (
		let memberIndex = anchorMemberIndex - 1;
		memberIndex >= 0;
		memberIndex -= 1
	) {
		const member = sortedMembers[memberIndex];
		const targetPlacement = findCompatibleTrackPlacement({
			tracks,
			requiredTrackType: getTrackTypeForElementType({
				elementType: member.elementType,
			}),
			startDisplayIndex: upperBoundaryIndex - 1,
			step: -1,
			usedTrackIds,
		});
		if (!targetPlacement) {
			// No compatible free track near the anchor — keep this member on its
			// CURRENT track instead of aborting the whole move, so a linked audio
			// partner stays put while its video moves between video tracks (Alt is
			// no longer the only way). Real overlaps are still rejected downstream
			// by canApplyMovesToExistingTracks.
			targetTrackIdsByElementId.set(member.elementId, member.trackId);
			continue;
		}

		targetTrackIdsByElementId.set(member.elementId, targetPlacement.trackId);
		usedTrackIds.add(targetPlacement.trackId);
		upperBoundaryIndex = targetPlacement.displayIndex;
	}

	let lowerBoundaryIndex = anchorTargetDisplayIndex;
	for (
		let memberIndex = anchorMemberIndex + 1;
		memberIndex < sortedMembers.length;
		memberIndex += 1
	) {
		const member = sortedMembers[memberIndex];
		const targetPlacement = findCompatibleTrackPlacement({
			tracks,
			requiredTrackType: getTrackTypeForElementType({
				elementType: member.elementType,
			}),
			startDisplayIndex: lowerBoundaryIndex + 1,
			step: 1,
			usedTrackIds,
		});
		if (!targetPlacement) {
			// Keep this member on its current track rather than aborting the whole
			// move (same rationale as the upward pass above).
			targetTrackIdsByElementId.set(member.elementId, member.trackId);
			continue;
		}

		targetTrackIdsByElementId.set(member.elementId, targetPlacement.trackId);
		usedTrackIds.add(targetPlacement.trackId);
		lowerBoundaryIndex = targetPlacement.displayIndex;
	}

	return targetTrackIdsByElementId;
}

function findCompatibleTrackPlacement({
	tracks,
	requiredTrackType,
	startDisplayIndex,
	step,
	usedTrackIds,
}: {
	tracks: SceneTracks;
	requiredTrackType: ReturnType<typeof getTrackTypeForElementType>;
	startDisplayIndex: number;
	step: -1 | 1;
	usedTrackIds: Set<string>;
}) {
	for (
		let displayIndex = startDisplayIndex;
		displayIndex >= 0 &&
		displayIndex < tracks.overlay.length + 1 + tracks.audio.length;
		displayIndex += step
	) {
		const placement = getTrackPlacementByDisplayIndex({
			tracks,
			displayIndex,
		});
		if (!placement) {
			continue;
		}

		if (
			placement.trackType === requiredTrackType &&
			!usedTrackIds.has(placement.trackId)
		) {
			return placement;
		}
	}

	return null;
}

function clampAnchorStartTime({
	group,
	tracks,
	anchorStartTime,
	targetTrackIdsByElementId,
}: {
	group: MoveGroup;
	tracks: SceneTracks;
	anchorStartTime: MediaTime;
	targetTrackIdsByElementId: Map<string, string>;
}): MediaTime {
	const minimumAnchorStartTime = group.members.reduce(
		(minimumStartTime, member) =>
			member.timeOffset < ZERO_MEDIA_TIME
				? maxMediaTime({
						a: minimumStartTime,
						b: subMediaTime({
							a: ZERO_MEDIA_TIME,
							b: member.timeOffset,
						}),
					})
				: minimumStartTime,
		ZERO_MEDIA_TIME,
	);
	let clampedAnchorStartTime =
		anchorStartTime < minimumAnchorStartTime
			? minimumAnchorStartTime
			: anchorStartTime;

	const memberOnMainTrack = group.members.find(
		(member) =>
			targetTrackIdsByElementId.get(member.elementId) === tracks.main.id,
	);
	if (!memberOnMainTrack) {
		return clampedAnchorStartTime;
	}

	const movingElementIds = new Set(
		group.members.map((member) => member.elementId),
	);
	const requestedMainStartTime = addMediaTime({
		a: clampedAnchorStartTime,
		b: memberOnMainTrack.timeOffset,
	});
	const earliestStationaryMainStartTime = tracks.main.elements
		.filter((element) => !movingElementIds.has(element.id))
		.reduce<MediaTime | null>((earliestStartTime, element) => {
			if (earliestStartTime == null || element.startTime < earliestStartTime) {
				return element.startTime;
			}

			return earliestStartTime;
		}, null);
	// HEAD GRAVITY (Dan's fork, 2026-07-17): the old rule pinned every
	// head-bound main-track move to 0 unconditionally, so the first main clip
	// could never be dragged off the start (it always snapped back). The pin now
	// fires only inside the shared HEAD_GRAVITY_SEC zone: a move that would make
	// this member the earliest main-track clip AND lands under 2s snaps to 0;
	// at/beyond 2s it lands where dropped. A move under 2s that would NOT be the
	// earliest keeps its requested spot (gravity yields to an occupied head; a
	// genuine overlap is still rejected by canApplyMovesToExistingTracks).
	if (
		(earliestStationaryMainStartTime == null ||
			requestedMainStartTime <= earliestStationaryMainStartTime) &&
		isUnderHeadGravity({ startTime: requestedMainStartTime })
	) {
		clampedAnchorStartTime = maxMediaTime({
			a: minimumAnchorStartTime,
			b: subMediaTime({
				a: ZERO_MEDIA_TIME,
				b: memberOnMainTrack.timeOffset,
			}),
		});
	}

	return clampedAnchorStartTime;
}

function canApplyMovesToExistingTracks({
	tracks,
	moves,
}: {
	tracks: SceneTracks;
	moves: PlannedElementMove[];
}): boolean {
	const movingElementIds = new Set(moves.map((move) => move.elementId));
	const sourceElements = new Map(
		getDisplayTracks({ tracks }).flatMap((track) =>
			track.elements.map((element) => [element.id, element] as const),
		),
	);
	const movesByTargetTrackId = new Map<string, PlannedElementMove[]>();
	for (const move of moves) {
		const targetMoves = movesByTargetTrackId.get(move.targetTrackId) ?? [];
		targetMoves.push(move);
		movesByTargetTrackId.set(move.targetTrackId, targetMoves);
	}

	for (const [targetTrackId, targetMoves] of movesByTargetTrackId) {
		const targetPlacement = getTrackPlacementById({
			tracks,
			trackId: targetTrackId,
		});
		if (!targetPlacement) {
			return false;
		}

		const targetTrack = getDisplayTracks({ tracks })[
			targetPlacement.displayIndex
		];
		if (!targetTrack) {
			return false;
		}

		const timeSpans = targetMoves.map((move) => {
			const sourceElement = sourceElements.get(move.elementId);
			return {
				startTime: move.newStartTime,
				duration: sourceElement?.duration ?? ZERO_MEDIA_TIME,
			};
		});
		if (hasOverlappingTimeSpans({ timeSpans })) {
			return false;
		}

		if (
			!canPlaceTimeSpansOnTrack({
				track: {
					elements: targetTrack.elements.filter(
						(element) => !movingElementIds.has(element.id),
					),
				},
				timeSpans,
			})
		) {
			return false;
		}
	}

	return true;
}

function hasOverlappingTimeSpans({
	timeSpans,
}: {
	timeSpans: Array<{ startTime: number; duration: number }>;
}): boolean {
	const sortedSpans = [...timeSpans].sort(
		(leftSpan, rightSpan) => leftSpan.startTime - rightSpan.startTime,
	);

	for (let spanIndex = 1; spanIndex < sortedSpans.length; spanIndex += 1) {
		const previousSpan = sortedSpans[spanIndex - 1];
		const currentSpan = sortedSpans[spanIndex];
		if (
			previousSpan.startTime + previousSpan.duration >
			currentSpan.startTime
		) {
			return true;
		}
	}

	return false;
}
