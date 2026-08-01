import type { MouseEvent as ReactMouseEvent } from "react";
import { BASE_TIMELINE_PIXELS_PER_SECOND } from "@/timeline/scale";
import {
	addMediaTime,
	maxMediaTime,
	type MediaTime,
	mediaTime,
	minMediaTime,
	subMediaTime,
	TICKS_PER_SECOND,
	ZERO_MEDIA_TIME,
} from "@/wasm";
import {
	computeLinkedResize,
	getGroupClampReason,
	getMinDurationForFps,
	type ClampReason,
	type GroupResizeMember,
	type GroupResizeResult,
	type GroupResizeUpdate,
	type ResizeSide,
} from "@/timeline/group-resize";
import { findLinkedPartners } from "@/timeline/link-elements";
import {
	collectRippleTrimTargets,
	computeRippleShrinkFloor,
	liftShiftingNeighborBounds,
	shiftRippleTrimTargets,
	type RippleTrimCommit,
	type RippleTrimTarget,
} from "@/timeline/ripple-trim";
import {
	collectMagnetTrimTargets,
	computeMagnetShrinkFloor,
	liftMagnetNeighborBounds,
	magnetShrinkCeiling,
} from "@/timeline/magnet";
import { useTimelineStore } from "@/timeline/timeline-store";
import {
	buildTimelineSnapPoints,
	getTimelineSnapThresholdInTicks,
	resolveTimelineSnap,
	type SnapPoint,
} from "@/timeline/snapping";
import { getElementEdgeSnapPoints } from "@/timeline/element-snap-source";
import {
	lockGestureCursor,
	type GestureCursorLock,
} from "@/timeline/gesture-cursor";
import { getPlayheadSnapPoints } from "@/timeline/playhead-snap-source";
import { getAnimationKeyframeSnapPointsForTimeline } from "@/timeline/animation-snap-points";
import {
	isRetimableElement,
	type SceneTracks,
	type TimelineElement,
	type TimelineTrack,
} from "@/timeline";
import type { ElementRef } from "@/timeline/types";
import type { FrameRate } from "opencut-wasm";

// --- Session ---

interface TrimShiftContext {
	scope: "all-tracks" | "main-track";
	pivotTime: MediaTime;
	shrinkFloorDelta: MediaTime | null;
	shrinkCeilingDelta: MediaTime | null;
	targets: RippleTrimTarget[];
	pinnedStartById: Map<string, MediaTime> | null;
}

interface ResizeSession {
	kind: "active";
	side: ResizeSide;
	startX: number;
	fps: FrameRate;
	members: GroupResizeMember[];
	result: GroupResizeResult | null;
	/**
	 * The auto-shift context for this trim, measured once at mousedown: the
	 * grabbed clip's OLD end (the edit point), the headroom before a shifted
	 * clip would hit one that stays put, and the snapshot of everything that
	 * shifts (so the drag can preview it live). Null = plain neighbor-clamped
	 * trim.
	 *
	 * Two flavors, never both (ripple editing is the superset and wins):
	 * - `"all-tracks"`: ripple editing ON, RIGHT handle only, today's behavior.
	 * - `"main-track"`: magnet ON, EITHER handle, scoped to main-track elements
	 *   and their linked partners. A left-handle magnet trim also PINS each
	 *   member's start (`pinnedStartById`) so the clip slides back and stays
	 *   butted, and shifts downstream by the NEGATED resize delta.
	 */
	rippleTrim: TrimShiftContext | null;
	/** UI-only: the real neighbor ELEMENT on each side of every member, for the
	 * "blocked by neighbor" edge highlight. See `buildNeighborElementIds`. */
	neighborElementIds: Map<string, { left: string | null; right: string | null }>;
}

type Session = { kind: "idle" } | ResizeSession;

// --- Config ---

/**
 * A drag-preview patch: the resized members carry the full four-field resize
 * patch, ripple-shifted downstream elements carry `startTime` only.
 */
export interface ResizePreviewUpdate extends ElementRef {
	patch: Partial<GroupResizeUpdate["patch"]>;
}

/**
 * CapCut-style "why did the edge stop" feedback for the currently active drag.
 * `"dragged"` flashes the grabbed clip's own edge with a reason tooltip
 * (source-limit / min-duration); `"neighbor"` highlights the blocking clip's
 * near edge instead. `null` clears any feedback (drag released, or not
 * currently at a bound).
 */
export type ResizeClampFeedback =
	| { kind: "dragged"; side: ResizeSide; reason: ClampReason; elementId: string }
	| { kind: "neighbor"; side: ResizeSide; neighborElementId: string };

export interface ResizeConfig {
	zoomLevel: number;
	snappingEnabled: boolean;
	isShiftHeld: () => boolean;
	getSceneTracks: () => SceneTracks;
	getCurrentPlayheadTime: () => MediaTime;
	getActiveProjectFps: () => FrameRate | null;
	discardPreview: () => void;
	previewElements: (updates: ResizePreviewUpdate[]) => void;
	commitElements: (
		updates: GroupResizeUpdate[],
		ripple: RippleTrimCommit | null,
	) => void;
	onSnapPointChange?: (snapPoint: SnapPoint | null) => void;
	onClampReasonChange?: (feedback: ResizeClampFeedback | null) => void;
}

export interface ResizeConfigRef {
	readonly current: ResizeConfig;
}

// --- Pure helpers ---

export function buildResizeMembers({
	tracks,
	selectedElements,
}: {
	tracks: SceneTracks;
	selectedElements: ElementRef[];
}): GroupResizeMember[] {
	const selectedElementIds = new Set(
		selectedElements.map((el) => el.elementId),
	);
	const trackMap = new Map(
		[...tracks.overlay, tracks.main, ...tracks.audio].map((track) => [
			track.id,
			track,
		]),
	);

	return selectedElements.flatMap(({ trackId, elementId }) => {
		const track = trackMap.get(trackId);
		const element = track?.elements.find((el) => el.id === elementId);
		if (!track || !element) return [];

		const otherElements = track.elements.filter(
			(el) => !selectedElementIds.has(el.id),
		);
		const leftNeighborBound = otherElements
			.filter(
				(el) =>
					addMediaTime({ a: el.startTime, b: el.duration }) <=
					element.startTime,
			)
			.reduce<MediaTime | null>((bound, el) => {
				const elementEnd = addMediaTime({
					a: el.startTime,
					b: el.duration,
				});
				return bound === null
					? elementEnd
					: maxMediaTime({ a: bound, b: elementEnd });
			}, null);
		const rightNeighborBound = otherElements
			.filter(
				(el) =>
					el.startTime >= addMediaTime({ a: element.startTime, b: element.duration }),
			)
			.reduce<MediaTime | null>(
				(bound, el) =>
					bound === null
						? el.startTime
						: minMediaTime({ a: bound, b: el.startTime }),
				null,
			);

		return [
			{
				trackId,
				elementId,
				startTime: element.startTime,
				duration: element.duration,
				trimStart: element.trimStart,
				trimEnd: element.trimEnd,
				sourceDuration: element.sourceDuration,
				// VIDEO/AUDIO always have REAL source footage backing them; a missing
				// sourceDuration on one of those is metadata-not-loaded-yet, not "no
				// limit" (see getResizeBoundBreakdown). Images/text/etc. leave this
				// unset and keep today's free extension.
				sourceDurationRequired:
					element.type === "video" || element.type === "audio",
				retime: isRetimableElement(element) ? element.retime : undefined,
				leftNeighborBound,
				rightNeighborBound,
			},
		];
	});
}

/**
 * The actual neighbor ELEMENT (not just its bound time) on each side of every
 * member, for UI feedback only (highlighting "the blocking clip" when a drag
 * is clamped by a neighbor). Mirrors the same left/right neighbor selection
 * `buildResizeMembers` performs for the bound math above; kept separate so
 * the pure resize-math members stay free of UI-only fields.
 */
function buildNeighborElementIds({
	tracks,
	selectedElements,
}: {
	tracks: SceneTracks;
	selectedElements: ElementRef[];
}): Map<string, { left: string | null; right: string | null }> {
	const selectedElementIds = new Set(
		selectedElements.map((el) => el.elementId),
	);
	const trackMap = new Map(
		[...tracks.overlay, tracks.main, ...tracks.audio].map((track) => [
			track.id,
			track,
		]),
	);

	const result = new Map<string, { left: string | null; right: string | null }>();
	for (const { trackId, elementId } of selectedElements) {
		const track = trackMap.get(trackId);
		const element = track?.elements.find((el) => el.id === elementId);
		if (!track || !element) continue;

		const otherElements = track.elements.filter(
			(el) => !selectedElementIds.has(el.id),
		);

		let left: { id: string; end: MediaTime } | null = null;
		for (const el of otherElements) {
			const end = addMediaTime({ a: el.startTime, b: el.duration });
			if (end <= element.startTime && (left === null || end > left.end)) {
				left = { id: el.id, end };
			}
		}

		const elementEnd = addMediaTime({
			a: element.startTime,
			b: element.duration,
		});
		let right: { id: string; start: MediaTime } | null = null;
		for (const el of otherElements) {
			if (
				el.startTime >= elementEnd &&
				(right === null || el.startTime < right.start)
			) {
				right = { id: el.id, start: el.startTime };
			}
		}

		result.set(elementId, { left: left?.id ?? null, right: right?.id ?? null });
	}
	return result;
}

/**
 * The magnet's trim context: everything on the MAIN track at/after the edit
 * point plus those clips' linked partners, and the headroom before a shifted
 * clip would land on one that stays put. A LEFT handle additionally pins the
 * members' starts, so the trimmed clip stays butted to its left neighbor and
 * the whole tail slides by the negated delta instead.
 */
function buildMagnetTrimSession({
	tracks,
	side,
	pivotTime,
	members,
	memberElementIds,
}: {
	tracks: SceneTracks;
	side: ResizeSide;
	pivotTime: MediaTime;
	members: GroupResizeMember[];
	memberElementIds: ReadonlySet<string>;
}): TrimShiftContext {
	const targets = collectMagnetTrimTargets({
		tracks,
		pivotTime,
		excludeElementIds: memberElementIds,
	});
	const shrinkFloorDelta = computeMagnetShrinkFloor({
		tracks,
		excludeElementIds: memberElementIds,
		shiftingElementIds: new Set(targets.map((target) => target.elementId)),
	});
	return {
		scope: "main-track",
		pivotTime,
		shrinkFloorDelta: side === "right" ? shrinkFloorDelta : null,
		shrinkCeilingDelta:
			side === "left" ? magnetShrinkCeiling(shrinkFloorDelta) : null,
		targets,
		pinnedStartById:
			side === "left"
				? new Map(members.map((member) => [member.elementId, member.startTime]))
				: null,
	};
}

/** Relax the bounds the pending auto-shift makes irrelevant (see
 * `liftShiftingNeighborBounds` / `liftMagnetNeighborBounds`); a plain trim
 * keeps every member's bounds exactly as measured. */
function applyTrimBounds({
	members,
	side,
	rippleTrim,
	neighborElementIds,
}: {
	members: GroupResizeMember[];
	side: ResizeSide;
	rippleTrim: TrimShiftContext | null;
	neighborElementIds: ReadonlyMap<
		string,
		{ left: string | null; right: string | null }
	>;
}): GroupResizeMember[] {
	if (!rippleTrim) return members;
	if (rippleTrim.scope === "all-tracks") {
		return liftShiftingNeighborBounds({
			members,
			pivotTime: rippleTrim.pivotTime,
		});
	}
	return liftMagnetNeighborBounds({
		members,
		side,
		shiftingElementIds: new Set(
			rippleTrim.targets.map((target) => target.elementId),
		),
		neighborElementIds,
	});
}

/** Magnet LEFT trims write each member's committed start straight back over
 * the resize patch: the head trim changes the clip's content, never its
 * position, and the gap it would have opened is closed by the tail shift. */
function pinMemberStarts({
	updates,
	pinnedStartById,
}: {
	updates: GroupResizeUpdate[];
	pinnedStartById: Map<string, MediaTime> | null;
}): GroupResizeUpdate[] {
	if (!pinnedStartById) return updates;
	return updates.map((update) => {
		const pinnedStart = pinnedStartById.get(update.elementId);
		return pinnedStart === undefined
			? update
			: { ...update, patch: { ...update.patch, startTime: pinnedStart } };
	});
}

/** The direction downstream material moves for the current drag: a right-hand
 * trim carries the resize delta as-is, a magnet left trim negates it. */
function trimShiftDelta({
	side,
	deltaTime,
}: {
	side: ResizeSide;
	deltaTime: MediaTime;
}): MediaTime {
	return side === "left"
		? subMediaTime({ a: ZERO_MEDIA_TIME, b: deltaTime })
		: deltaTime;
}

function hasResizeChanges({
	members,
	result,
}: {
	members: GroupResizeMember[];
	result: GroupResizeResult;
}): boolean {
	return result.updates.some((update) => {
		const member = members.find((m) => m.elementId === update.elementId);
		return (
			member?.trimStart !== update.patch.trimStart ||
			member?.trimEnd !== update.patch.trimEnd ||
			member?.startTime !== update.patch.startTime ||
			member?.duration !== update.patch.duration
		);
	});
}

// --- Controller ---

export class ResizeController {
	private session: Session = { kind: "idle" };
	// Pins the body cursor to "ew-resize" for the resize's lifetime; released in
	// finishSession (the single funnel for finish/cancel/destroy).
	private cursorLock: GestureCursorLock | null = null;
	private readonly subscribers = new Set<() => void>();
	private readonly configRef: ResizeConfigRef;

	constructor(deps: { configRef: ResizeConfigRef }) {
		this.configRef = deps.configRef;
		this.onResizeStart = this.onResizeStart.bind(this);
		this.handleMouseMove = this.handleMouseMove.bind(this);
		this.handleMouseUp = this.handleMouseUp.bind(this);
	}

	private get config(): ResizeConfig {
		return this.configRef.current;
	}

	get isResizing(): boolean {
		return this.session.kind === "active";
	}

	subscribe(fn: () => void): () => void {
		this.subscribers.add(fn);
		return () => this.subscribers.delete(fn);
	}

	cancel(): void {
		this.config.discardPreview();
		this.finishSession();
	}

	destroy(): void {
		this.cursorLock?.release();
		this.cursorLock = null;
		this.deactivate();
		this.subscribers.clear();
	}

	onResizeStart({
		event,
		element,
		track,
		side,
	}: {
		event: ReactMouseEvent;
		element: TimelineElement;
		track: TimelineTrack;
		side: ResizeSide;
	}): void {
		event.stopPropagation();
		event.preventDefault();

		// UI should prevent this, but be explicit: a new resize start
		// means the previous one is abandoned, not silently replaced.
		if (this.session.kind === "active") this.cancel();

		const fps = this.config.getActiveProjectFps();
		if (!fps) return;

		// Linked trim (Dan's fork, 2026-07-17): with linked selection ON, a trim
		// resizes the grabbed clip AND its linked partners (a video + its
		// separated audio) as one gesture; Alt on the handle trims just the
		// grabbed clip. Scope is strictly linked partners (findLinkedPartners,
		// timeline mode), NEVER the arbitrary multi-selection: the U2 / OQ2
		// no-group-resize decision stands for multi-select. The whole member set
		// is excluded from neighbor bounds (buildResizeMembers), the drag delta
		// is clamped by the MOST restrictive member (computeLinkedResize), and
		// the commit is one UpdateElementsCommand, so one undo reverts the pair.
		const ref = { trackId: track.id, elementId: element.id };
		const tracks = this.config.getSceneTracks();
		const linkedRefs =
			!event.altKey && useTimelineStore.getState().linkedSelectionEnabled
				? findLinkedPartners({ ref, tracks, mode: "timeline" })
				: [];

		const members = buildResizeMembers({
			tracks,
			selectedElements: [ref, ...linkedRefs],
		});
		if (members.length === 0) return;

		// Cross-track ripple trim (Dan's fork): with ripple editing ON, a RIGHT
		// handle drag shifts all downstream material at commit, so shifting
		// neighbors stop clamping the extend (a neighbor parked before the edit
		// point still binds) and the shrink is floored by the tightest track's
		// straddler headroom, both measured once at mousedown.
		//
		// Magnetic main track (T15.2) is the same machinery scoped to the main
		// track plus linked partners, on BOTH handles. Ripple editing is the
		// cross-track superset, so it takes precedence and the magnet stands
		// down whenever both toggles are on - that is what stops anything from
		// being shifted twice.
		const pivotTime = addMediaTime({
			a: element.startTime,
			b: element.duration,
		});
		const memberElementIds = new Set(
			members.map((member) => member.elementId),
		);
		const neighborElementIds = buildNeighborElementIds({
			tracks,
			selectedElements: [ref, ...linkedRefs],
		});
		const timelineState = useTimelineStore.getState();
		const rippleTrim =
			side === "right" && timelineState.rippleEditingEnabled
				? {
						scope: "all-tracks" as const,
						pivotTime,
						shrinkFloorDelta: computeRippleShrinkFloor({
							tracks,
							pivotTime,
							excludeElementIds: memberElementIds,
						}),
						shrinkCeilingDelta: null,
						targets: collectRippleTrimTargets({
							tracks,
							pivotTime,
							excludeElementIds: memberElementIds,
						}),
						pinnedStartById: null,
					}
				: !timelineState.rippleEditingEnabled &&
						timelineState.mainTrackMagnetEnabled &&
						members.some((member) => member.trackId === tracks.main.id)
					? buildMagnetTrimSession({
							tracks,
							side,
							pivotTime,
							members,
							memberElementIds,
						})
					: null;

		this.config.discardPreview();

		this.session = {
			kind: "active",
			side,
			startX: event.clientX,
			fps,
			members: applyTrimBounds({
				members,
				side,
				rippleTrim,
				neighborElementIds,
			}),
			result: null,
			rippleTrim,
			neighborElementIds,
		};
		this.cursorLock = lockGestureCursor({ cursor: "ew-resize" });
		this.activate();
		this.notify();
	}

	private activate(): void {
		document.addEventListener("mousemove", this.handleMouseMove);
		document.addEventListener("mouseup", this.handleMouseUp);
	}

	private deactivate(): void {
		document.removeEventListener("mousemove", this.handleMouseMove);
		document.removeEventListener("mouseup", this.handleMouseUp);
	}

	private notify(): void {
		for (const fn of this.subscribers) fn();
	}

	private finishSession(): void {
		this.session = { kind: "idle" };
		this.cursorLock?.release();
		this.cursorLock = null;
		this.deactivate();
		this.config.onSnapPointChange?.(null);
		this.config.onClampReasonChange?.(null);
		this.notify();
	}

	private snappedDelta({
		session,
		rawDeltaTime,
	}: {
		session: ResizeSession;
		rawDeltaTime: MediaTime;
	}): MediaTime {
		const { snappingEnabled, isShiftHeld, zoomLevel } = this.config;

		if (!snappingEnabled || isShiftHeld()) {
			this.config.onSnapPointChange?.(null);
			return rawDeltaTime;
		}

		const tracks = this.config.getSceneTracks();
		const playheadTime = this.config.getCurrentPlayheadTime();
		const excludeElementIds = new Set(session.members.map((m) => m.elementId));

		const snapPoints = buildTimelineSnapPoints({
			sources: [
				() => getElementEdgeSnapPoints({ tracks, excludeElementIds }),
				() => getPlayheadSnapPoints({ playheadTime }),
				() =>
					getAnimationKeyframeSnapPointsForTimeline({
						tracks,
						excludeElementIds,
					}),
			],
		});
		const maxSnapDistance = getTimelineSnapThresholdInTicks({ zoomLevel });

		let closestSnapPoint: SnapPoint | null = null;
		let closestSnapDistance = Infinity;
		let deltaTime = rawDeltaTime;

		for (const member of session.members) {
			const baseEdgeTime =
				session.side === "left"
					? member.startTime
					: addMediaTime({ a: member.startTime, b: member.duration });
			const snapResult = resolveTimelineSnap({
				targetTime: addMediaTime({ a: baseEdgeTime, b: rawDeltaTime }),
				snapPoints,
				maxSnapDistance,
			});
			if (
				snapResult.snapPoint &&
				snapResult.snapDistance < closestSnapDistance
			) {
				closestSnapDistance = snapResult.snapDistance;
				closestSnapPoint = snapResult.snapPoint;
				deltaTime = subMediaTime({ a: snapResult.snappedTime, b: baseEdgeTime });
			}
		}

		this.config.onSnapPointChange?.(closestSnapPoint);
		return deltaTime;
	}

	/**
	 * CapCut-style "why did the edge stop" feedback for the current drag
	 * position: `requestedDeltaTime` is the (snapped, pre-clamp) delta the user
	 * is asking for; when it exceeds the group's bound, classify why via
	 * `getGroupClampReason` (same bound math `computeLinkedResize` enforces)
	 * and resolve WHICH element to decorate. A "neighbor" reason with no real
	 * neighbor element (the timeline-zero wall, side "left" with nothing to
	 * its left) falls back to flashing the dragged edge instead of showing
	 * nothing, since the whole point of this feature is that a stuck drag
	 * never goes silent.
	 */
	private computeClampFeedback({
		session,
		requestedDeltaTime,
	}: {
		session: ResizeSession;
		requestedDeltaTime: MediaTime;
	}): ResizeClampFeedback | null {
		const clamp = getGroupClampReason({
			members: session.members,
			side: session.side,
			requestedDeltaTime,
			minDuration: getMinDurationForFps(session.fps),
			rippleShrinkFloorDelta: session.rippleTrim?.shrinkFloorDelta ?? null,
			magnetShrinkCeilingDelta:
				session.rippleTrim?.shrinkCeilingDelta ?? null,
		});
		if (!clamp) return null;

		const draggedElementId = session.members[0].elementId;
		if (clamp.reason === "neighbor") {
			const neighborElementId =
				session.neighborElementIds.get(clamp.elementId)?.[session.side] ??
				null;
			if (neighborElementId) {
				return { kind: "neighbor", side: session.side, neighborElementId };
			}
		}
		return {
			kind: "dragged",
			side: session.side,
			reason: clamp.reason,
			elementId: draggedElementId,
		};
	}

	private handleMouseMove({ clientX }: MouseEvent): void {
		if (this.session.kind !== "active") return;
		const session = this.session;

		const rawDeltaTime = mediaTime({
			ticks: Math.round(
				((clientX - session.startX) /
					(BASE_TIMELINE_PIXELS_PER_SECOND * this.config.zoomLevel)) *
					TICKS_PER_SECOND,
			),
		});
		const deltaTime = this.snappedDelta({ session, rawDeltaTime });
		const result = computeLinkedResize({
			members: session.members,
			side: session.side,
			deltaTime,
			fps: session.fps,
			...(session.rippleTrim
				? {
						rippleTrim: {
							shrinkFloorDelta: session.rippleTrim.shrinkFloorDelta,
							shrinkCeilingDelta: session.rippleTrim.shrinkCeilingDelta,
						},
					}
				: {}),
		});

		const memberUpdates = pinMemberStarts({
			updates: result.updates,
			pinnedStartById: session.rippleTrim?.pinnedStartById ?? null,
		});
		session.result = { deltaTime: result.deltaTime, updates: memberUpdates };
		this.config.onClampReasonChange?.(
			this.computeClampFeedback({ session, requestedDeltaTime: deltaTime }),
		);
		// Ripple/magnet live preview: the shifted clips move on screen during the
		// drag instead of jumping at commit. Emitted even at zero delta, so a drag
		// back to the origin overwrites stale shifted overlay positions.
		const previewUpdates: ResizePreviewUpdate[] = session.rippleTrim
			? [
					...memberUpdates,
					...shiftRippleTrimTargets({
						targets: session.rippleTrim.targets,
						deltaTime: trimShiftDelta({
							side: session.side,
							deltaTime: result.deltaTime,
						}),
					}).map(({ trackId, elementId, newStartTime }) => ({
						trackId,
						elementId,
						patch: { startTime: newStartTime },
					})),
				]
			: memberUpdates;
		this.config.previewElements(previewUpdates);
	}

	private handleMouseUp(): void {
		if (this.session.kind !== "active") return;
		const session = this.session;

		this.config.discardPreview();

		if (
			session.result &&
			hasResizeChanges({ members: session.members, result: session.result })
		) {
			const ripple: RippleTrimCommit | null =
				session.rippleTrim && session.result.deltaTime !== 0
					? {
							pivotTime: session.rippleTrim.pivotTime,
							deltaTime: trimShiftDelta({
								side: session.side,
								deltaTime: session.result.deltaTime,
							}),
							excludeElementIds: new Set(
								session.members.map((member) => member.elementId),
							),
							scope: session.rippleTrim.scope,
						}
					: null;
			this.config.commitElements(session.result.updates, ripple);
		}

		this.finishSession();
	}
}
