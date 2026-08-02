/**
 * T19.3: the transition MODEL - boundary enumeration, duration clamping and the
 * survive/die reconciler. Pure functions over plain track/element data so the
 * whole rule set is unit-testable without a renderer or a store.
 */

import type {
	ImageElement,
	SceneTracks,
	TimelineElement,
	VideoElement,
	VideoTrack,
} from "@/timeline/types";
import { mediaTimeToSeconds, type MediaTime } from "@/wasm";
import {
	MAX_TRANSITION_DURATION_SEC,
	MIN_TRANSITION_DURATION_SEC,
	TRANSITION_KIND_INFO,
	type TransitionField,
	type TransitionKind,
	type TransitionSpec,
} from "./types";

/** The element types that can sit on the main track and carry a transition. */
export type TransitionCapableElement = VideoElement | ImageElement;

export function isTransitionCapableElement(
	element: TimelineElement,
): element is TransitionCapableElement {
	return element.type === "video" || element.type === "image";
}

export type TransitionBoundaryKind = "join" | "openHead" | "openTail";

export interface TransitionBoundary {
	/** Stable identity for React keys and tests. */
	key: string;
	kind: TransitionBoundaryKind;
	/** Absolute timeline ticks of the cut this boundary sits on. */
	timeTicks: number;
	leftElementId: string | null;
	rightElementId: string | null;
	/** Element that stores the spec, and the field it stores it in. */
	ownerElementId: string;
	ownerField: TransitionField;
	spec: TransitionSpec | null;
	/**
	 * Longest duration this boundary accepts. `min(neighbour durations) / 2`
	 * for a join, `own duration / 2` for an open head/tail, capped by
	 * MAX_TRANSITION_DURATION_SEC.
	 */
	maxDurationSec: number;
	allowedKinds: TransitionKind[];
}

const JOIN_KINDS: TransitionKind[] = [
	"crossDissolve",
	"dipToBlack",
	"dipToWhite",
];
const OPEN_KINDS: TransitionKind[] = ["fade"];

function sortByStartTime(
	elements: readonly TimelineElement[],
): TimelineElement[] {
	return elements.slice().sort((a, b) => {
		if (a.startTime !== b.startTime) return a.startTime - b.startTime;
		return a.id.localeCompare(b.id);
	});
}

function elementEnd(element: TimelineElement): number {
	return element.startTime + element.duration;
}

/** Ticks are integers, so abutting is exact equality - no epsilon needed. */
function abuts({
	left,
	right,
}: {
	left: TimelineElement;
	right: TimelineElement;
}): boolean {
	return elementEnd(left) === right.startTime;
}

function readSpec({
	element,
	field,
}: {
	element: TimelineElement;
	field: TransitionField;
}): TransitionSpec | null {
	if (!isTransitionCapableElement(element)) return null;
	const spec = element[field];
	return spec ?? null;
}

function halfDurationSec({ ticks }: { ticks: MediaTime }): number {
	return mediaTimeToSeconds({ time: ticks }) / 2;
}

function capMax({ seconds }: { seconds: number }): number {
	return Math.min(MAX_TRANSITION_DURATION_SEC, seconds);
}

/**
 * Every boundary on a track, left to right. A JOIN is emitted once, from the
 * RIGHT element's head (that is where the spec lives). A clip with no abutting
 * left neighbour also yields an `openHead`, and one with no abutting right
 * neighbour an `openTail`.
 */
export function collectTransitionBoundaries({
	elements,
}: {
	elements: readonly TimelineElement[];
}): TransitionBoundary[] {
	const sorted = sortByStartTime(elements).filter(isTransitionCapableElement);
	const boundaries: TransitionBoundary[] = [];

	for (let index = 0; index < sorted.length; index += 1) {
		const element = sorted[index];
		const previous = index > 0 ? sorted[index - 1] : null;
		const next = index + 1 < sorted.length ? sorted[index + 1] : null;

		if (previous && abuts({ left: previous, right: element })) {
			boundaries.push({
				key: `join:${previous.id}:${element.id}`,
				kind: "join",
				timeTicks: element.startTime,
				leftElementId: previous.id,
				rightElementId: element.id,
				ownerElementId: element.id,
				ownerField: "transitionIn",
				spec: readSpec({ element, field: "transitionIn" }),
				maxDurationSec: capMax({
					seconds: Math.min(
						halfDurationSec({ ticks: previous.duration }),
						halfDurationSec({ ticks: element.duration }),
					),
				}),
				allowedKinds: JOIN_KINDS,
			});
		} else {
			boundaries.push({
				key: `head:${element.id}`,
				kind: "openHead",
				timeTicks: element.startTime,
				leftElementId: null,
				rightElementId: element.id,
				ownerElementId: element.id,
				ownerField: "transitionIn",
				spec: readSpec({ element, field: "transitionIn" }),
				maxDurationSec: capMax({
					seconds: halfDurationSec({ ticks: element.duration }),
				}),
				allowedKinds: OPEN_KINDS,
			});
		}

		if (!next || !abuts({ left: element, right: next })) {
			boundaries.push({
				key: `tail:${element.id}`,
				kind: "openTail",
				timeTicks: elementEnd(element),
				leftElementId: element.id,
				rightElementId: null,
				ownerElementId: element.id,
				ownerField: "transitionOut",
				spec: readSpec({ element, field: "transitionOut" }),
				maxDurationSec: capMax({
					seconds: halfDurationSec({ ticks: element.duration }),
				}),
				allowedKinds: OPEN_KINDS,
			});
		}
	}

	return boundaries;
}

export function findTransitionBoundary({
	elements,
	key,
}: {
	elements: readonly TimelineElement[];
	key: string;
}): TransitionBoundary | null {
	return (
		collectTransitionBoundaries({ elements }).find(
			(boundary) => boundary.key === key,
		) ?? null
	);
}

/**
 * Model-level duration clamp: `[MIN, boundary.maxDurationSec]`.
 *
 * NOTE on source headroom: the round-19 plan also mentions clamping a
 * crossDissolve to the neighbours' trimmed-away source headroom. That is
 * deliberately NOT a hard clamp here. A hard headroom clamp would make an
 * applied duration silently shrink and grow while the user trims, and the
 * renderer already has a correct answer for a side with no headroom: it HOLDS
 * the edge frame (see `clampTransitionSourceTicks`). Headroom is therefore
 * advisory - `describeTransitionHeadroom` reports it so the picker can say a
 * side will freeze, and the sampling clamp guarantees a renderable result
 * either way.
 */
export function clampTransitionDurationSec({
	requestedSec,
	maxDurationSec,
}: {
	requestedSec: number;
	maxDurationSec: number;
}): number {
	if (!Number.isFinite(requestedSec)) return MIN_TRANSITION_DURATION_SEC;
	const ceiling = Math.min(MAX_TRANSITION_DURATION_SEC, maxDurationSec);
	if (ceiling <= MIN_TRANSITION_DURATION_SEC) return MIN_TRANSITION_DURATION_SEC;
	return Math.min(Math.max(requestedSec, MIN_TRANSITION_DURATION_SEC), ceiling);
}

/** A boundary too short to hold even the minimum offers no transition. */
export function canBoundaryHoldTransition({
	boundary,
}: {
	boundary: TransitionBoundary;
}): boolean {
	return boundary.maxDurationSec >= MIN_TRANSITION_DURATION_SEC;
}

export interface TransitionHeadroom {
	/** Seconds of trimmed-away source past the left clip's out point. */
	leftSec: number;
	/** Seconds of trimmed-away source before the right clip's in point. */
	rightSec: number;
	/** True when that side must hold its edge frame instead of sampling. */
	leftEdgeHold: boolean;
	rightEdgeHold: boolean;
}

/**
 * How much real source each side of a crossDissolve can reach into. An IMAGE
 * has no time axis at all, so it never edge-holds (a still is its own edge
 * frame) - it reports infinite headroom.
 */
export function describeTransitionHeadroom({
	left,
	right,
	durationSec,
}: {
	left: TransitionCapableElement | null;
	right: TransitionCapableElement | null;
	durationSec: number;
}): TransitionHeadroom {
	const neededSec = durationSec / 2;
	const headroomOf = ({
		element,
		side,
	}: {
		element: TransitionCapableElement | null;
		side: "trimEnd" | "trimStart";
	}): number => {
		if (!element) return 0;
		if (element.type === "image") return Number.POSITIVE_INFINITY;
		return mediaTimeToSeconds({ time: element[side] });
	};

	const leftSec = headroomOf({ element: left, side: "trimEnd" });
	const rightSec = headroomOf({ element: right, side: "trimStart" });
	return {
		leftSec,
		rightSec,
		leftEdgeHold: leftSec < neededSec,
		rightEdgeHold: rightSec < neededSec,
	};
}

function specSurvives({
	boundary,
	spec,
}: {
	boundary: TransitionBoundary;
	spec: TransitionSpec;
}): boolean {
	const info = TRANSITION_KIND_INFO[spec.kind];
	if (!info) return false;
	if (info.requiresJoin !== (boundary.kind === "join")) return false;
	return canBoundaryHoldTransition({ boundary });
}

function withField({
	element,
	field,
	spec,
}: {
	element: TransitionCapableElement;
	field: TransitionField;
	spec: TransitionSpec | null;
}): TransitionCapableElement {
	if (spec) {
		return { ...element, [field]: spec };
	}
	const next = { ...element };
	delete next[field];
	return next;
}

/**
 * THE SURVIVE/DIE PASS. Run at the single track-swap chokepoint
 * (`TimelineManager.updateTracks`), so every edit path - delete, move, ripple,
 * magnet, trim, drag-drop - gets the rules without knowing they exist:
 *
 *   - a spec whose boundary no longer exists (its join died) is dropped;
 *   - a spec whose kind no longer matches the boundary shape (a join became an
 *     open end, or an open end became a join) is dropped;
 *   - a spec longer than the boundary now allows is clamped down (trim);
 *   - a spec on a track that is not the main track is dropped (transitions are
 *     a main-track feature; moving a clip up to an overlay lane kills it).
 *
 * Returns the SAME object identity when nothing changed, so it is free to call
 * on every commit.
 */
export function reconcileTrackTransitions<
	TTrack extends { id: string; elements: TimelineElement[] },
>({ track }: { track: TTrack }): TTrack {
	const boundaries = collectTransitionBoundaries({ elements: track.elements });
	const byOwner = new Map<string, TransitionBoundary>();
	for (const boundary of boundaries) {
		byOwner.set(`${boundary.ownerElementId}:${boundary.ownerField}`, boundary);
	}

	let changed = false;
	const elements = track.elements.map((element) => {
		if (!isTransitionCapableElement(element)) return element;
		if (!element.transitionIn && !element.transitionOut) return element;

		let next: TransitionCapableElement = element;
		for (const field of ["transitionIn", "transitionOut"] as const) {
			const spec = element[field];
			if (!spec) continue;

			const boundary = byOwner.get(`${element.id}:${field}`);
			if (!boundary || !specSurvives({ boundary, spec })) {
				next = withField({ element: next, field, spec: null });
				changed = true;
				continue;
			}

			const clamped = clampTransitionDurationSec({
				requestedSec: spec.durationSec,
				maxDurationSec: boundary.maxDurationSec,
			});
			if (clamped !== spec.durationSec) {
				next = withField({
					element: next,
					field,
					spec: { ...spec, durationSec: clamped },
				});
				changed = true;
			}
		}

		return next;
	});

	return changed ? ({ ...track, elements } as TTrack) : track;
}

function stripTransitions<
	TTrack extends { elements: TimelineElement[] },
>({ track }: { track: TTrack }): TTrack {
	let changed = false;
	const elements = track.elements.map((element) => {
		if (!isTransitionCapableElement(element)) return element;
		if (!element.transitionIn && !element.transitionOut) return element;
		changed = true;
		const next = { ...element };
		delete next.transitionIn;
		delete next.transitionOut;
		return next;
	});
	return changed ? ({ ...track, elements } as TTrack) : track;
}

/**
 * Scene-level wrapper: reconcile the main track, strip transitions anywhere
 * else. Identity-stable when nothing changed.
 */
export function reconcileSceneTransitions({
	tracks,
}: {
	tracks: SceneTracks;
}): SceneTracks {
	const main = reconcileTrackTransitions({ track: tracks.main }) as VideoTrack;
	let overlayChanged = false;
	const overlay = tracks.overlay.map((track) => {
		const next = stripTransitions({ track });
		if (next !== track) overlayChanged = true;
		return next;
	});

	if (main === tracks.main && !overlayChanged) {
		return tracks;
	}
	return { ...tracks, main, overlay };
}
