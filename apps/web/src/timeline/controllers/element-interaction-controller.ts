import type { MouseEvent as ReactMouseEvent } from "react";
import {
	buildMoveGroup,
	resolveGroupMove,
	snapGroupEdges,
	type GroupMoveResult,
	type MoveGroup,
} from "@/timeline/group-move";
import { BASE_TIMELINE_PIXELS_PER_SECOND } from "@/timeline/scale";
import {
	maxMediaTime,
	type MediaTime,
	mediaTime,
	roundFrameTime,
	subMediaTime,
	TICKS_PER_SECOND,
	ZERO_MEDIA_TIME,
} from "@/wasm";
import { TIMELINE_DRAG_THRESHOLD_PX } from "@/timeline/components/interaction";
import type { FrameRate } from "opencut-wasm";
import { computeDropTarget } from "@/timeline/components/drop-target";
import { getMouseTimeFromClientX } from "@/timeline/drag-utils";
import { generateUUID } from "@/utils/id";
import { useTimelineStore } from "@/timeline/timeline-store";
import { expandSelectionWithLinks } from "@/timeline/link-elements";
import { usePlaceToolStore } from "@/preview/place-tool-store";
import { computeSlipTarget } from "@/timeline/trim-tools/slip";
import { isRetimableElement } from "@/timeline";
import type { SnapPoint } from "@/timeline/snapping";
import type {
	Bookmark,
	DropTarget,
	ElementRef,
	ElementDragView,
	SceneTracks,
	TimelineElement,
	TimelineTrack,
} from "@/timeline";

const MOUSE_BUTTON_RIGHT = 2;

// --- Config ---

export interface ViewportAdapter {
	getZoomLevel: () => number;
	getTracksScrollEl: () => HTMLDivElement | null;
	getTracksContainerEl: () => HTMLDivElement | null;
	getHeaderEl: () => HTMLElement | null;
}

export interface InputAdapter {
	isShiftHeld: () => boolean;
}

export interface SceneReader {
	getTracks: () => SceneTracks;
	getBookmarks: () => Bookmark[];
	getActiveFps: () => FrameRate | null;
}

export interface ElementSelectionApi {
	getSelected: () => readonly ElementRef[];
	isSelected: (ref: ElementRef) => boolean;
	select: (ref: ElementRef) => void;
	selectMany: (refs: ElementRef[]) => void;
	handleClick: (args: ElementRef & { isMultiKey: boolean }) => void;
	clearKeyframeSelection: () => void;
}

export interface PlaybackReader {
	getCurrentTime: () => MediaTime;
}

/** A trim-only patch the Slip body-drag emits (startTime/duration unchanged). */
export interface SlipTrimPatch {
	trackId: string;
	elementId: string;
	trimStart: MediaTime;
	trimEnd: MediaTime;
}

export interface TimelineOps {
	moveElements: (args: Pick<GroupMoveResult, "moves" | "createTracks">) => void;
	// Slip body-drag preview/commit path (mirrors the resize-controller's). Slip
	// changes only the source window, so these carry trim-only patches.
	previewSlip: (args: { patches: readonly SlipTrimPatch[] }) => void;
	discardSlipPreview: () => void;
	commitSlip: (args: { patches: readonly SlipTrimPatch[] }) => void;
}

export interface SnapConfig {
	isEnabled: () => boolean;
	onChange?: (snapPoint: SnapPoint | null) => void;
}

export interface ElementInteractionDeps {
	viewport: ViewportAdapter;
	input: InputAdapter;
	scene: SceneReader;
	selection: ElementSelectionApi;
	playback: PlaybackReader;
	timeline: TimelineOps;
	snap: SnapConfig;
}

export interface ElementInteractionDepsRef {
	readonly current: ElementInteractionDeps;
}

// --- Session ---

// An interior body-drag is a plain clip MOVE (default) or a SLIP (Y armed): the
// mode is latched once at mousedown from the armed place tool, so a mid-drag tool
// change can't flip the gesture's behaviour underneath the user (mirrors the
// resize-controller's ResizeMode latch). Slip slides the SOURCE window under each
// dragged clip while its timeline position + duration stay fixed; it routes
// through its own preview/commit path and never builds a MoveGroup.
type MoveMode = "move" | "slip";

type Point = { readonly x: number; readonly y: number };

interface MousedownSnapshot {
	readonly origin: Point;
	readonly mode: MoveMode;
	readonly elementId: string;
	readonly trackId: string;
	readonly startElementTime: MediaTime;
	readonly clickOffsetTime: MediaTime;
	readonly selectedElements: readonly ElementRef[];
}

// The frozen original state of one clip being slipped, captured at mousedown so a
// preview can be re-derived from scratch every mousemove (idempotent, like the
// resize controller re-deriving from `members`).
interface SlipMember {
	readonly trackId: string;
	readonly elementId: string;
	readonly trimStartTicks: number;
	readonly trimEndTicks: number;
	readonly sourceDurationTicks: number;
	readonly durationTicks: number;
	readonly rate: number;
}

interface SlipProgress {
	readonly members: readonly SlipMember[];
	patches: readonly SlipTrimPatch[];
}

interface DragProgress {
	moveGroup: MoveGroup;
	// Pre-minted per member so the identity of any "new track" created by
	// this drag stays stable across mousemove-driven drop-target recomputes.
	// `resolveGroupMoveForDrop` runs every mousemove and emits a
	// `createTracks[]` carrying these IDs; downstream consumers (snap
	// indicator, drop-line, commit path) see the same entity every frame
	// instead of a churning UUID.
	reservedNewTrackIds: readonly string[];
	currentTime: MediaTime;
	currentMouseX: number;
	currentMouseY: number;
	groupMoveResult: GroupMoveResult | null;
	dropTarget: DropTarget | null;
}

type Session =
	| { kind: "idle" }
	| { kind: "pending"; mousedown: MousedownSnapshot }
	| { kind: "dragging"; mousedown: MousedownSnapshot; drag: DragProgress }
	| { kind: "slipping"; mousedown: MousedownSnapshot; slip: SlipProgress };

const IDLE_VIEW: ElementDragView = { kind: "idle" };

// --- Pure helpers ---

function pixelToClickOffsetTime({
	clientX,
	elementRect,
	zoomLevel,
}: {
	clientX: number;
	elementRect: DOMRect;
	zoomLevel: number;
}): MediaTime {
	const clickOffsetX = clientX - elementRect.left;
	const seconds = clickOffsetX / (BASE_TIMELINE_PIXELS_PER_SECOND * zoomLevel);
	return mediaTime({ ticks: Math.round(seconds * TICKS_PER_SECOND) });
}

function verticalDirection({
	startMouseY,
	currentMouseY,
}: {
	startMouseY: number;
	currentMouseY: number;
}): "up" | "down" | null {
	if (currentMouseY < startMouseY) return "up";
	if (currentMouseY > startMouseY) return "down";
	return null;
}

function orderedTracks(sceneTracks: SceneTracks): TimelineTrack[] {
	return [...sceneTracks.overlay, sceneTracks.main, ...sceneTracks.audio];
}

function rateOfElement(element: TimelineElement): number {
	return isRetimableElement(element) ? (element.retime?.rate ?? 1) : 1;
}

/**
 * Snapshot the original trim/source/duration/rate of each clip that the Slip
 * gesture will slide. Slip only makes sense for clips with a real source window
 * (a `sourceDuration`), so generated elements without one are dropped — they
 * have nothing to slip. Returns the frozen members; the controller re-derives
 * the preview from these every mousemove.
 */
function buildSlipMembers({
	tracks,
	selectedElements,
}: {
	tracks: SceneTracks;
	selectedElements: readonly ElementRef[];
}): SlipMember[] {
	const trackMap = new Map(
		orderedTracks(tracks).map((track) => [track.id, track]),
	);
	return selectedElements.flatMap(({ trackId, elementId }) => {
		const track = trackMap.get(trackId);
		const element = track?.elements.find((el) => el.id === elementId);
		if (!element || element.sourceDuration == null) return [];
		return [
			{
				trackId,
				elementId,
				trimStartTicks: element.trimStart as number,
				trimEndTicks: element.trimEnd as number,
				sourceDurationTicks: element.sourceDuration as number,
				durationTicks: element.duration as number,
				rate: rateOfElement(element),
			},
		];
	});
}

/**
 * Turn a horizontal pixel delta into a trim-only patch per slipped clip via the
 * pure `computeSlipTarget`. The clip's timeline position and duration never
 * change — only its `trimStart`/`trimEnd` (the source window) slides. A member
 * whose trim is unchanged after clamping (e.g. a fully-saturated clip, or a zero
 * drag) is omitted, so a no-op gesture commits nothing.
 */
function slipPatchesForDelta({
	members,
	deltaPx,
	zoomLevel,
}: {
	members: readonly SlipMember[];
	deltaPx: number;
	zoomLevel: number;
}): SlipTrimPatch[] {
	const deltaTicks = Math.round(
		(deltaPx / (BASE_TIMELINE_PIXELS_PER_SECOND * zoomLevel)) *
			TICKS_PER_SECOND,
	);
	return members.flatMap((member) => {
		const target = computeSlipTarget({
			trimStartTicks: member.trimStartTicks,
			trimEndTicks: member.trimEndTicks,
			sourceDurationTicks: member.sourceDurationTicks,
			durationTicks: member.durationTicks,
			deltaTicks,
			rate: member.rate,
		});
		if (
			target.trimStartTicks === member.trimStartTicks &&
			target.trimEndTicks === member.trimEndTicks
		) {
			return [];
		}
		return [
			{
				trackId: member.trackId,
				elementId: member.elementId,
				trimStart: mediaTime({ ticks: target.trimStartTicks }),
				trimEnd: mediaTime({ ticks: target.trimEndTicks }),
			},
		];
	});
}

function movedPastDragThreshold({
	current,
	origin,
}: {
	current: Point;
	origin: Point;
}): boolean {
	return (
		Math.abs(current.x - origin.x) > TIMELINE_DRAG_THRESHOLD_PX ||
		Math.abs(current.y - origin.y) > TIMELINE_DRAG_THRESHOLD_PX
	);
}

function frameSnappedMouseTime({
	clientX,
	scrollContainer,
	zoomLevel,
	clickOffsetTime,
	fps,
}: {
	clientX: number;
	scrollContainer: HTMLDivElement;
	zoomLevel: number;
	clickOffsetTime: MediaTime;
	fps: FrameRate;
}): MediaTime {
	const mouseTime = getMouseTimeFromClientX({
		clientX,
		containerRect: scrollContainer.getBoundingClientRect(),
		zoomLevel,
		scrollLeft: scrollContainer.scrollLeft,
	});
	const adjusted = maxMediaTime({
		a: ZERO_MEDIA_TIME,
		b: subMediaTime({ a: mouseTime, b: clickOffsetTime }),
	});
	return roundFrameTime({ time: adjusted, fps });
}

function resolveDropTarget({
	clientX,
	clientY,
	elementId,
	trackId,
	tracks,
	viewport,
	zoomLevel,
	snappedTime,
	verticalDragDirection,
}: {
	clientX: number;
	clientY: number;
	elementId: string;
	trackId: string;
	tracks: SceneTracks;
	viewport: ViewportAdapter;
	zoomLevel: number;
	snappedTime: MediaTime;
	verticalDragDirection: "up" | "down" | null;
}): DropTarget | null {
	const containerRect = viewport
		.getTracksContainerEl()
		?.getBoundingClientRect();
	const scrollContainer = viewport.getTracksScrollEl();
	if (!containerRect || !scrollContainer) return null;

	const sourceTrack = orderedTracks(tracks).find(({ id }) => id === trackId);
	const movingElement = sourceTrack?.elements.find(
		({ id }) => id === elementId,
	);
	if (!movingElement) return null;

	const scrollRect = scrollContainer.getBoundingClientRect();
	const headerHeight =
		viewport.getHeaderEl()?.getBoundingClientRect().height ?? 0;

	return computeDropTarget({
		elementType: movingElement.type,
		mouseX: clientX - scrollRect.left + scrollContainer.scrollLeft,
		mouseY: clientY - scrollRect.top + scrollContainer.scrollTop - headerHeight,
		tracks,
		playheadTime: snappedTime,
		isExternalDrop: false,
		elementDuration: movingElement.duration,
		pixelsPerSecond: BASE_TIMELINE_PIXELS_PER_SECOND,
		zoomLevel,
		startTimeOverride: snappedTime,
		excludeElementId: movingElement.id,
		verticalDragDirection,
	});
}

function resolveGroupMoveForDrop({
	group,
	tracks,
	anchorStartTime,
	dropTarget,
	reservedNewTrackIds,
}: {
	group: MoveGroup;
	tracks: SceneTracks;
	anchorStartTime: MediaTime;
	dropTarget: DropTarget;
	reservedNewTrackIds: readonly string[];
}): GroupMoveResult | null {
	const newTracksFallback = () =>
		resolveGroupMove({
			group,
			tracks,
			anchorStartTime,
			target: {
				kind: "newTracks",
				anchorInsertIndex: dropTarget.trackIndex,
				newTrackIds: [...reservedNewTrackIds],
			},
		});

	if (dropTarget.isNewTrack) return newTracksFallback();

	const targetTrack = orderedTracks(tracks)[dropTarget.trackIndex];
	if (!targetTrack) return null;

	return (
		resolveGroupMove({
			group,
			tracks,
			anchorStartTime,
			target: { kind: "existingTrack", anchorTargetTrackId: targetTrack.id },
		}) ?? newTracksFallback()
	);
}

// --- Controller ---

export class ElementInteractionController {
	private session: Session = { kind: "idle" };
	// True once the active gesture crossed the drag threshold. Read by
	// onElementClick, which fires after mouseup — by which point the session
	// has already returned to idle, so the "was this a drag?" answer must
	// outlive the session. Reset on the next mousedown.
	private lastGestureWasDrag = false;

	private readonly subscribers = new Set<() => void>();
	private readonly depsRef: ElementInteractionDepsRef;

	constructor(args: { depsRef: ElementInteractionDepsRef }) {
		this.depsRef = args.depsRef;
	}

	private get deps(): ElementInteractionDeps {
		return this.depsRef.current;
	}

	get view(): ElementDragView {
		if (this.session.kind !== "dragging") return IDLE_VIEW;
		const { mousedown, drag } = this.session;
		const memberTimeOffsets = new Map<string, MediaTime>();
		for (const member of drag.moveGroup.members) {
			memberTimeOffsets.set(member.elementId, member.timeOffset);
		}
		return {
			kind: "dragging",
			anchorElementId: mousedown.elementId,
			trackId: mousedown.trackId,
			memberTimeOffsets,
			startMouseX: mousedown.origin.x,
			startMouseY: mousedown.origin.y,
			startElementTime: mousedown.startElementTime,
			clickOffsetTime: mousedown.clickOffsetTime,
			currentTime: drag.currentTime,
			currentMouseX: drag.currentMouseX,
			currentMouseY: drag.currentMouseY,
			dropTarget: drag.dropTarget,
		};
	}

	get isActive(): boolean {
		return this.session.kind !== "idle";
	}

	subscribe(fn: () => void): () => void {
		this.subscribers.add(fn);
		return () => this.subscribers.delete(fn);
	}

	cancel = (): void => {
		this.lastGestureWasDrag = false;
		this.finishSession();
	};

	destroy(): void {
		this.cancel();
		this.subscribers.clear();
	}

	onElementMouseDown = ({
		event,
		element,
		track,
	}: {
		event: ReactMouseEvent;
		element: TimelineElement;
		track: TimelineTrack;
	}): void => {
		// Right-click must not stopPropagation — ContextMenu needs the bubble.
		if (event.button === MOUSE_BUTTON_RIGHT) {
			const ref = { trackId: track.id, elementId: element.id };
			if (!this.deps.selection.isSelected(ref)) {
				this.deps.selection.handleClick({ ...ref, isMultiKey: false });
			}
			return;
		}

		event.stopPropagation();
		this.lastGestureWasDrag = false;

		const ref = { trackId: track.id, elementId: element.id };

		if (event.metaKey || event.ctrlKey || event.shiftKey) {
			this.deps.selection.handleClick({ ...ref, isMultiKey: true });
		}

		const baseSelected = this.deps.selection.isSelected(ref)
			? this.deps.selection.getSelected()
			: [ref];
		// Linked clips move together by default — Alt drags the one clip only.
		const selectedElements =
			!event.altKey && useTimelineStore.getState().linkedSelectionEnabled
				? expandSelectionWithLinks({
						refs: [...baseSelected],
						tracks: this.deps.scene.getTracks(),
					})
				: baseSelected;

		// Latch the body-drag mode ONCE here from the armed place tool (Y = Slip),
		// mirroring the resize-controller's ResizeMode latch. A mid-drag tool change
		// can't flip move <-> slip after this point. Defaults to "move" whenever Slip
		// isn't armed, so the normal move path is the fall-through.
		const mode: MoveMode =
			usePlaceToolStore.getState().tool?.kind === "slip" ? "slip" : "move";

		this.session = {
			kind: "pending",
			mousedown: {
				origin: { x: event.clientX, y: event.clientY },
				mode,
				elementId: element.id,
				trackId: track.id,
				startElementTime: element.startTime,
				clickOffsetTime: pixelToClickOffsetTime({
					clientX: event.clientX,
					elementRect: event.currentTarget.getBoundingClientRect(),
					zoomLevel: this.deps.viewport.getZoomLevel(),
				}),
				selectedElements,
			},
		};
		this.activate();
		this.notify();
	};

	onElementClick = ({
		event,
		element,
		track,
	}: {
		event: ReactMouseEvent;
		element: TimelineElement;
		track: TimelineTrack;
	}): void => {
		event.stopPropagation();

		if (this.lastGestureWasDrag) {
			this.lastGestureWasDrag = false;
			return;
		}

		if (event.metaKey || event.ctrlKey || event.shiftKey) return;

		const ref = { trackId: track.id, elementId: element.id };
		if (
			!this.deps.selection.isSelected(ref) ||
			this.deps.selection.getSelected().length > 1
		) {
			// Linked selection: clicking one clip selects its partner too, so
			// trim/delete/move all act on the pair (Alt = just this clip).
			if (!event.altKey && useTimelineStore.getState().linkedSelectionEnabled) {
				const expanded = expandSelectionWithLinks({
					refs: [ref],
					tracks: this.deps.scene.getTracks(),
				});
				if (expanded.length > 1) {
					this.deps.selection.selectMany(expanded);
					return;
				}
			}
			this.deps.selection.select(ref);
			return;
		}

		this.deps.selection.clearKeyframeSelection();
	};

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
		// A live slip preview is committed on mouseup; any OTHER exit (cancel /
		// Escape / a sub-threshold release) must roll the preview overlay back.
		if (this.session.kind === "slipping") {
			this.deps.timeline.discardSlipPreview();
		}
		this.session = { kind: "idle" };
		this.deactivate();
		this.deps.snap.onChange?.(null);
		this.notify();
	}

	private snapResult({
		frameSnappedTime,
		group,
	}: {
		frameSnappedTime: MediaTime;
		group: MoveGroup;
	}): { snappedTime: MediaTime; snapPoint: SnapPoint | null } {
		const { snap, input, scene, viewport, playback } = this.deps;

		if (!snap.isEnabled() || input.isShiftHeld()) {
			return { snappedTime: frameSnappedTime, snapPoint: null };
		}

		const result = snapGroupEdges({
			group,
			anchorStartTime: frameSnappedTime,
			tracks: scene.getTracks(),
			bookmarks: scene.getBookmarks(),
			playheadTime: playback.getCurrentTime(),
			zoomLevel: viewport.getZoomLevel(),
		});

		return {
			snappedTime: result.snappedAnchorStartTime,
			snapPoint: result.snapPoint,
		};
	}

	private updateDropTarget({
		clientX,
		clientY,
		mousedown,
		drag,
		snappedTime,
	}: {
		clientX: number;
		clientY: number;
		mousedown: MousedownSnapshot;
		drag: DragProgress;
		snappedTime: MediaTime;
	}): void {
		const { scene, viewport } = this.deps;
		const tracks = scene.getTracks();
		const zoomLevel = viewport.getZoomLevel();

		const anchorDropTarget = resolveDropTarget({
			clientX,
			clientY,
			elementId: mousedown.elementId,
			trackId: mousedown.trackId,
			tracks,
			viewport,
			zoomLevel,
			snappedTime,
			verticalDragDirection: verticalDirection({
				startMouseY: mousedown.origin.y,
				currentMouseY: clientY,
			}),
		});

		const nextGroupMoveResult = anchorDropTarget
			? resolveGroupMoveForDrop({
					group: drag.moveGroup,
					tracks,
					anchorStartTime: snappedTime,
					dropTarget: anchorDropTarget,
					reservedNewTrackIds: drag.reservedNewTrackIds,
				})
			: null;

		drag.groupMoveResult = nextGroupMoveResult;
		drag.dropTarget =
			anchorDropTarget && (anchorDropTarget.isNewTrack || !nextGroupMoveResult)
				? { ...anchorDropTarget, isNewTrack: true }
				: null;
	}

	private handleMouseMove = ({ clientX, clientY }: MouseEvent): void => {
		const scrollContainer = this.deps.viewport.getTracksScrollEl();
		if (!scrollContainer) return;

		if (this.session.kind === "pending") {
			// Slip (Y armed) takes a wholly separate path — it slides the source
			// window and never builds a MoveGroup. Move (the default) is unchanged.
			if (this.session.mousedown.mode === "slip") {
				this.beginSlipFromPending({
					mousedown: this.session.mousedown,
					clientX,
					clientY,
				});
				return;
			}
			this.beginDragFromPending({
				mousedown: this.session.mousedown,
				clientX,
				clientY,
				scrollContainer,
			});
			return;
		}

		if (this.session.kind === "dragging") {
			this.updateActiveDrag({
				mousedown: this.session.mousedown,
				drag: this.session.drag,
				clientX,
				clientY,
				scrollContainer,
			});
			return;
		}

		if (this.session.kind === "slipping") {
			this.updateActiveSlip({
				slip: this.session.slip,
				clientX,
			});
		}
	};

	private beginDragFromPending({
		mousedown,
		clientX,
		clientY,
		scrollContainer,
	}: {
		mousedown: MousedownSnapshot;
		clientX: number;
		clientY: number;
		scrollContainer: HTMLDivElement;
	}): void {
		if (
			!movedPastDragThreshold({
				current: { x: clientX, y: clientY },
				origin: mousedown.origin,
			})
		) {
			return;
		}

		const fps = this.deps.scene.getActiveFps();
		if (!fps) return;

		const moveGroup = buildMoveGroup({
			anchorRef: {
				trackId: mousedown.trackId,
				elementId: mousedown.elementId,
			},
			selectedElements: [...mousedown.selectedElements],
			tracks: this.deps.scene.getTracks(),
		});
		if (!moveGroup) return;

		const zoomLevel = this.deps.viewport.getZoomLevel();
		const frameSnappedTime = frameSnappedMouseTime({
			clientX,
			scrollContainer,
			zoomLevel,
			clickOffsetTime: mousedown.clickOffsetTime,
			fps,
		});
		const { snappedTime, snapPoint } = this.snapResult({
			frameSnappedTime,
			group: moveGroup,
		});

		// Ensure the anchor is selected before we render the drag — covers the
		// case where the selection store hasn't committed the mousedown-time
		// selection click yet.
		const anchorRef = {
			trackId: mousedown.trackId,
			elementId: mousedown.elementId,
		};
		if (!this.deps.selection.isSelected(anchorRef)) {
			this.deps.selection.select(anchorRef);
		}

		const drag: DragProgress = {
			moveGroup,
			reservedNewTrackIds: moveGroup.members.map(() => generateUUID()),
			currentTime: snappedTime,
			currentMouseX: clientX,
			currentMouseY: clientY,
			groupMoveResult: null,
			dropTarget: null,
		};

		this.session = { kind: "dragging", mousedown, drag };
		this.lastGestureWasDrag = true;

		this.updateDropTarget({
			clientX,
			clientY,
			mousedown,
			drag,
			snappedTime,
		});

		this.deps.snap.onChange?.(snapPoint);
		this.notify();
	}

	private updateActiveDrag({
		mousedown,
		drag,
		clientX,
		clientY,
		scrollContainer,
	}: {
		mousedown: MousedownSnapshot;
		drag: DragProgress;
		clientX: number;
		clientY: number;
		scrollContainer: HTMLDivElement;
	}): void {
		const fps = this.deps.scene.getActiveFps();
		if (!fps) return;

		const frameSnappedTime = frameSnappedMouseTime({
			clientX,
			scrollContainer,
			zoomLevel: this.deps.viewport.getZoomLevel(),
			clickOffsetTime: mousedown.clickOffsetTime,
			fps,
		});
		const { snappedTime, snapPoint } = this.snapResult({
			frameSnappedTime,
			group: drag.moveGroup,
		});

		drag.currentTime = snappedTime;
		drag.currentMouseX = clientX;
		drag.currentMouseY = clientY;

		this.updateDropTarget({
			clientX,
			clientY,
			mousedown,
			drag,
			snappedTime,
		});

		this.deps.snap.onChange?.(snapPoint);
		this.notify();
	}

	// --- Slip body-drag (Y armed) ---

	private beginSlipFromPending({
		mousedown,
		clientX,
		clientY,
	}: {
		mousedown: MousedownSnapshot;
		clientX: number;
		clientY: number;
	}): void {
		if (
			!movedPastDragThreshold({
				current: { x: clientX, y: clientY },
				origin: mousedown.origin,
			})
		) {
			return;
		}

		const members = buildSlipMembers({
			tracks: this.deps.scene.getTracks(),
			selectedElements: mousedown.selectedElements,
		});
		// No slippable clip (e.g. a generated element with no source window):
		// abandon the gesture rather than silently latching an empty slip session.
		if (members.length === 0) {
			this.finishSession();
			return;
		}

		const slip: SlipProgress = { members, patches: [] };
		this.session = { kind: "slipping", mousedown, slip };
		this.lastGestureWasDrag = true;

		this.applySlipPreview({ slip, clientX });
		this.notify();
	}

	private updateActiveSlip({
		slip,
		clientX,
	}: {
		slip: SlipProgress;
		clientX: number;
	}): void {
		this.applySlipPreview({ slip, clientX });
		this.notify();
	}

	private applySlipPreview({
		slip,
		clientX,
	}: {
		slip: SlipProgress;
		clientX: number;
	}): void {
		const deltaPx = clientX - this.sessionOriginX();
		slip.patches = slipPatchesForDelta({
			members: slip.members,
			deltaPx,
			zoomLevel: this.deps.viewport.getZoomLevel(),
		});
		this.deps.timeline.previewSlip({ patches: slip.patches });
	}

	/** The mousedown X of the active session (slip uses raw pixel delta). */
	private sessionOriginX(): number {
		return this.session.kind === "idle"
			? 0
			: this.session.mousedown.origin.x;
	}

	private handleMouseUp = ({ clientX, clientY }: MouseEvent): void => {
		if (this.session.kind === "pending") {
			this.finishSession();
			return;
		}

		if (this.session.kind === "slipping") {
			const { mousedown, slip } = this.session;
			// A sub-threshold release is a cancel (the user nudged then returned);
			// finishSession discards the live preview. Otherwise commit the trim.
			if (
				movedPastDragThreshold({
					current: { x: clientX, y: clientY },
					origin: mousedown.origin,
				}) &&
				slip.patches.length > 0
			) {
				// Roll back the live preview, then commit the trim through the
				// history-backed path so the whole slip is ONE undo step.
				this.deps.timeline.discardSlipPreview();
				this.deps.timeline.commitSlip({ patches: slip.patches });
				// Mark idle WITHOUT a second discard (already discarded above).
				this.session = { kind: "idle" };
				this.deactivate();
				this.deps.snap.onChange?.(null);
				this.notify();
				return;
			}
			this.lastGestureWasDrag = false;
			this.finishSession();
			return;
		}

		if (this.session.kind !== "dragging") return;

		const { mousedown, drag } = this.session;

		// If the drag returned within the click threshold of its origin, treat
		// this as a cancel rather than a commit — the user dragged then put the
		// element back.
		if (
			!movedPastDragThreshold({
				current: { x: clientX, y: clientY },
				origin: mousedown.origin,
			})
		) {
			this.lastGestureWasDrag = false;
			this.finishSession();
			return;
		}

		const { moveGroup, groupMoveResult } = drag;
		if (!groupMoveResult) {
			this.finishSession();
			return;
		}

		const didMove = groupMoveResult.moves.some((move) => {
			const member = moveGroup.members.find(
				(m) => m.elementId === move.elementId,
			);
			const originalStartTime =
				mousedown.startElementTime + (member?.timeOffset ?? 0);
			return (
				member?.trackId !== move.targetTrackId ||
				originalStartTime !== move.newStartTime
			);
		});

		if (didMove || groupMoveResult.createTracks.length > 0) {
			this.deps.timeline.moveElements({
				moves: groupMoveResult.moves,
				createTracks: groupMoveResult.createTracks,
			});
		}

		this.finishSession();
	};
}
