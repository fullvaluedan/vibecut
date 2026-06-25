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
import { BatchCommand } from "@/commands";
import type { Command } from "@/commands/base-command";
import { computeDropTarget } from "@/timeline/components/drop-target";
import type { TimelineDragSource } from "@/timeline/drag-source";
import type {
	TrackType,
	DropTarget,
	ElementType,
	SceneTracks,
	TimelineTrack,
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

interface DragOverState {
	kind: "over";
	dropTarget: DropTarget | null;
	elementType: ElementType | null;
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
			this.setOver({ dropTarget: null, elementType: null });
		}
	}

	onDragOver(event: DragEvent): void {
		event.preventDefault();

		const coords = this.getMouseTimelineCoords({ event });
		if (!coords) return;

		const dragData = this.config.dragSource.getActive();
		const hasFiles = event.dataTransfer.types.includes("Files");
		const isExternal = hasFiles && !dragData;

		if (!dragData) {
			if (hasFiles && isExternal) {
				this.setOver({ dropTarget: null, elementType: null });
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

		this.setOver({ dropTarget: target, elementType });
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
	}: {
		target: DropTarget;
		dragData: TimelineDragData;
		coords: TimelineCoords | null;
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
				this.executeMediaDrop({ target, dragData, coords });
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
	}: {
		target: DropTarget;
		dragData: Extract<TimelineDragData, { type: "media" }>;
		coords: TimelineCoords | null;
	}): void {
		if (target.targetElement) {
			// Drop onto an existing clip → overwrite that clip in place.
			this.executeMediaOverwrite({ target, dragData });
			return;
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
