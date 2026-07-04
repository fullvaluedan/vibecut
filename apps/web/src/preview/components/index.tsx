"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useDeepCompareEffect from "use-deep-compare-effect";
import { useEditor } from "@/editor/use-editor";
import { useRafLoop } from "@/hooks/use-raf-loop";
import { useContainerSize } from "@/hooks/use-container-size";
import { useFullscreen } from "@/hooks/use-fullscreen";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import { AiOverlayPreviewLayer } from "@/features/ai-generate/components/overlay-preview-layer";
import { PlaceToolOverlay } from "./place-tool-overlay";
import { TICKS_PER_SECOND, type MediaTime, mediaTimeToSeconds } from "@/wasm";
import type { RootNode } from "@/services/renderer/nodes/root-node";
import { buildScene } from "@/services/renderer/scene-builder";
import { videoCache } from "@/services/video-cache/service";
import {
	type ActiveMediaSpan,
	type PrefetchClip,
	resolveBoundaryPrefetch,
} from "@/services/video-cache/boundary-prefetch";
import { PreviewOverlayLayer } from "./overlay-layer";
import { PreviewInteractionOverlay } from "./preview-interaction-overlay";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import type {
	PreviewOverlayControl,
	PreviewOverlayInstance,
} from "@/preview/overlays";
import { PreviewContextMenu } from "./context-menu";
import { PreviewToolbar } from "./toolbar";
import {
	PreviewViewportProvider,
	usePreviewViewportState,
} from "./preview-viewport";

/**
 * Vertical headroom (px) the interaction/handle overlay is allowed to paint
 * beyond the viewport top/bottom edges before being clipped. Must cover the
 * rotation handle, which sits ROTATION_HANDLE_OFFSET (24px) above an element's
 * top edge with an additional ICON_HANDLE_RADIUS (10px) hit radius — so a
 * full-bleed element (top edge at the canvas/viewport top) keeps its rotation
 * and top-corner handles grabbable. Bounded so handles never reach adjacent
 * panels.
 */
const HANDLE_OVERLAY_HEADROOM_PX = 36;

function usePreviewSize() {
	const canvasSize = useEditor(
		(e) => e.project.getActive()?.settings.canvasSize,
	);

	return {
		width: canvasSize?.width,
		height: canvasSize?.height,
	};
}

function normalizeWheelDelta({
	delta,
	deltaMode,
	pageSize,
}: {
	delta: number;
	deltaMode: number;
	pageSize: number;
}): number {
	if (deltaMode === WheelEvent.DOM_DELTA_LINE) {
		return delta * 16;
	}

	if (deltaMode === WheelEvent.DOM_DELTA_PAGE) {
		return delta * pageSize;
	}

	return delta;
}

export function PreviewPanel({
	overlayControls,
	overlayInstances,
	onOverlayVisibilityChange,
}: {
	overlayControls: PreviewOverlayControl[];
	overlayInstances: PreviewOverlayInstance[];
	onOverlayVisibilityChange: (params: {
		overlayId: string;
		isVisible: boolean;
	}) => void;
}) {
	const containerRef = useRef<HTMLDivElement>(null);
	const [container, setContainer] = useState<HTMLDivElement | null>(null);
	const { toggleFullscreen } = useFullscreen({ containerRef });
	const handleContainerRef = useCallback((node: HTMLDivElement | null) => {
		containerRef.current = node;
		setContainer(node);
	}, []);

	return (
		<div
			ref={handleContainerRef}
			className="panel bg-background relative flex size-full min-h-0 min-w-0 flex-col rounded-sm border"
		>
			<PreviewCanvas
				container={container}
				onToggleFullscreen={toggleFullscreen}
				overlayControls={overlayControls}
				overlayInstances={overlayInstances}
				onOverlayVisibilityChange={onOverlayVisibilityChange}
			/>
			<RenderTreeController />
		</div>
	);
}

function RenderTreeController() {
	const editor = useEditor();
	const tracks = useEditor(
		(e) => e.timeline.getPreviewTracks() ?? e.scenes.getActiveScene().tracks,
	);
	const mediaAssets = useEditor((e) => e.media.getAssets());
	const activeProject = useEditor((e) => e.project.getActive());

	const { width, height } = usePreviewSize();

	useDeepCompareEffect(() => {
		if (!activeProject) return;

		const duration = editor.timeline.getTotalDuration();
		const renderTree = buildScene({
			tracks,
			mediaAssets,
			duration,
			canvasSize: { width, height },
			background: activeProject.settings.background,
			isPreview: true,
		});

		editor.renderer.setRenderTree({ renderTree });
	}, [tracks, mediaAssets, activeProject?.settings.background, width, height]);

	return null;
}

function PreviewCanvas({
	container,
	onToggleFullscreen,
	overlayControls,
	overlayInstances,
	onOverlayVisibilityChange,
}: {
	container: HTMLElement | null;
	onToggleFullscreen: () => void;
	overlayControls: PreviewOverlayControl[];
	overlayInstances: PreviewOverlayInstance[];
	onOverlayVisibilityChange: (params: {
		overlayId: string;
		isVisible: boolean;
	}) => void;
}) {
	const canvasMountRef = useRef<HTMLDivElement>(null);
	const viewportRef = useRef<HTMLDivElement>(null);
	const lastFrameRef = useRef(-1);
	const lastSceneRef = useRef<RootNode | null>(null);
	const renderingRef = useRef(false);
	// Which cut boundary we last warmed, so the prefetch fires once per approach
	// instead of every playback frame inside the lookahead window (U8).
	const lastPrefetchBoundaryRef = useRef<string | null>(null);
	const { width: nativeWidth, height: nativeHeight } = usePreviewSize();
	const viewportSize = useContainerSize({ containerRef: viewportRef });
	const editor = useEditor();
	const activeProject = useEditor((e) => e.project.getActive());
	const renderTree = useEditor((e) => e.renderer.getRenderTree());
	const previewTracks = useEditor(
		(e) => e.timeline.getPreviewTracks() ?? e.scenes.getActiveScene().tracks,
	);
	const mediaAssets = useEditor((e) => e.media.getAssets());

	// Sorted main-track (V1) video clips + their source files, for the U8
	// boundary prefetch. Rebuilt only when the tracks or media change (never per
	// frame; the render loop below reads this snapshot imperatively).
	const prefetchPlan = useMemo(() => {
		const clips: PrefetchClip[] = [];
		const fileByMediaId = new Map<string, File>();
		const mediaMap = new Map(mediaAssets.map((asset) => [asset.id, asset]));

		const elements = previewTracks.main.elements
			.filter((element) => element.type === "video" && !element.hidden)
			.slice()
			.sort((a, b) => a.startTime - b.startTime);

		for (const element of elements) {
			if (element.type !== "video") continue;
			// framecutAi / alpha clips render through the DOM overlay, not the
			// video-cache decode path, so there is nothing to warm for them.
			if (element.framecutAi) continue;
			const asset = mediaMap.get(element.mediaId);
			if (!asset?.file || asset.type !== "video" || asset.hasAlpha) continue;

			const startSec = mediaTimeToSeconds({ time: element.startTime });
			const durationSec = mediaTimeToSeconds({ time: element.duration });
			clips.push({
				mediaId: element.mediaId,
				startSec,
				endSec: startSec + durationSec,
				sourceStartSec: mediaTimeToSeconds({ time: element.trimStart }),
			});
			fileByMediaId.set(element.mediaId, asset.file);
		}

		// Overlay/PiP video spans (review F8): a prefetch must never touch media one
		// of these lanes is actively decoding, since sinks are shared per mediaId.
		const overlaySpans: ActiveMediaSpan[] = [];
		for (const track of previewTracks.overlay) {
			for (const element of track.elements) {
				if (element.type !== "video" || element.hidden) continue;
				if (element.framecutAi) continue;
				const asset = mediaMap.get(element.mediaId);
				if (!asset?.file || asset.type !== "video" || asset.hasAlpha) continue;
				const startSec = mediaTimeToSeconds({ time: element.startTime });
				overlaySpans.push({
					mediaId: element.mediaId,
					startSec,
					endSec: startSec + mediaTimeToSeconds({ time: element.duration }),
				});
			}
		}

		return { clips, fileByMediaId, overlaySpans };
	}, [previewTracks, mediaAssets]);

	const viewport = usePreviewViewportState({
		canvasHeight: nativeHeight,
		canvasWidth: nativeWidth,
		viewportHeight: viewportSize.height,
		viewportRef,
		viewportWidth: viewportSize.width,
	});
	const { canPan, panByScreenDelta, scaleZoom } = viewport;

	const renderer = useMemo(() => {
		return new CanvasRenderer({
			width: nativeWidth,
			height: nativeHeight,
			fps: activeProject.settings.fps,
		});
	}, [nativeWidth, nativeHeight, activeProject.settings.fps]);

	// Mount the compositor's output canvas directly into the preview. wgpu
	// renders straight into this element, so there is no intermediate copy —
	// the container div owns positioning/styling, the canvas itself fills it.
	useEffect(() => {
		const mount = canvasMountRef.current;
		if (!mount) return;
		const outputCanvas = renderer.getOutputCanvas();
		outputCanvas.style.display = "block";
		outputCanvas.style.width = "100%";
		outputCanvas.style.height = "100%";
		mount.appendChild(outputCanvas);
		return () => {
			if (outputCanvas.parentElement === mount) {
				mount.removeChild(outputCanvas);
			}
		};
	}, [renderer]);

	const render = useCallback(() => {
		if (!renderTree) return;

		const renderTime = Math.min(
			editor.playback.getCurrentTime(),
			editor.timeline.getLastFrameTime(),
		);

		// U8: warm the next clip's decode before the playhead crosses the cut
		// boundary, so the crossing hits the fast-path instead of a cold deep
		// seek that would blow the frame budget and drop ticks. Runs regardless
		// of an in-flight render (below) so the warm still happens while the
		// current frame's decode is busy. Playback-only; a real scrub still wins
		// via supersede-by-time in the cache (KTD3).
		if (editor.playback.getIsPlaying()) {
			const target = resolveBoundaryPrefetch({
				clips: prefetchPlan.clips,
				playheadSec: mediaTimeToSeconds({ time: renderTime as MediaTime }),
				overlaySpans: prefetchPlan.overlaySpans,
			});
			if (target) {
				const boundaryKey = `${target.mediaId}@${target.sourceTimeSec}`;
				if (boundaryKey !== lastPrefetchBoundaryRef.current) {
					lastPrefetchBoundaryRef.current = boundaryKey;
					const file = prefetchPlan.fileByMediaId.get(target.mediaId);
					if (file) {
						videoCache.prefetchFrameAt({
							mediaId: target.mediaId,
							file,
							time: target.sourceTimeSec,
						});
					}
				}
			} else {
				lastPrefetchBoundaryRef.current = null;
			}
		}

		if (renderingRef.current) return;

		const ticksPerFrame = Math.round(
			(TICKS_PER_SECOND * renderer.fps.denominator) / renderer.fps.numerator,
		);
		const frame = Math.floor(renderTime / ticksPerFrame);

		if (
			frame === lastFrameRef.current &&
			renderTree === lastSceneRef.current
		) {
			return;
		}

		renderingRef.current = true;
		lastSceneRef.current = renderTree;
		lastFrameRef.current = frame;
		renderer
			.render({ node: renderTree, time: renderTime })
			.catch((e) => console.error("preview render failed", e))
			.finally(() => {
				renderingRef.current = false;
			});
	}, [
		renderer,
		renderTree,
		editor.playback,
		editor.timeline,
		prefetchPlan,
	]);

	useRafLoop(render);

	useEffect(() => {
		const container = viewportRef.current;
		if (!container) return;

		let pendingZoomDelta = 0;
		let pendingPanDeltaX = 0;
		let pendingPanDeltaY = 0;
		let zoomRafId: ReturnType<typeof requestAnimationFrame> | null = null;
		let panRafId: ReturnType<typeof requestAnimationFrame> | null = null;

		const onWheel = (event: WheelEvent) => {
			const normalizedDeltaX = normalizeWheelDelta({
				delta: event.deltaX,
				deltaMode: event.deltaMode,
				pageSize: container.clientWidth,
			});
			const normalizedDeltaY = normalizeWheelDelta({
				delta: event.deltaY,
				deltaMode: event.deltaMode,
				pageSize: container.clientHeight,
			});
			const isZoomGesture = event.ctrlKey || event.metaKey;
			if (isZoomGesture) {
				event.preventDefault();
				pendingZoomDelta += normalizedDeltaY;

				if (zoomRafId === null) {
					zoomRafId = requestAnimationFrame(() => {
						const cappedDelta =
							Math.sign(pendingZoomDelta) *
							Math.min(Math.abs(pendingZoomDelta), 30);
						const zoomFactor = Math.exp(-cappedDelta / 300);

						scaleZoom({ factor: zoomFactor });
						pendingZoomDelta = 0;
						zoomRafId = null;
					});
				}

				return;
			}

			if (!canPan) {
				return;
			}

			if (normalizedDeltaX === 0 && normalizedDeltaY === 0) {
				return;
			}

			event.preventDefault();
			pendingPanDeltaX += normalizedDeltaX;
			pendingPanDeltaY += normalizedDeltaY;

			if (panRafId === null) {
				panRafId = requestAnimationFrame(() => {
					panByScreenDelta({
						deltaX: pendingPanDeltaX,
						deltaY: pendingPanDeltaY,
					});
					pendingPanDeltaX = 0;
					pendingPanDeltaY = 0;
					panRafId = null;
				});
			}
		};

		container.addEventListener("wheel", onWheel, {
			capture: true,
			passive: false,
		});

		return () => {
			container.removeEventListener("wheel", onWheel, {
				capture: true,
			});
			if (zoomRafId !== null) {
				cancelAnimationFrame(zoomRafId);
			}
			if (panRafId !== null) {
				cancelAnimationFrame(panRafId);
			}
		};
	}, [canPan, panByScreenDelta, scaleZoom]);

	return (
		<PreviewViewportProvider value={viewport}>
			<div className="flex size-full min-h-0 min-w-0 flex-col">
				<div className="flex min-h-0 min-w-0 flex-1 p-2 pb-0">
					<ContextMenu>
						<ContextMenuTrigger asChild>
							<div
								ref={viewportRef}
								className="relative flex size-full min-h-0 min-w-0 items-center justify-center overflow-visible"
							>
							{/*
							  Scene layer: clipped to the viewport box so the rendered
							  canvas + letterbox stay bounded when zoomed in (the canvas
							  mount can exceed the viewport at >100% zoom). The
							  interaction/handle overlay further below is intentionally
							  NOT inside this clip so a full-bleed element's rotation +
							  top-corner handles stay grabbable past the canvas top edge.
							*/}
							<div className="pointer-events-none absolute inset-0 overflow-hidden">
							<div
								ref={canvasMountRef}
								className="absolute block border"
								style={{
									left: viewport.sceneLeft,
									top: viewport.sceneTop,
									width: viewport.sceneWidth,
									height: viewport.sceneHeight,
									background:
										activeProject.settings.background.type === "blur"
											? "transparent"
											: activeProject?.settings.background.color,
								}}
							/>
							<div
								className="pointer-events-none absolute overflow-hidden"
								style={{
									left: viewport.sceneLeft,
									top: viewport.sceneTop,
									width: viewport.sceneWidth,
									height: viewport.sceneHeight,
								}}
							>
								<AiOverlayPreviewLayer />
							</div>
							</div>
								<PlaceToolOverlay
									sceneLeft={viewport.sceneLeft}
									sceneTop={viewport.sceneTop}
									sceneWidth={viewport.sceneWidth}
									sceneHeight={viewport.sceneHeight}
								/>
								{/*
								  Bounded-headroom escape for the interaction/handle overlay.
								  The outer wrapper extends HANDLE_OVERLAY_HEADROOM_PX past the
								  viewport top/bottom and clips there, so handles can paint just
								  beyond the canvas edge (24px rotation offset + 10px hit radius)
								  without escaping into adjacent panels. The inner wrapper shifts
								  the overlay back onto the exact viewport box, so the
								  canvas->overlay coordinate mapping is unchanged.
								*/}
								<div
									className="pointer-events-none absolute inset-x-0 overflow-hidden"
									style={{
										top: -HANDLE_OVERLAY_HEADROOM_PX,
										bottom: -HANDLE_OVERLAY_HEADROOM_PX,
									}}
								>
									<div
										className="absolute inset-x-0"
										style={{
											top: HANDLE_OVERLAY_HEADROOM_PX,
											bottom: HANDLE_OVERLAY_HEADROOM_PX,
										}}
									>
										<PreviewOverlayLayer
											instances={overlayInstances}
											plane="under-interaction"
										/>
										<PreviewInteractionOverlay />
										<PreviewOverlayLayer
											instances={overlayInstances}
											plane="over-interaction"
										/>
									</div>
								</div>
							</div>
						</ContextMenuTrigger>
						<PreviewContextMenu
							onToggleFullscreen={onToggleFullscreen}
							container={container}
							overlayControls={overlayControls}
							onOverlayVisibilityChange={onOverlayVisibilityChange}
						/>
					</ContextMenu>
				</div>
				<PreviewToolbar onToggleFullscreen={onToggleFullscreen} />
			</div>
		</PreviewViewportProvider>
	);
}
