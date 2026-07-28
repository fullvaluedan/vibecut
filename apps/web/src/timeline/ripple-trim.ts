import type { SceneTracks } from "@/timeline";
import type { GroupResizeMember } from "@/timeline/group-resize";
import {
	addMediaTime,
	maxMediaTime,
	type MediaTime,
	subMediaTime,
	ZERO_MEDIA_TIME,
} from "@/wasm";

/**
 * Cross-track ripple for a RIGHT-handle trim (Dan's fork, 2026-07-17): with
 * ripple editing ON, extending a clip shifts every downstream element on ALL
 * tracks right by the extend delta, and shrinking shifts them left, keeping
 * relative spacing (Premiere behavior; mirrors the pure-shift math pattern of
 * `placement/ripple-insert.ts`). Everything here is pure geometry; the resize
 * commit turns the shifts into a `RippleShiftElementsCommand` inside the same
 * BatchCommand as the trim.
 *
 * FrameCut-owned module (new file, not upstream).
 */

export interface RippleTrimShift {
	trackId: string;
	elementId: string;
	newStartTime: MediaTime;
}

/**
 * One element a right-handle ripple trim will shift, snapshotted at mousedown.
 * `baseStartTime` is the COMMITTED start: the drag's live preview re-derives
 * each shifted position from this base, so it stays immune to its own
 * preview overlay and a drag back to the origin restores exact positions.
 */
export interface RippleTrimTarget {
	trackId: string;
	elementId: string;
	baseStartTime: MediaTime;
}

/** The context a right-handle ripple commit carries from the drag session. */
export interface RippleTrimCommit {
	/** The grabbed clip's OLD end: the edit point downstream of which shifts. */
	pivotTime: MediaTime;
	/** The final (clamped + snapped) resize delta; sign = shift direction. */
	deltaTime: MediaTime;
	/** The resized members; they move via their own patches, never the shift. */
	excludeElementIds: ReadonlySet<string>;
}

function orderedTracks(tracks: SceneTracks) {
	return [...tracks.overlay, tracks.main, ...tracks.audio];
}

/**
 * Every element on every track whose start sits at/after the pivot shifts by
 * the same signed delta. The resized members are excluded (their patches
 * already place them); a clip that merely straddles the pivot stays put.
 */
export function collectRippleTrimTargets({
	tracks,
	pivotTime,
	excludeElementIds,
}: {
	tracks: SceneTracks;
	pivotTime: MediaTime;
	excludeElementIds: ReadonlySet<string>;
}): RippleTrimTarget[] {
	return orderedTracks(tracks).flatMap((track) =>
		track.elements
			.filter(
				(element) =>
					!excludeElementIds.has(element.id) &&
					element.startTime >= pivotTime,
			)
			.map((element) => ({
				trackId: track.id,
				elementId: element.id,
				baseStartTime: element.startTime,
			})),
	);
}

/**
 * Shift every snapshotted target by the signed delta. A zero delta is NOT
 * short-circuited: it yields each target at its base, which is what a live
 * preview needs when the drag returns to the origin (stale overlay positions
 * must be overwritten back to the committed start).
 */
export function shiftRippleTrimTargets({
	targets,
	deltaTime,
}: {
	targets: readonly RippleTrimTarget[];
	deltaTime: MediaTime;
}): RippleTrimShift[] {
	return targets.map((target) => ({
		trackId: target.trackId,
		elementId: target.elementId,
		newStartTime: addMediaTime({ a: target.baseStartTime, b: deltaTime }),
	}));
}

/** The commit-side shifts: the snapshot moved by the final delta. */
export function computeRippleTrimShifts({
	tracks,
	pivotTime,
	deltaTime,
	excludeElementIds,
}: {
	tracks: SceneTracks;
	pivotTime: MediaTime;
	deltaTime: MediaTime;
	excludeElementIds: ReadonlySet<string>;
}): RippleTrimShift[] {
	if (deltaTime === ZERO_MEDIA_TIME) return [];
	return shiftRippleTrimTargets({
		targets: collectRippleTrimTargets({ tracks, pivotTime, excludeElementIds }),
		deltaTime,
	});
}

/**
 * The most negative shrink delta the cross-track ripple can absorb without a
 * shifted element colliding with a clip that STRADDLES the pivot (starts
 * before it, so it does not shift). Per track: the first downstream start
 * minus the latest end among non-shifting elements; the tightest track wins.
 * `null` = no track constrains the shrink (only the members' own minimum
 * duration / source bounds apply). The members are excluded on both sides:
 * they shrink in step with the shift, so they can never collide with it.
 */
export function computeRippleShrinkFloor({
	tracks,
	pivotTime,
	excludeElementIds,
}: {
	tracks: SceneTracks;
	pivotTime: MediaTime;
	excludeElementIds: ReadonlySet<string>;
}): MediaTime | null {
	let floor: MediaTime | null = null;
	for (const track of orderedTracks(tracks)) {
		let firstDownstreamStart: MediaTime | null = null;
		let latestBlockingEnd: MediaTime | null = null;
		for (const element of track.elements) {
			if (excludeElementIds.has(element.id)) continue;
			if (element.startTime >= pivotTime) {
				if (
					firstDownstreamStart === null ||
					element.startTime < firstDownstreamStart
				) {
					firstDownstreamStart = element.startTime;
				}
				continue;
			}
			const elementEnd = addMediaTime({
				a: element.startTime,
				b: element.duration,
			});
			if (latestBlockingEnd === null || elementEnd > latestBlockingEnd) {
				latestBlockingEnd = elementEnd;
			}
		}
		if (firstDownstreamStart === null || latestBlockingEnd === null) continue;
		const headroom = maxMediaTime({
			a: ZERO_MEDIA_TIME,
			b: subMediaTime({ a: firstDownstreamStart, b: latestBlockingEnd }),
		});
		const trackFloor = subMediaTime({ a: ZERO_MEDIA_TIME, b: headroom });
		floor = floor === null ? trackFloor : maxMediaTime({ a: floor, b: trackFloor });
	}
	return floor;
}

/**
 * Lift each member's right-neighbor ceiling ONLY where the neighbor will
 * shift with the ripple. `rightNeighborBound` is the nearest non-member
 * neighbor's start: at/after the pivot it moves out of the way (bound
 * lifted); before the pivot it stays put and still binds (e.g. a clip parked
 * behind a SHORTER linked partner must block the pair's extend, or the
 * partner would land on top of it).
 */
export function liftShiftingNeighborBounds({
	members,
	pivotTime,
}: {
	members: GroupResizeMember[];
	pivotTime: MediaTime;
}): GroupResizeMember[] {
	return members.map((member) =>
		member.rightNeighborBound !== null &&
		member.rightNeighborBound >= pivotTime
			? { ...member, rightNeighborBound: null }
			: member,
	);
}
