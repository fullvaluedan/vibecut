import type { DragEvent } from "react";
import { processMediaAssets } from "@/media/processing";
import { showMediaUploadToast } from "@/media/upload-toast";
import {
	DEFAULT_NEW_ELEMENT_DURATION,
	toElementDurationTicks,
} from "@/timeline/creation";
import { BASE_TIMELINE_PIXELS_PER_SECOND } from "@/timeline/scale";
import type { FrameRate } from "opencut-wasm";
import {
	buildTextElement,
	buildGraphicElement,
	buildStickerElement,
	buildElementFromMedia,
	buildEffectElement,
} from "@/timeline/element-utils";
import {
	AddTrackCommand,
	DeleteElementsCommand,
	InsertElementCommand,
	UpdateElementsCommand,
} from "@/commands/timeline";
import { planRegionOverwrite } from "@/timeline/controllers/overwrite-region";
import { buildSeparatedVideoAudioPair } from "@/timeline/audio-separation";
import { canElementGoOnTrack } from "@/timeline/placement/compatibility";
import {
	computeRippleInsertShifts,
	computeStraddleSplit,
	findStraddlingElement,
} from "@/timeline/placement/ripple-insert";
import { BatchCommand } from "@/commands";
import type { Command } from "@/commands/base-command";
import { computeDropTarget, getTrackAtY } from "@/timeline/components/drop-target";
import type { TimelineDragSource } from "@/timeline/drag-source";
import type {
	TrackType,
	DropTarget,
	ElementType,
	SceneTracks,
	TimelineTrack,
	TimelineElement,
	CreateTimelineElement,
} from "@/timeline";
import type { TimelineDragData } from "@/timeline/drag";
import type { MediaAsset } from "@/media/types";
import type { ProcessedMediaAsset } from "@/media/processing";
import {
	mediaTime,
	addMediaTime,
	roundFrameTime,
	ZERO_MEDIA_TIME,
	type MediaTime,
} from "@/wasm";

// --- Config ---

export interface DragDropConfig {
	zoomLevel: number;
	getContainerEl: () => HTMLDivElement | null;
	getHeaderEl: () => HTMLElement | null;
	getTracksScrollEl: () => HTMLDivElement | null;
	getActiveProjectFps: () => FrameRate | null;
	getActiveProjectId: () => string | null;
	getSceneTracks: () => SceneTracks;
	getCurrentPlayheadTime: () => MediaTime;
	getMediaAssets: () => MediaAsset[];
	dragSource: TimelineDragSource;
	addMediaAsset: (args: {
		projectId: string;
		asset: ProcessedMediaAsset;
	}) => Promise<MediaAsset | null>;
	executeCommand: (command: Command) => void;
	insertElement: (args: {
		placement: { mode: "explicit"; trackId: string };
		element: CreateTimelineElement;
	}) => void;
	addClipEffect: (args: {
		trackId: string;
		elementId: string;
		effectType: string;
	}) => void;
	/** Premiere-style: split a dropped video's audio onto its own track. */
	separateSourceAudio?: (args: { trackId: string; elementId: string }) => void;
}

export interface DragDropConfigRef {
	readonly current: DragDropConfig;
}

// --- State ---

// Premiere-style drop modes. The user's default is INSERT (plain drag pushes
// downstream clips right to make room); holding Ctrl/Cmd switches to OVERWRITE
// (the covered region is cleared, nothing ripples). This is the inverse of
// Premiere's own default, by explicit product decision (push-to-add-cuts).
export type DragDropMode = "insert" | "overwrite";

function dropModeFromEvent(event: DragEvent): DragDropMode {
	return event.ctrlKey || event.metaKey ? "overwrite" : "insert";
}

interface DragOverState {
	kind: "over";
	dropTarget: DropTarget | null;
	elementType: ElementType | null;
	mode: DragDropMode;
}

type DragDropState = { kind: "idle" } | DragOverState;

interface TimelineCoords {
	mouseX: number;
	mouseY: number;
}

// --- Pure helpers ---

function elementTypeFromDrag({
	dragData,
}: {
	dragData: TimelineDragData;
}): ElementType {
	switch (dragData.type) {
		case "text":
			return "text";
		case "graphic":
			return "graphic";
		case "sticker":
			return "sticker";
		case "effect":
			return "effect";
		case "media":
			return dragData.mediaType;
	}
}

function getTargetElementTypesForDrag({
	dragData,
}: {
	dragData: TimelineDragData;
}): string[] | undefined {
	if (dragData.type === "effect") return dragData.targetElementTypes;
	if (dragData.type === "media") return dragData.targetElementTypes;
	return undefined;
}

function getDurationForDrag({
	dragData,
	mediaAssets,
}: {
	dragData: TimelineDragData;
	mediaAssets: MediaAsset[];
}): MediaTime {
	if (dragData.type !== "media") return DEFAULT_NEW_ELEMENT_DURATION;
	const media = mediaAssets.find((asset) => asset.id === dragData.id);
	return toElementDurationTicks({ seconds: media?.duration });
}

function orderedTracks({
	sceneTracks,
}: {
	sceneTracks: SceneTracks;
}): TimelineTrack[] {
	return [...sceneTracks.overlay, sceneTracks.main, ...sceneTracks.audio];
}

/**
 * Is `element` authored / HyperFrames-provenance, and so never to be rippled or
 * overwritten by a bin drop? A HyperFrames render / baked block is a `video`
 * with `framecutAi` set. Its separated source audio is a plain `AudioElement`
 * that carries the video's `linkId` but not `framecutAi` (video-only), so an
 * audio lane is checked by following the `linkId` back to the authored video
 * (needs `sceneTracks`). Pass `sceneTracks` for the linked-audio case.
 */
function isElementAuthored({
	element,
	sceneTracks,
}: {
	element: TimelineElement;
	sceneTracks?: SceneTracks;
}): boolean {
	if ("framecutAi" in element && element.framecutAi != null) {
		return true;
	}
	if (element.linkId === undefined || !sceneTracks) {
		return false;
	}
	return orderedTracks({ sceneTracks }).some((track) =>
		track.elements.some(
			(candidate) =>
				candidate.id !== element.id &&
				candidate.linkId === element.linkId &&
				"framecutAi" in candidate &&
				candidate.framecutAi != null,
		),
	);
}

// --- Controller ---

export class DragDropController {
	private state: DragDropState = { kind: "idle" };
	private enterCount = 0;
	private readonly subscribers = new Set<() => void>();
	private readonly configRef: DragDropConfigRef;

	constructor(deps: { configRef: DragDropConfigRef }) {
		this.configRef = deps.configRef;
		this.onDragEnter = this.onDragEnter.bind(this);
		this.onDragOver = this.onDragOver.bind(this);
		this.onDragLeave = this.onDragLeave.bind(this);
		this.onDrop = this.onDrop.bind(this);
	}

	private get config(): DragDropConfig {
		return this.configRef.current;
	}

	get isDragOver(): boolean {
		return this.state.kind !== "idle";
	}

	get dropTarget(): DropTarget | null {
		return this.state.kind === "over" ? this.state.dropTarget : null;
	}

	get dragElementType(): ElementType | null {
		return this.state.kind === "over" ? this.state.elementType : null;
	}

	/** Active drop mode for the drag cue (insert = ripple, overwrite = clear). */
	get dragMode(): DragDropMode | null {
		return this.state.kind === "over" ? this.state.mode : null;
	}

	subscribe(fn: () => void): () => void {
		this.subscribers.add(fn);
		return () => this.subscribers.delete(fn);
	}

	destroy(): void {
		this.subscribers.clear();
	}

	// --- Drag event handlers (bound, stable, passed as React props) ---

	onDragEnter(event: DragEvent): void {
		event.preventDefault();
		const hasAsset = this.config.dragSource.isActive();
		const hasFiles = event.dataTransfer.types.includes("Files");
		if (!hasAsset && !hasFiles) return;

		this.enterCount += 1;
		if (this.state.kind === "idle") {
			this.setOver({
				dropTarget: null,
				elementType: null,
				mode: dropModeFromEvent(event),
			});
		}
	}

	onDragOver(event: DragEvent): void {
		event.preventDefault();

		const coords = this.getMouseTimelineCoords({ event });
		if (!coords) return;

		const dragData = this.config.dragSource.getActive();
		const hasFiles = event.dataTransfer.types.includes("Files");
		const isExternal = hasFiles && !dragData;
		const mode = dropModeFromEvent(event);

		if (!dragData) {
			if (hasFiles && isExternal) {
				this.setOver({ dropTarget: null, elementType: null, mode });
			}
			return;
		}

		const elementType = elementTypeFromDrag({ dragData });
		const duration = getDurationForDrag({
			dragData,
			mediaAssets: this.config.getMediaAssets(),
		});
		const targetElementTypes = getTargetElementTypesForDrag({ dragData });

		const sceneTracks = this.config.getSceneTracks();
		const target = computeDropTarget({
			elementType,
			mouseX: coords.mouseX,
			mouseY: coords.mouseY,
			tracks: sceneTracks,
			playheadTime: this.config.getCurrentPlayheadTime(),
			isExternalDrop: isExternal,
			elementDuration: duration,
			pixelsPerSecond: BASE_TIMELINE_PIXELS_PER_SECOND,
			zoomLevel: this.config.zoomLevel,
			targetElementTypes,
		});

		const fps = this.config.getActiveProjectFps();
		target.xPosition = fps
			? roundFrameTime({ time: target.xPosition, fps })
			: target.xPosition;

		this.setOver({ dropTarget: target, elementType, mode });
		event.dataTransfer.dropEffect = "copy";
	}

	onDragLeave(event: DragEvent): void {
		event.preventDefault();
		if (this.enterCount === 0) return;
		this.enterCount -= 1;
		if (this.enterCount === 0) {
			this.setIdle();
		}
	}

	onDrop(event: DragEvent): void {
		event.preventDefault();
		this.enterCount = 0;

		const dragData = this.config.dragSource.getActive();
		const hasFiles = event.dataTransfer.files?.length > 0;
		if (!dragData && !hasFiles) return;

		const currentTarget = this.dropTarget;
		const mode = dropModeFromEvent(event);
		this.setIdle();
		// After a drop, focus lingers on the dragged bin tile, which makes the
		// keybindings dispatcher bail on bare-key shortcuts (Delete, gap-delete)
		// until the user clicks the timeline. Drop that focus so keys work now.
		blurActiveElementForShortcuts();

		try {
			if (dragData) {
				if (!currentTarget) return;
				this.executeAssetDrop({
					target: currentTarget,
					dragData,
					coords: this.getMouseTimelineCoords({ event }),
					mode,
				});
				return;
			}

			const coords = this.getMouseTimelineCoords({ event });
			if (!coords) return;
			this.executeFileDrop({
				files: Array.from(event.dataTransfer.files),
				mouseX: coords.mouseX,
				mouseY: coords.mouseY,
			}).catch((error) => {
				console.error("Failed to process file drop:", error);
			});
		} catch (error) {
			console.error("Failed to process drop:", error);
		}
	}

	// --- Private ---

	private setOver(state: {
		dropTarget: DropTarget | null;
		elementType: ElementType | null;
		mode: DragDropMode;
	}): void {
		this.state = { kind: "over", ...state };
		this.notify();
	}

	private setIdle(): void {
		this.state = { kind: "idle" };
		this.notify();
	}

	private notify(): void {
		for (const fn of this.subscribers) fn();
	}

	private getMouseTimelineCoords({
		event,
	}: {
		event: DragEvent;
	}): TimelineCoords | null {
		const scrollContainer = this.config.getTracksScrollEl();
		const referenceRect =
			scrollContainer?.getBoundingClientRect() ??
			this.config.getContainerEl()?.getBoundingClientRect();
		if (!referenceRect) return null;

		const scrollLeft = scrollContainer?.scrollLeft ?? 0;
		const scrollTop = scrollContainer?.scrollTop ?? 0;
		const headerHeight =
			this.config.getHeaderEl()?.getBoundingClientRect().height ?? 0;

		return {
			mouseX: event.clientX - referenceRect.left + scrollLeft,
			mouseY: event.clientY - referenceRect.top + scrollTop - headerHeight,
		};
	}

	// Shared insertion logic — new track vs existing track.
	private insertAtTarget({
		element,
		target,
		trackType,
	}: {
		element: CreateTimelineElement;
		target: DropTarget;
		trackType: TrackType;
	}): { elementId: string | null; trackId: string | null } {
		if (target.isNewTrack) {
			const addTrackCmd = new AddTrackCommand({
				type: trackType,
				index: target.trackIndex,
			});
			const insertCmd = new InsertElementCommand({
				element,
				placement: { mode: "explicit", trackId: addTrackCmd.getTrackId() },
			});
			this.config.executeCommand(new BatchCommand([addTrackCmd, insertCmd]));
			return {
				elementId: insertCmd.getElementId(),
				trackId: addTrackCmd.getTrackId(),
			};
		}

		const tracks = orderedTracks({ sceneTracks: this.config.getSceneTracks() });
		const track = tracks[target.trackIndex];
		if (!track) return { elementId: null, trackId: null };
		const insertCmd = new InsertElementCommand({
			element,
			placement: { mode: "explicit", trackId: track.id },
		});
		this.config.executeCommand(insertCmd);
		return { elementId: insertCmd.getElementId(), trackId: track.id };
	}

	/** After a video lands, peel its audio off onto an audio track. */
	private maybeSeparateAudio({
		asset,
		elementId,
		trackId,
	}: {
		asset: { type: string; hasAudio?: boolean };
		elementId: string | null;
		trackId: string | null;
	}): void {
		if (
			asset.type === "video" &&
			asset.hasAudio !== false &&
			elementId &&
			trackId
		) {
			this.config.separateSourceAudio?.({ trackId, elementId });
		}
	}

	private executeAssetDrop({
		target,
		dragData,
		coords,
		mode,
	}: {
		target: DropTarget;
		dragData: TimelineDragData;
		coords: TimelineCoords | null;
		mode: DragDropMode;
	}): void {
		switch (dragData.type) {
			case "text":
				this.executeTextDrop({ target, dragData });
				return;
			case "graphic":
				this.executeGraphicDrop({ target, dragData });
				return;
			case "sticker":
				this.executeStickerDrop({ target, dragData });
				return;
			case "effect":
				this.executeEffectDrop({ target, dragData });
				return;
			case "media":
				this.executeMediaDrop({ target, dragData, coords, mode });
				return;
		}
	}

	private executeTextDrop({
		target,
		dragData,
	}: {
		target: DropTarget;
		dragData: Extract<TimelineDragData, { type: "text" }>;
	}): void {
		const element = buildTextElement({
			raw: {
				name: dragData.name ?? "",
				params: { content: dragData.content ?? "" },
			},
			startTime: target.xPosition,
		});
		this.insertAtTarget({ element, target, trackType: "text" });
	}

	private executeStickerDrop({
		target,
		dragData,
	}: {
		target: DropTarget;
		dragData: Extract<TimelineDragData, { type: "sticker" }>;
	}): void {
		const element = buildStickerElement({
			stickerId: dragData.stickerId,
			name: dragData.name,
			startTime: target.xPosition,
		});
		this.insertAtTarget({ element, target, trackType: "graphic" });
	}

	private executeGraphicDrop({
		target,
		dragData,
	}: {
		target: DropTarget;
		dragData: Extract<TimelineDragData, { type: "graphic" }>;
	}): void {
		const element = buildGraphicElement({
			definitionId: dragData.definitionId,
			name: dragData.name,
			startTime: target.xPosition,
			params: dragData.params,
		});
		this.insertAtTarget({ element, target, trackType: "graphic" });
	}

	private executeMediaDrop({
		target,
		dragData,
		coords,
		mode,
	}: {
		target: DropTarget;
		dragData: Extract<TimelineDragData, { type: "media" }>;
		coords: TimelineCoords | null;
		mode: DragDropMode;
	}): void {
		if (target.targetElement) {
			// Authored / HyperFrames overlay clips are an invariant: never ripple or
			// overwrite them from a bin drop. Media drags hit-test [video,image,
			// graphic], and a HyperFrames render is a `video` clip on an overlay lane
			// (carries `framecutAi`), so it CAN be hit here. If the covered clip is
			// authored, divert: drop the media onto its OWN new track at the drop
			// point instead (never touch the authored clip, never silently lose the
			// dragged media).
			if (this.isCoveredClipAuthored({ targetElement: target.targetElement })) {
				this.insertMediaOnNewTrack({ target, dragData });
				return;
			}

			// A clip sits under the cursor (video/image hit-test).
			// OVERWRITE (Ctrl/Cmd): clear that region in place, no ripple.
			// INSERT (default): push it + everything downstream right to make room.
			if (mode === "overwrite") {
				this.executeMediaOverwrite({ target, dragData });
			} else {
				this.executeMediaRippleInsert({
					dragData,
					targetTrackId: target.targetElement.trackId,
					dropX: target.xPosition,
				});
			}
			return;
		}

		// No clip under the cursor. Audio carries no visual targetElementTypes, so
		// it never hit-tests; in INSERT mode, if the hovered audio lane is occupied
		// at the drop point, ripple-insert on that lane instead of spawning a track.
		if (mode === "insert") {
			const rippleTrackId = this.findOccupiedLaneForInsert({
				mediaType: dragData.mediaType,
				dropX: target.xPosition,
				coords,
			});
			if (rippleTrackId) {
				this.executeMediaRippleInsert({
					dragData,
					targetTrackId: rippleTrackId,
					dropX: target.xPosition,
				});
				return;
			}
		}

		// Multi-selection drag: drop every selected asset back-to-back.
		if (dragData.mediaIds && dragData.mediaIds.length > 1) {
			this.insertMediaAssetsSequential({
				ids: dragData.mediaIds,
				target,
				coords,
			});
			return;
		}

		const mediaAsset = this.config
			.getMediaAssets()
			.find((asset) => asset.id === dragData.id);
		if (!mediaAsset) return;

		const trackType: TrackType =
			dragData.mediaType === "audio" ? "audio" : "video";
		const element = buildElementFromMedia({
			mediaId: mediaAsset.id,
			mediaType: mediaAsset.type,
			name: mediaAsset.name,
			duration: toElementDurationTicks({ seconds: mediaAsset.duration }),
			startTime: target.xPosition,
		});
		const inserted = this.insertAtTarget({ element, target, trackType });
		this.maybeSeparateAudio({ asset: mediaAsset, ...inserted });
	}

	/**
	 * Is the clip under the cursor an authored / HyperFrames-provenance clip? Such
	 * clips carry `framecutAi` (HyperFrames renders + baked registry blocks are
	 * `video` elements with it set), and must never be rippled or overwritten by a
	 * bin drop.
	 */
	private isCoveredClipAuthored({
		targetElement,
	}: {
		targetElement: { trackId: string; elementId: string };
	}): boolean {
		const track = orderedTracks({
			sceneTracks: this.config.getSceneTracks(),
		}).find((candidate) => candidate.id === targetElement.trackId);
		const element = track?.elements.find(
			(candidate) => candidate.id === targetElement.elementId,
		);
		return element ? isElementAuthored({ element }) : false;
	}

	/**
	 * Would rippling/splitting `lane` at `insertStart` shift or cut an authored
	 * clip? An authored HyperFrames video can have its source audio separated onto
	 * an audio lane; that separated audio carries the video's `linkId` but not
	 * `framecutAi` (video-only), so it is invisible to a bare `framecutAi` check.
	 * Follow the `linkId` back to the authored video. Any clip the ripple
	 * (`startTime >= insertStart`) or the straddle split (spans insertStart) would
	 * touch counts. If so, the caller diverts the drop to a fresh lane instead of
	 * disturbing the authored one.
	 */
	private laneRippleTouchesAuthored({
		lane,
		insertStart,
	}: {
		lane: TimelineTrack;
		insertStart: MediaTime;
	}): boolean {
		const sceneTracks = this.config.getSceneTracks();
		return lane.elements.some((element) => {
			const shifted = element.startTime >= insertStart;
			const straddles =
				element.startTime < insertStart &&
				insertStart <
					addMediaTime({ a: element.startTime, b: element.duration });
			if (!shifted && !straddles) return false;
			return isElementAuthored({ element, sceneTracks });
		});
	}

	/**
	 * Divert a bin drop off an authored clip onto FRESH track(s), ignoring the
	 * covered clip entirely: the media lands (never silently lost) and the authored
	 * clip is untouched. Lays out EVERY selected asset (multi-select drag) so none
	 * is silently dropped, packing same-type assets onto ONE new track per type and
	 * cascading their start times. A dropped video's source audio is separated into
	 * a shared new audio lane IN THE SAME BatchCommand (via the pure
	 * `buildSeparatedVideoAudioPair`), so the whole divert is a SINGLE undo — not
	 * insert-then-toggle (two undo steps) as before.
	 */
	private insertMediaOnNewTrack({
		target,
		dragData,
	}: {
		target: DropTarget;
		dragData: Extract<TimelineDragData, { type: "media" }>;
	}): void {
		// Multi-select drags carry the whole selection; lay them all out. A single
		// drag carries only its own id.
		const ids =
			dragData.mediaIds && dragData.mediaIds.length > 1
				? dragData.mediaIds
				: [dragData.id];
		const assets = this.config.getMediaAssets();

		const commands: Command[] = [];
		// One fresh track PER TYPE (created once, reused), so N same-type assets pack
		// back-to-back onto a single new track instead of spawning N one-clip tracks.
		const newTrackForType = new Map<TrackType, string>();
		const ensureNewTrack = (type: TrackType): string => {
			const existing = newTrackForType.get(type);
			if (existing) return existing;
			const addTrackCmd = new AddTrackCommand({ type });
			newTrackForType.set(type, addTrackCmd.getTrackId());
			commands.push(addTrackCmd);
			return addTrackCmd.getTrackId();
		};
		// All separated source-audio packs onto ONE shared new audio track (lazy, so
		// a drop with no separable video adds no empty track).
		let separatedAudioTrackId: string | null = null;
		const ensureSeparatedAudioTrack = (): string => {
			if (separatedAudioTrackId) return separatedAudioTrackId;
			separatedAudioTrackId = ensureNewTrack("audio");
			return separatedAudioTrackId;
		};

		const baseStart = target.xPosition;
		let cascadeOffsetTicks = 0;
		for (const id of ids) {
			const mediaAsset = assets.find((asset) => asset.id === id);
			if (!mediaAsset) continue;
			const trackType: TrackType =
				mediaAsset.type === "audio" ? "audio" : "video";
			const duration = toElementDurationTicks({ seconds: mediaAsset.duration });
			const startTime = mediaTime({ ticks: baseStart + cascadeOffsetTicks });
			const element = buildElementFromMedia({
				mediaId: mediaAsset.id,
				mediaType: mediaAsset.type,
				name: mediaAsset.name,
				duration,
				startTime,
			});
			const pair =
				element.type === "video"
					? buildSeparatedVideoAudioPair({ videoElement: element, mediaAsset })
					: null;
			const elementToInsert = pair ? pair.video : element;

			commands.push(
				new InsertElementCommand({
					element: elementToInsert,
					placement: {
						mode: "explicit",
						trackId: ensureNewTrack(trackType),
					},
				}),
			);
			if (pair) {
				commands.push(
					new InsertElementCommand({
						element: pair.audio,
						placement: {
							mode: "explicit",
							trackId: ensureSeparatedAudioTrack(),
						},
					}),
				);
			}
			cascadeOffsetTicks += duration;
		}

		if (commands.length > 0) {
			this.config.executeCommand(new BatchCommand(commands));
		}
	}

	/**
	 * The track id of the lane UNDER THE CURSOR when a clip already occupies the
	 * drop point there (so an INSERT should ripple that lane instead of spawning a
	 * new track). Used for audio, which has no visual hit-test. Resolves the
	 * hovered lane from `coords.mouseY` (same vertical hit-test as
	 * `computeDropTarget`) so a drop meant for lane B doesn't ripple lane A when
	 * several compatible lanes exist. Returns null when the cursor isn't over a
	 * compatible lane, or that lane is empty at the drop point.
	 */
	private findOccupiedLaneForInsert({
		mediaType,
		dropX,
		coords,
	}: {
		mediaType: "image" | "video" | "audio";
		dropX: MediaTime;
		coords: TimelineCoords | null;
	}): string | null {
		if (!coords) return null;
		const wantType: TrackType = mediaType === "audio" ? "audio" : "video";
		const tracks = orderedTracks({ sceneTracks: this.config.getSceneTracks() });
		const hovered = getTrackAtY({ mouseY: coords.mouseY, tracks });
		if (!hovered) return null;
		const track = tracks[hovered.trackIndex];
		if (!track || track.type !== wantType) return null;
		const occupied = track.elements.some(
			(element) =>
				element.startTime <= dropX &&
				dropX < addMediaTime({ a: element.startTime, b: element.duration }),
		);
		return occupied ? track.id : null;
	}

	/**
	 * INSERT edit (Premiere-style, but our default): drop the asset(s) at the target
	 * clip's start on `targetTrackId` and push every downstream clip on that lane
	 * right by the inserted duration to open a hole — nothing is overwritten. A
	 * dropped video's source audio is separated onto its own audio lane, which is
	 * itself rippled at the same insert point so the pair stays ganged. The whole
	 * thing is ONE BatchCommand, ordered shift-first (open the hole before the
	 * insert), so a single Ctrl+Z undoes it. Mirrors the ripple-cut of
	 * RemoveRangesCommand in reverse (see placement/ripple-insert.ts).
	 *
	 * A multi-select drag (`dragData.mediaIds.length > 1`) lays out the WHOLE
	 * selection: the lane ripples ONCE by the SUMMED insert duration and every
	 * selected asset is inserted back-to-back at the hole (cascaded starts) — never
	 * silently dropping all but the dragged id. Same one-undo batch; each video's
	 * separated audio stays in it.
	 */
	private executeMediaRippleInsert({
		dragData,
		targetTrackId,
		dropX,
	}: {
		dragData: Extract<TimelineDragData, { type: "media" }>;
		targetTrackId: string;
		dropX: MediaTime;
	}): void {
		const sceneTracks = this.config.getSceneTracks();
		const track = orderedTracks({ sceneTracks }).find(
			(candidate) => candidate.id === targetTrackId,
		);
		if (!track) return;

		// Multi-select drags carry the whole selection; a single drag carries only
		// its own id. Resolve each to an asset with a real duration, preserving the
		// drag order so the cascade matches the bin selection.
		const ids =
			dragData.mediaIds && dragData.mediaIds.length > 1
				? dragData.mediaIds
				: [dragData.id];
		const allAssets = this.config.getMediaAssets();
		const resolved = ids
			.map((id) => allAssets.find((candidate) => candidate.id === id))
			.filter(
				(mediaAsset): mediaAsset is MediaAsset =>
					!!mediaAsset &&
					toElementDurationTicks({ seconds: mediaAsset.duration }) >
						ZERO_MEDIA_TIME,
			)
			.map((mediaAsset) => ({
				mediaAsset,
				duration: toElementDurationTicks({ seconds: mediaAsset.duration }),
			}));
		// Members compatible with the target lane type ripple into it (the same-type
		// and single-asset paths hit this exclusively). Track-incompatible members of
		// a MIXED multi-select (e.g. an audio file dropped with a video onto a video
		// lane) must NOT be silently dropped — they divert onto a fresh track of their
		// own type in this SAME batch (see the divert loop below).
		const inserts = resolved.filter(({ mediaAsset }) =>
			canElementGoOnTrack({
				elementType: mediaAsset.type,
				trackType: track.type,
			}),
		);
		const diverted = resolved.filter(
			({ mediaAsset }) =>
				!canElementGoOnTrack({
					elementType: mediaAsset.type,
					trackType: track.type,
				}),
		);
		if (inserts.length === 0 && diverted.length === 0) return;

		// The lane must open ONE hole wide enough for every asset, so it ripples by
		// the SUMMED duration; the same summed shift drives the audio lane's ripple
		// and straddle-split so the two stay aligned.
		const summedDuration = inserts.reduce(
			(total, { duration }) => addMediaTime({ a: total, b: duration }),
			ZERO_MEDIA_TIME,
		);

		// Anchor the insert at the start of the clip under the cursor (the cut
		// boundary), so the ripple opens a clean hole and the new clips land on a
		// cut point. Empty spot on the lane => insert at the raw drop point.
		const clipAtDrop = track.elements.find(
			(element) =>
				element.startTime <= dropX &&
				dropX < addMediaTime({ a: element.startTime, b: element.duration }),
		);
		const insertStart = clipAtDrop ? clipAtDrop.startTime : dropX;

		// Never ripple/split an authored lane: a direct audio drop onto an authored
		// render's separated-audio lane (or any lane whose shifted/straddled clip is
		// authored) diverts to a fresh track instead. Same invariant the covered-clip
		// guard enforces for a video-target drop. insertMediaOnNewTrack lays out the
		// whole selection too (it reads dragData.mediaIds).
		if (this.laneRippleTouchesAuthored({ lane: track, insertStart })) {
			this.insertMediaOnNewTrack({
				target: {
					isNewTrack: true,
					trackIndex: 0,
					insertPosition: null,
					xPosition: insertStart,
					targetElement: null,
				},
				dragData,
			});
			return;
		}

		const commands: Command[] = [];

		// 1) Open the hole: shift the target lane's downstream clips right by the
		// summed duration (once, for the whole selection).
		const laneShifts = computeRippleInsertShifts({
			elements: track.elements,
			insertStart,
			shiftDuration: summedDuration,
		});
		if (laneShifts.length > 0) {
			commands.push(
				new UpdateElementsCommand({
					updates: laneShifts.map((shift) => ({
						trackId: track.id,
						elementId: shift.id,
						patch: { startTime: shift.startTime },
					})),
				}),
			);
		}

		// Resolve the shared separated-audio lane ONCE (lazy, only if a dropped video
		// actually separates). If rippling/splitting the first audio track would
		// disturb an authored (HyperFrames) clip, divert every separated audio onto a
		// FRESH lane instead so the authored A/V gang is never broken.
		const firstAudioTrack = orderedTracks({ sceneTracks }).find(
			(candidate) => candidate.type === "audio",
		);
		const rippleAudioTrack =
			firstAudioTrack &&
			!this.laneRippleTouchesAuthored({ lane: firstAudioTrack, insertStart })
				? firstAudioTrack
				: undefined;
		let resolvedAudioTrackId: string | null = null;
		const ensureAudioTrackId = (): string => {
			if (resolvedAudioTrackId) return resolvedAudioTrackId;
			resolvedAudioTrackId = rippleAudioTrack
				? rippleAudioTrack.id
				: this.createAudioTrackInto(commands);
			return resolvedAudioTrackId;
		};

		// 2) Ripple the reused audio lane's downstream clips + split any straddler by
		// the SAME summed duration, ONCE, BEFORE inserting the separated audio — so
		// the hole is open under every separated-audio insert. Only needed when at
		// least one dropped video actually has separable source audio (freshly-built
		// video elements keep source audio enabled, so it reduces to a video asset
		// whose audio wasn't detected absent — mirrors buildSeparatedVideoAudioPair).
		const anySeparableAudio = inserts.some(
			({ mediaAsset }) =>
				mediaAsset.type === "video" && mediaAsset.hasAudio !== false,
		);
		if (rippleAudioTrack && anySeparableAudio) {
			// A clip that starts BEFORE insertStart but extends PAST it is not caught
			// by computeRippleInsertShifts, so the ripple leaves no hole under it and
			// the separated audio would overlap it — silent A/V-sync corruption. Split
			// it at insertStart first (head stays put, source-aligned tail moves past
			// the whole hole) so a gap-free hole opens. Same batch = one undo.
			const straddler = findStraddlingElement({
				elements: rippleAudioTrack.elements,
				insertStart,
			});
			const split = straddler
				? computeStraddleSplit({
						element: straddler,
						insertStart,
						shiftDuration: summedDuration,
					})
				: null;
			// Order: head-shrink → downstream shifts → tail insert. Emitting the shifts
			// BEFORE the tail insert means the tail lands into an already-open hole with
			// no transient in-batch overlap (both resolve correctly either way, but this
			// keeps every intermediate state gap-free).
			if (split) {
				commands.push(
					new UpdateElementsCommand({
						updates: [
							{
								trackId: rippleAudioTrack.id,
								elementId: split.headPatch.id,
								patch: {
									duration: split.headPatch.duration,
									trimEnd: split.headPatch.trimEnd,
									animations: split.headPatch.animations,
								},
							},
						],
					}),
				);
			}
			const audioShifts = computeRippleInsertShifts({
				elements: rippleAudioTrack.elements,
				insertStart,
				shiftDuration: summedDuration,
			});
			if (audioShifts.length > 0) {
				commands.push(
					new UpdateElementsCommand({
						updates: audioShifts.map((shift) => ({
							trackId: rippleAudioTrack.id,
							elementId: shift.id,
							patch: { startTime: shift.startTime },
						})),
					}),
				);
			}
			if (split) {
				commands.push(
					new InsertElementCommand({
						element: split.tail,
						placement: { mode: "explicit", trackId: rippleAudioTrack.id },
					}),
				);
			}
		}

		// 3) Insert every asset back-to-back at the hole (cascaded starts). Skip the
		// main-track snap-to-0 rule: the ripple already opened a gap-free hole at
		// exactly insertStart, so enforcing "no leading gap" would slide the clips to
		// 0 and desync them from their linked audio (inserted unsnapped at the same
		// cascaded start).
		let cascade = insertStart;
		for (const { mediaAsset, duration } of inserts) {
			const video = buildElementFromMedia({
				mediaId: mediaAsset.id,
				mediaType: mediaAsset.type,
				name: mediaAsset.name,
				duration,
				startTime: cascade,
			});
			const pair =
				video.type === "video"
					? buildSeparatedVideoAudioPair({ videoElement: video, mediaAsset })
					: null;
			commands.push(
				new InsertElementCommand({
					element: pair ? pair.video : video,
					placement: {
						mode: "explicit",
						trackId: track.id,
						skipMainTrackStart: true,
					},
				}),
			);
			if (pair) {
				commands.push(
					new InsertElementCommand({
						element: pair.audio,
						placement: { mode: "explicit", trackId: ensureAudioTrackId() },
					}),
				);
			}
			cascade = addMediaTime({ a: cascade, b: duration });
		}

		// 4) A MIXED multi-select drops members whose type can't live on the ripple
		// lane (e.g. an audio file alongside a video, dropped onto a video lane). Never
		// discard them: lay each out on a FRESH track of its own type (packed per type,
		// cascaded from insertStart) inside THIS batch, so nothing is lost and it stays
		// one undo. A diverted video keeps its separated audio ganged on its own fresh
		// audio lane. The ripple lane is untouched by these (its type differs).
		if (diverted.length > 0) {
			const divertTrackForType = new Map<TrackType, string>();
			const ensureDivertTrack = (type: TrackType): string => {
				const existing = divertTrackForType.get(type);
				if (existing) return existing;
				const addTrackCmd = new AddTrackCommand({ type });
				divertTrackForType.set(type, addTrackCmd.getTrackId());
				commands.push(addTrackCmd);
				return addTrackCmd.getTrackId();
			};
			let divertCascade = insertStart;
			for (const { mediaAsset, duration } of diverted) {
				const element = buildElementFromMedia({
					mediaId: mediaAsset.id,
					mediaType: mediaAsset.type,
					name: mediaAsset.name,
					duration,
					startTime: divertCascade,
				});
				const pair =
					element.type === "video"
						? buildSeparatedVideoAudioPair({ videoElement: element, mediaAsset })
						: null;
				const trackType: TrackType =
					mediaAsset.type === "audio" ? "audio" : "video";
				commands.push(
					new InsertElementCommand({
						element: pair ? pair.video : element,
						placement: {
							mode: "explicit",
							trackId: ensureDivertTrack(trackType),
						},
					}),
				);
				if (pair) {
					commands.push(
						new InsertElementCommand({
							element: pair.audio,
							placement: {
								mode: "explicit",
								trackId: ensureDivertTrack("audio"),
							},
						}),
					);
				}
				divertCascade = addMediaTime({ a: divertCascade, b: duration });
			}
		}

		if (commands.length > 0) {
			this.config.executeCommand(new BatchCommand(commands));
		}
	}

	private createAudioTrackInto(commands: Command[]): string {
		const addAudioTrack = new AddTrackCommand({ type: "audio" });
		commands.push(addAudioTrack);
		return addAudioTrack.getTrackId();
	}

	/** Insert several bin assets at the drop point, laid out sequentially. */
	private insertMediaAssetsSequential({
		ids,
		target,
		coords,
	}: {
		ids: string[];
		target: DropTarget;
		coords: TimelineCoords | null;
	}): void {
		const assets = this.config.getMediaAssets();
		// Build ONE BatchCommand for the whole multi-drop so a single Ctrl+Z undoes
		// it (previously each asset was its own command — undo peeled them off one
		// at a time). Reuse one track PER TYPE so same-type assets pack onto a
		// single track back-to-back, and resolve each asset at its CASCADED slot
		// (startTimeOverride) — checking the raw drop point instead made every clip
		// after the first see the prior clip there and spawn a fresh track.
		const commands: Command[] = [];
		const trackForType = new Map<TrackType, string>();
		// All separated source-audio from this drop packs onto ONE shared audio track
		// (created once, reused) so N videos never explode into N audio tracks — the
		// reason the per-asset toggle was dropped from this path. Lazy, so a drop with
		// no separable video adds no empty audio track.
		let separatedAudioTrackId: string | null = null;
		const ensureSeparatedAudioTrack = (): string => {
			if (separatedAudioTrackId) return separatedAudioTrackId;
			const addAudioTrack = new AddTrackCommand({ type: "audio" });
			separatedAudioTrackId = addAudioTrack.getTrackId();
			commands.push(addAudioTrack);
			return separatedAudioTrackId;
		};
		const baseStart = target.xPosition;
		let cascadeOffsetTicks = 0;
		for (const id of ids) {
			const mediaAsset = assets.find((asset) => asset.id === id);
			if (!mediaAsset) continue;
			const trackType: TrackType =
				mediaAsset.type === "audio" ? "audio" : "video";
			const duration = toElementDurationTicks({ seconds: mediaAsset.duration });
			const startTime = mediaTime({ ticks: baseStart + cascadeOffsetTicks });
			const element = buildElementFromMedia({
				mediaId: mediaAsset.id,
				mediaType: mediaAsset.type,
				name: mediaAsset.name,
				duration,
				startTime,
			});

			// Premiere-style audio separation (parity with the single-asset + "+"
			// paths): a video's source audio is split onto the shared audio track,
			// linked to the (pre-marked) video — all within this one batch, so the
			// drop stays a single undo. Regression restored from the one-undo refactor.
			const pair =
				element.type === "video"
					? buildSeparatedVideoAudioPair({ videoElement: element, mediaAsset })
					: null;
			const elementToInsert = pair ? pair.video : element;

			// Resolve the track for this type ONCE (reuse, or create at the cascaded
			// slot so a free main track is reused rather than a new one spawned).
			let trackId = trackForType.get(trackType) ?? null;
			if (!trackId) {
				const assetTarget = coords
					? computeDropTarget({
							elementType: mediaAsset.type,
							mouseX: coords.mouseX,
							mouseY: coords.mouseY,
							tracks: this.config.getSceneTracks(),
							playheadTime: this.config.getCurrentPlayheadTime(),
							isExternalDrop: false,
							elementDuration: duration,
							pixelsPerSecond: BASE_TIMELINE_PIXELS_PER_SECOND,
							zoomLevel: this.config.zoomLevel,
							startTimeOverride: startTime,
						})
					: { ...target, xPosition: startTime };
				if (assetTarget.isNewTrack) {
					const addTrackCmd = new AddTrackCommand({
						type: trackType,
						index: assetTarget.trackIndex,
					});
					trackId = addTrackCmd.getTrackId();
					commands.push(addTrackCmd);
				} else {
					const track = orderedTracks({
						sceneTracks: this.config.getSceneTracks(),
					})[assetTarget.trackIndex];
					if (!track) continue;
					trackId = track.id;
				}
				trackForType.set(trackType, trackId);
			}

			commands.push(
				new InsertElementCommand({
					element: elementToInsert,
					placement: { mode: "explicit", trackId },
				}),
			);
			if (pair) {
				commands.push(
					new InsertElementCommand({
						element: pair.audio,
						placement: {
							mode: "explicit",
							trackId: ensureSeparatedAudioTrack(),
						},
					}),
				);
			}
			cascadeOffsetTicks += duration;
		}

		if (commands.length > 0) {
			this.config.executeCommand(new BatchCommand(commands));
		}
	}

	/**
	 * Overwrite at the drop point with the dragged asset (Premiere "overwrite"):
	 * the new clip keeps its OWN full length and starts where the old clip did.
	 * Anything it now covers is cleared — fully-covered clips deleted, a straddled
	 * clip head-trimmed — with NO ripple (downstream clips keep their start). The
	 * deletes, trims and the insert run as one BatchCommand → a single undo.
	 *
	 * The main-track earliest-element snap (old A1/C1 bug) is handled by the
	 * insert-first command ordering below. A head-trimmed survivor's source
	 * in-point is retime-aware (planRegionOverwrite scales the cut by the element's
	 * rate), so a speed-ramped clip keeps the right in-point.
	 */
	private executeMediaOverwrite({
		target,
		dragData,
	}: {
		target: DropTarget;
		dragData: Extract<TimelineDragData, { type: "media" }>;
	}): void {
		const replaced = target.targetElement;
		if (!replaced) return;
		const sceneTracks = this.config.getSceneTracks();
		const track = orderedTracks({ sceneTracks }).find(
			(candidate) => candidate.id === replaced.trackId,
		);
		const existing = track?.elements.find(
			(element) => element.id === replaced.elementId,
		);
		if (!track || !existing) return;
		const mediaAsset = this.config
			.getMediaAssets()
			.find((asset) => asset.id === dragData.id);
		if (!mediaAsset) return;

		// Bail before any destructive command on an incompatible drop (e.g. a video
		// dropped onto a graphic/text clip): the region-clear would delete the
		// covered clips and then the type-mismatched insert would be rejected,
		// leaving a hole. Doing nothing is safer than losing the covered clips.
		if (
			!canElementGoOnTrack({
				elementType: mediaAsset.type,
				trackType: track.type,
			})
		) {
			return;
		}

		// The new clip keeps its OWN full length and starts where the old clip did;
		// everything it now covers is cleared/head-trimmed without rippling.
		const newMediaDuration = toElementDurationTicks({
			seconds: mediaAsset.duration,
		});
		// A zero-length asset clears nothing and would drop a 0-tick clip on top.
		if (newMediaDuration <= ZERO_MEDIA_TIME) return;
		const regionStart = existing.startTime;
		const regionEnd = addMediaTime({ a: regionStart, b: newMediaDuration });

		// The covered-clip guard (executeMediaDrop) only checks the clip directly
		// under the cursor. A longer overwrite region can reach a DOWNSTREAM authored
		// (HyperFrames) clip on the same lane, which planRegionOverwrite would delete
		// or head-trim with no authored check — violating "never overwrite an authored
		// overlay". Mirror laneRippleTouchesAuthored: if ANY element intersecting the
		// region is authored, divert onto a fresh track (never touch it, never lose
		// the media), exactly like the covered-clip guard.
		const regionTouchesAuthored = track.elements.some((element) => {
			const elEnd = addMediaTime({ a: element.startTime, b: element.duration });
			const intersects = element.startTime < regionEnd && elEnd > regionStart;
			return intersects && isElementAuthored({ element, sceneTracks });
		});
		if (regionTouchesAuthored) {
			this.insertMediaOnNewTrack({ target, dragData });
			return;
		}

		const plan = planRegionOverwrite({
			elements: track.elements.map((element) => ({
				id: element.id,
				startTime: element.startTime,
				duration: element.duration,
				trimStart: element.trimStart,
				rate:
					"retime" in element && element.retime ? element.retime.rate : 1,
			})),
			regionStart,
			regionEnd,
		});

		const element = buildElementFromMedia({
			mediaId: mediaAsset.id,
			mediaType: mediaAsset.type,
			name: mediaAsset.name,
			duration: newMediaDuration,
			startTime: existing.startTime,
		});

		// Order matters: INSERT the new clip FIRST. On the main track it anchors
		// regionStart, so a head-trimmed survivor is never the earliest element when
		// its UpdateElementsCommand runs — otherwise the main-track startTime
		// enforce-rule (update-pipeline.ts) snaps that survivor to 0 and overlaps the
		// insert (the old A1/C1 bug). Explicit placement just appends (it does NOT
		// reject the transient overlap with the not-yet-deleted clips), and the
		// deletes run last to clear the covered region. Verified in-browser for both
		// the longer-onto-first-clip and shorter-onto-only-clip cases.
		const commands: Command[] = [
			new InsertElementCommand({
				placement: { mode: "explicit", trackId: replaced.trackId },
				element,
			}),
		];
		for (const trim of plan.trims) {
			commands.push(
				new UpdateElementsCommand({
					updates: [
						{
							trackId: replaced.trackId,
							elementId: trim.id,
							patch: {
								startTime: mediaTime({ ticks: trim.startTime }),
								trimStart: mediaTime({ ticks: trim.trimStart }),
								duration: mediaTime({ ticks: trim.duration }),
							},
						},
					],
				}),
			);
		}
		if (plan.deleteIds.length > 0) {
			commands.push(
				new DeleteElementsCommand({
					elements: plan.deleteIds.map((elementId) => ({
						trackId: replaced.trackId,
						elementId,
					})),
				}),
			);
		}
		this.config.executeCommand(new BatchCommand(commands));
	}

	private executeEffectDrop({
		target,
		dragData,
	}: {
		target: DropTarget;
		dragData: Extract<TimelineDragData, { type: "effect" }>;
	}): void {
		if (target.targetElement) {
			this.config.addClipEffect({
				trackId: target.targetElement.trackId,
				elementId: target.targetElement.elementId,
				effectType: dragData.effectType,
			});
			return;
		}

		const element = buildEffectElement({
			effectType: dragData.effectType,
			startTime: target.xPosition,
		});

		const existingEffectTrack = orderedTracks({
			sceneTracks: this.config.getSceneTracks(),
		}).find((track) => track.type === "effect");

		if (existingEffectTrack) {
			this.config.insertElement({
				placement: { mode: "explicit", trackId: existingEffectTrack.id },
				element,
			});
			return;
		}

		this.insertAtTarget({ element, target, trackType: "effect" });
	}

	private async executeFileDrop({
		files,
		mouseX,
		mouseY,
	}: {
		files: File[];
		mouseX: number;
		mouseY: number;
	}): Promise<void> {
		const projectId = this.config.getActiveProjectId();
		if (!projectId) return;

		await showMediaUploadToast({
			filesCount: files.length,
			promise: async () => {
				const processedAssets = await processMediaAssets({ files });

				// Lay multiple dropped files back-to-back: without this, files 2..N
				// all resolve to the SAME mouse position and stack on top of each
				// other (looking like only one landed). The cursor advances by each
				// inserted clip's duration. Stays 0 for a single-file drop.
				let cascadeOffsetTicks = 0;

				// Sequential on purpose: each iteration reads getSceneTracks()
				// to decide placement (reuse empty main vs new track) and that
				// decision depends on the effects of prior inserts.
				for (const asset of processedAssets) {
					const createdAsset = await this.config.addMediaAsset({
						projectId,
						asset,
					});
					if (!createdAsset) continue;

					const duration = toElementDurationTicks({
						seconds: createdAsset.duration,
					});

					const sceneTracks = this.config.getSceneTracks();
					const currentTime = this.config.getCurrentPlayheadTime();

					const reuseMainTrackId =
						createdAsset.type !== "audio" &&
						sceneTracks.overlay.length === 0 &&
						sceneTracks.audio.length === 0 &&
						sceneTracks.main.elements.length === 0
							? sceneTracks.main.id
							: null;

					if (reuseMainTrackId) {
						const insertCmd = new InsertElementCommand({
							placement: { mode: "explicit", trackId: reuseMainTrackId },
							element: buildElementFromMedia({
								mediaId: createdAsset.id,
								mediaType: createdAsset.type,
								name: createdAsset.name,
								duration,
								startTime: currentTime,
							}),
						});
						this.config.executeCommand(insertCmd);
						this.maybeSeparateAudio({
							asset: createdAsset,
							elementId: insertCmd.getElementId(),
							trackId: reuseMainTrackId,
						});
						cascadeOffsetTicks += duration;
						continue;
					}

					const dropTarget = computeDropTarget({
						elementType: createdAsset.type,
						mouseX,
						mouseY,
						tracks: sceneTracks,
						playheadTime: currentTime,
						isExternalDrop: true,
						elementDuration: duration,
						pixelsPerSecond: BASE_TIMELINE_PIXELS_PER_SECOND,
						zoomLevel: this.config.zoomLevel,
					});

					// Offset each subsequent file past the previous one so a
					// multi-file drop lays out sequentially instead of overlapping.
					dropTarget.xPosition = mediaTime({
						ticks: dropTarget.xPosition + cascadeOffsetTicks,
					});

					const trackType: TrackType =
						createdAsset.type === "audio" ? "audio" : "video";
					const inserted = this.insertAtTarget({
						element: buildElementFromMedia({
							mediaId: createdAsset.id,
							mediaType: createdAsset.type,
							name: createdAsset.name,
							duration,
							startTime: dropTarget.xPosition,
						}),
						target: dropTarget,
						trackType,
					});
					this.maybeSeparateAudio({ asset: createdAsset, ...inserted });
					cascadeOffsetTicks += duration;
				}

				return {
					uploadedCount: processedAssets.length,
					assetNames: processedAssets.map((asset) => asset.name),
				};
			},
		});
	}
}

/**
 * Drop keyboard focus from a lingering control (a dragged bin tile / button) so
 * bare-key shortcuts fire immediately after a drop. Skips text inputs so an
 * in-progress rename isn't interrupted.
 */
function blurActiveElementForShortcuts(): void {
	const active = document.activeElement;
	if (
		active instanceof HTMLElement &&
		active.tagName !== "INPUT" &&
		active.tagName !== "TEXTAREA" &&
		!active.isContentEditable
	) {
		active.blur();
	}
}
