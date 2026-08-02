import type { SceneTracks, TimelineElement } from "@/timeline";
import type { GroupResizeMember, ResizeSide } from "@/timeline/group-resize";
import { findLinkedPartners } from "@/timeline/link-elements";
import type { RippleTrimShift, RippleTrimTarget } from "@/timeline/ripple-trim";
import {
	addMediaTime,
	maxMediaTime,
	type MediaTime,
	mediaTime,
	subMediaTime,
	ZERO_MEDIA_TIME,
} from "@/wasm";

/**
 * Magnetic main track (CapCut's core timeline behavior, Dan's 2026-08-01
 * decision: default ON), as a visible toolbar toggle.
 *
 * Scope, and how it differs from the global "Ripple editing" toggle:
 * - RIPPLE EDITING is cross-track: every element on EVERY track downstream of
 *   an edit point shifts (Premiere semantics, `ripple-trim.ts`).
 * - MAGNET is main-track-scoped: only main-track elements shift, plus the
 *   LINKED partners of those elements (a clip's separated audio half follows
 *   its video). Overlay lanes and unlinked audio never move.
 * - PRECEDENCE: ripple editing is a strict superset, so when BOTH toggles are
 *   on the ripple-editing path runs and the magnet path is skipped entirely.
 *   That is the single rule that keeps anything from being shifted twice; it
 *   is enforced at both magnet entry points (`CommandManager.execute` for the
 *   gap-closing post-pass, `ResizeController.onResizeStart` for trims).
 *
 * Everything in this module is pure geometry. The callers turn the shifts into
 * a `RippleShiftElementsCommand` inside the same undo step as the user action.
 *
 * FrameCut-owned module (new file, not upstream).
 */

interface Interval {
	start: number;
	end: number;
}

function allTracks(tracks: SceneTracks) {
	return [...tracks.overlay, tracks.main, ...tracks.audio];
}

function findElement({
	tracks,
	elementId,
}: {
	tracks: SceneTracks;
	elementId: string;
}): TimelineElement | null {
	for (const track of allTracks(tracks)) {
		const element = track.elements.find((el) => el.id === elementId);
		if (element) return element;
	}
	return null;
}

function elementEnd(element: TimelineElement): MediaTime {
	return addMediaTime({ a: element.startTime, b: element.duration });
}

function negate(time: MediaTime): MediaTime {
	return subMediaTime({ a: ZERO_MEDIA_TIME, b: time });
}

// --- Trim-side geometry (live drag + commit) ---

/**
 * Everything the magnet moves for a main-track trim: main-track elements at or
 * after the pivot, plus each of those elements' LINKED partners wherever they
 * live (the separated audio half of a video clip). Snapshotted at mousedown so
 * the live preview re-derives every shifted position from a committed base,
 * exactly like `collectRippleTrimTargets`.
 */
export function collectMagnetTrimTargets({
	tracks,
	pivotTime,
	excludeElementIds,
}: {
	tracks: SceneTracks;
	pivotTime: MediaTime;
	excludeElementIds: ReadonlySet<string>;
}): RippleTrimTarget[] {
	const targets: RippleTrimTarget[] = [];
	const claimed = new Set<string>(excludeElementIds);

	for (const element of tracks.main.elements) {
		if (claimed.has(element.id)) continue;
		if (element.startTime < pivotTime) continue;
		claimed.add(element.id);
		targets.push({
			trackId: tracks.main.id,
			elementId: element.id,
			baseStartTime: element.startTime,
		});

		for (const partner of findLinkedPartners({
			ref: { trackId: tracks.main.id, elementId: element.id },
			tracks,
			mode: "timeline",
		})) {
			if (claimed.has(partner.elementId)) continue;
			const partnerElement = findElement({
				tracks,
				elementId: partner.elementId,
			});
			if (!partnerElement) continue;
			claimed.add(partner.elementId);
			targets.push({
				trackId: partner.trackId,
				elementId: partner.elementId,
				baseStartTime: partnerElement.startTime,
			});
		}
	}

	return targets;
}

/**
 * The tightest headroom the magnet shift can absorb before a SHIFTING element
 * lands on one that stays put. Per track: the first shifting element's start
 * minus the latest end among the elements that neither shift nor resize; the
 * tightest track wins. `null` = nothing constrains it.
 *
 * Returned as a negative delta, i.e. the FLOOR for a right-handle shrink
 * (same convention as `computeRippleShrinkFloor`). A left-handle magnet trim
 * closes the gap with a POSITIVE delta instead, so it negates this into a
 * ceiling (see `magnetShrinkCeiling`).
 */
export function computeMagnetShrinkFloor({
	tracks,
	excludeElementIds,
	shiftingElementIds,
}: {
	tracks: SceneTracks;
	excludeElementIds: ReadonlySet<string>;
	shiftingElementIds: ReadonlySet<string>;
}): MediaTime | null {
	let floor: MediaTime | null = null;
	for (const track of allTracks(tracks)) {
		let firstShiftingStart: MediaTime | null = null;
		for (const element of track.elements) {
			if (!shiftingElementIds.has(element.id)) continue;
			if (firstShiftingStart === null || element.startTime < firstShiftingStart) {
				firstShiftingStart = element.startTime;
			}
		}
		if (firstShiftingStart === null) continue;

		let latestBlockingEnd: MediaTime | null = null;
		for (const element of track.elements) {
			if (shiftingElementIds.has(element.id)) continue;
			if (excludeElementIds.has(element.id)) continue;
			const end = elementEnd(element);
			if (end > firstShiftingStart) continue;
			if (latestBlockingEnd === null || end > latestBlockingEnd) {
				latestBlockingEnd = end;
			}
		}
		if (latestBlockingEnd === null) continue;

		const headroom = maxMediaTime({
			a: ZERO_MEDIA_TIME,
			b: subMediaTime({ a: firstShiftingStart, b: latestBlockingEnd }),
		});
		const trackFloor = negate(headroom);
		floor = floor === null ? trackFloor : maxMediaTime({ a: floor, b: trackFloor });
	}
	return floor;
}

/** The commit-side shifts for a magnet trim: the main-track scope moved by the
 * final (already direction-signed) delta. Mirrors `computeRippleTrimShifts`. */
export function computeMagnetTrimShifts({
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
	return collectMagnetTrimTargets({
		tracks,
		pivotTime,
		excludeElementIds,
	}).map((target) => ({
		trackId: target.trackId,
		elementId: target.elementId,
		newStartTime: addMediaTime({ a: target.baseStartTime, b: deltaTime }),
	}));
}

/** The left-handle counterpart of the shrink floor: the same headroom as a
 * positive ceiling, because a magnet left trim closes its gap by growing the
 * delta rather than shrinking it. */
export function magnetShrinkCeiling(
	shrinkFloorDelta: MediaTime | null,
): MediaTime | null {
	return shrinkFloorDelta === null ? null : negate(shrinkFloorDelta);
}

/**
 * Relax the bounds the magnet is about to make irrelevant.
 *
 * - RIGHT handle: a member's right-neighbor ceiling is lifted only when that
 *   exact neighbor element is in the shift set (it moves out of the way).
 *   Unlike ripple editing, the magnet does NOT move everything, so a neighbor
 *   on an overlay/unlinked audio lane must keep binding.
 * - LEFT handle: the magnet PINS every member's start (the clip slides back so
 *   it stays butted), so neither the left neighbor nor the timeline-zero wall
 *   can bind. Only the source extent does, which is why a clamped magnet left
 *   drag reports "source-limit" rather than "neighbor".
 */
export function liftMagnetNeighborBounds({
	members,
	side,
	shiftingElementIds,
	neighborElementIds,
}: {
	members: GroupResizeMember[];
	side: ResizeSide;
	shiftingElementIds: ReadonlySet<string>;
	neighborElementIds: ReadonlyMap<string, { left: string | null; right: string | null }>;
}): GroupResizeMember[] {
	if (side === "left") {
		return members.map((member) => ({ ...member, leftBoundLifted: true }));
	}
	return members.map((member) => {
		const rightNeighborId = neighborElementIds.get(member.elementId)?.right;
		return rightNeighborId && shiftingElementIds.has(rightNeighborId)
			? { ...member, rightNeighborBound: null }
			: member;
	});
}

// --- Gap-closing geometry (delete, drag-out, and any other main-track edit) ---

/**
 * The magnet's post-edit pass: after a command has run, close the space it
 * freed on the MAIN track and slide the survivors (plus their linked partners)
 * left, as part of the same undo step.
 *
 * The before/after main tracks are compared span by span:
 * - an element that left the main track (deleted, or dragged to another lane)
 *   frees its whole old span;
 * - an element that MOVED within main (same duration, new start) frees its old
 *   span and OWNS its new one, and is itself never slid: the user just put it
 *   there. This is the rule that makes a ripple-insert or an already-rippling
 *   command (`RemoveRangesCommand`, a Director apply) a no-op here instead of
 *   shifting everything a second time;
 * - a trim frees the head or tail it gave back;
 * - a newly added element owns its span and is never slid.
 *
 * Freed space that something else now occupies is not freed at all, so the
 * whole pass reduces to "gaps this edit actually opened on main".
 */
export function computeMagnetGapShifts({
	beforeTracks,
	afterTracks,
}: {
	beforeTracks: SceneTracks;
	afterTracks: SceneTracks;
}): RippleTrimShift[] {
	const before = new Map(
		beforeTracks.main.elements.map((element) => [
			element.id,
			{ start: element.startTime as number, end: elementEnd(element) as number },
		]),
	);
	const after = new Map(
		afterTracks.main.elements.map((element) => [
			element.id,
			{ start: element.startTime as number, end: elementEnd(element) as number },
		]),
	);

	const vacated: Interval[] = [];
	const occupied: Interval[] = [];
	/** Elements this edit placed itself; the magnet leaves them where they are. */
	const settled = new Set<string>();

	for (const [id, beforeSpan] of before) {
		const afterSpan = after.get(id);
		if (!afterSpan) {
			pushInterval({ intervals: vacated, ...beforeSpan });
			continue;
		}
		const movedWhole =
			afterSpan.start !== beforeSpan.start &&
			afterSpan.end - afterSpan.start === beforeSpan.end - beforeSpan.start;
		if (movedWhole) {
			pushInterval({ intervals: vacated, ...beforeSpan });
			pushInterval({ intervals: occupied, ...afterSpan });
			settled.add(id);
			continue;
		}
		if (afterSpan.end < beforeSpan.end) {
			pushInterval({
				intervals: vacated,
				start: afterSpan.end,
				end: beforeSpan.end,
			});
		} else if (afterSpan.end > beforeSpan.end) {
			pushInterval({
				intervals: occupied,
				start: beforeSpan.end,
				end: afterSpan.end,
			});
		}
		if (afterSpan.start > beforeSpan.start) {
			pushInterval({
				intervals: vacated,
				start: beforeSpan.start,
				end: afterSpan.start,
			});
		} else if (afterSpan.start < beforeSpan.start) {
			pushInterval({
				intervals: occupied,
				start: afterSpan.start,
				end: beforeSpan.start,
			});
		}
	}

	for (const [id, afterSpan] of after) {
		if (before.has(id)) continue;
		pushInterval({ intervals: occupied, ...afterSpan });
		settled.add(id);
	}

	const freed = subtractIntervals({
		sourceIntervals: mergeIntervals(vacated),
		removedIntervals: mergeIntervals(occupied),
	});
	if (freed.length === 0) return [];

	return buildGapShifts({ tracks: afterTracks, freed, settled });
}

function buildGapShifts({
	tracks,
	freed,
	settled,
}: {
	tracks: SceneTracks;
	freed: Interval[];
	settled: ReadonlySet<string>;
}): RippleTrimShift[] {
	const shifts: RippleTrimShift[] = [];
	const claimed = new Set<string>();

	for (const element of tracks.main.elements) {
		if (settled.has(element.id)) continue;
		let shiftAmount = 0;
		for (const interval of freed) {
			if ((element.startTime as number) >= interval.end) {
				shiftAmount += interval.end - interval.start;
			}
		}
		if (shiftAmount === 0) continue;

		const delta = mediaTime({ ticks: -shiftAmount });
		claimed.add(element.id);
		shifts.push({
			trackId: tracks.main.id,
			elementId: element.id,
			newStartTime: addMediaTime({ a: element.startTime, b: delta }),
		});

		for (const partner of findLinkedPartners({
			ref: { trackId: tracks.main.id, elementId: element.id },
			tracks,
			mode: "timeline",
		})) {
			if (claimed.has(partner.elementId)) continue;
			const partnerElement = findElement({
				tracks,
				elementId: partner.elementId,
			});
			if (!partnerElement) continue;
			claimed.add(partner.elementId);
			shifts.push({
				trackId: partner.trackId,
				elementId: partner.elementId,
				newStartTime: addMediaTime({ a: partnerElement.startTime, b: delta }),
			});
		}
	}

	return shifts;
}

/**
 * Write precomputed shifts straight onto a track set. Deliberately NOT routed
 * through the update pipeline: a system shift is not a user placement, so it
 * must not re-trigger main-track head gravity and snap a clip to zero (same
 * reasoning as `RippleShiftElementsCommand`).
 */
export function applyMagnetShifts({
	tracks,
	shifts,
}: {
	tracks: SceneTracks;
	shifts: readonly RippleTrimShift[];
}): SceneTracks {
	if (shifts.length === 0) return tracks;
	const newStartById = new Map(
		shifts.map((shift) => [shift.elementId, shift.newStartTime]),
	);
	const shiftTrack = <TTrack extends { elements: TimelineElement[] }>(
		track: TTrack,
	): TTrack => ({
		...track,
		elements: track.elements.map((element) => {
			const newStartTime = newStartById.get(element.id);
			return newStartTime === undefined
				? element
				: { ...element, startTime: newStartTime };
		}),
	});
	return {
		overlay: tracks.overlay.map((track) => shiftTrack(track)),
		main: shiftTrack(tracks.main),
		audio: tracks.audio.map((track) => shiftTrack(track)),
	};
}

// --- Interval helpers (local, so the cross-track ripple diff stays untouched) ---

function pushInterval({
	intervals,
	start,
	end,
}: {
	intervals: Interval[];
	start: number;
	end: number;
}): void {
	if (end <= start) return;
	intervals.push({ start, end });
}

function mergeIntervals(intervals: Interval[]): Interval[] {
	const sorted = [...intervals].sort((a, b) => a.start - b.start);
	const merged: Interval[] = [];
	for (const interval of sorted) {
		const previous = merged[merged.length - 1];
		if (previous && interval.start <= previous.end) {
			previous.end = Math.max(previous.end, interval.end);
			continue;
		}
		merged.push({ ...interval });
	}
	return merged;
}

function subtractIntervals({
	sourceIntervals,
	removedIntervals,
}: {
	sourceIntervals: Interval[];
	removedIntervals: Interval[];
}): Interval[] {
	let remaining = sourceIntervals;
	for (const removed of removedIntervals) {
		const next: Interval[] = [];
		for (const interval of remaining) {
			if (removed.end <= interval.start || removed.start >= interval.end) {
				next.push(interval);
				continue;
			}
			pushInterval({
				intervals: next,
				start: interval.start,
				end: removed.start,
			});
			pushInterval({ intervals: next, start: removed.end, end: interval.end });
		}
		remaining = next;
		if (remaining.length === 0) return [];
	}
	return remaining;
}
