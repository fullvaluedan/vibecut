"use client";

/**
 * T18.1 crop: on-canvas crop handles, following the TransformHandles pattern
 * (same overlay div, same `handle-primitives` visuals) but deliberately
 * simpler than `TransformHandleController` - a crop drag only ever adjusts
 * ONE fraction on ONE element at a time, so a plain ref + pointer handlers
 * in this component covers it without a dedicated controller class.
 *
 * Rotation IS respected: handle screen positions and drag deltas both go
 * through the same rotate/inverse-rotate math `element-bounds.ts` uses for
 * corner/edge handles, so a rotated clip's crop handles track its rotation
 * instead of silently ignoring it.
 */

import { useEffect, useRef } from "react";
import { useEditor } from "@/editor/use-editor";
import { usePreviewViewport } from "@/preview/components/preview-viewport";
import { useCropModeStore } from "@/preview/crop-mode-store";
import { getVisibleElementsWithBounds, type Edge } from "@/preview/element-bounds";
import { registerCanceller } from "@/editor/cancel-interaction";
import { clampCropRect, NO_CROP } from "@/rendering/crop";
import type { CropRect } from "@/timeline";
import { BoundingBoxOutline, EdgeHandle } from "./handle-primitives";

const CROP_EDGES: Edge[] = ["left", "top", "right", "bottom"];

interface DragState {
	edge: Edge;
	trackId: string;
	elementId: string;
	startCrop: CropRect;
	startCanvas: { x: number; y: number };
	boundsWidth: number;
	boundsHeight: number;
	rotation: number;
}

function rotatePoint({
	x,
	y,
	rotationDeg,
}: {
	x: number;
	y: number;
	rotationDeg: number;
}): { x: number; y: number } {
	const rad = (rotationDeg * Math.PI) / 180;
	const cos = Math.cos(rad);
	const sin = Math.sin(rad);
	return { x: x * cos - y * sin, y: x * sin + y * cos };
}

export function CropHandles() {
	const editor = useEditor();
	const viewport = usePreviewViewport();
	const cropElementId = useCropModeStore((s) => s.elementId);
	const exitCropMode = useCropModeStore((s) => s.exit);
	const tracks = useEditor(
		(e) => e.timeline.getPreviewTracks() ?? e.scenes.getActiveScene().tracks,
	);
	const currentTime = useEditor((e) => e.playback.getCurrentTime());
	const mediaAssets = useEditor((e) => e.media.getAssets());
	const canvasSize = useEditor((e) => e.project.getActive().settings.canvasSize);

	const dragRef = useRef<DragState | null>(null);

	useEffect(() => {
		if (!cropElementId) return;
		return registerCanceller({ fn: () => exitCropMode() });
	}, [cropElementId, exitCropMode]);

	if (!cropElementId) return null;

	const withBounds = getVisibleElementsWithBounds({
		tracks,
		currentTime,
		canvasSize,
		mediaAssets,
	}).find((item) => item.elementId === cropElementId);
	if (!withBounds) return null;
	const { element, trackId, bounds } = withBounds;
	if (element.type !== "video" && element.type !== "image") return null;

	const crop = clampCropRect(element.crop ?? NO_CROP);
	const toOverlay = ({ x, y }: { x: number; y: number }) =>
		viewport.canvasToOverlay({ canvasX: x, canvasY: y });

	const halfW = bounds.width / 2;
	const halfH = bounds.height / 2;
	const localLeft = -halfW + crop.left * bounds.width;
	const localRight = halfW - crop.right * bounds.width;
	const localTop = -halfH + crop.top * bounds.height;
	const localBottom = halfH - crop.bottom * bounds.height;

	const toScreen = (localX: number, localY: number) => {
		const rotated = rotatePoint({ x: localX, y: localY, rotationDeg: bounds.rotation });
		return toOverlay({ x: bounds.cx + rotated.x, y: bounds.cy + rotated.y });
	};

	const edgeLocal: Record<Edge, { x: number; y: number }> = {
		left: { x: localLeft, y: (localTop + localBottom) / 2 },
		right: { x: localRight, y: (localTop + localBottom) / 2 },
		top: { x: (localLeft + localRight) / 2, y: localTop },
		bottom: { x: (localLeft + localRight) / 2, y: localBottom },
	};

	const outlineCenterScreen = toScreen(
		(localLeft + localRight) / 2,
		(localTop + localBottom) / 2,
	);
	const displayScale = viewport.getDisplayScale();
	const outlineWidth = Math.max(0, localRight - localLeft) * displayScale.x;
	const outlineHeight = Math.max(0, localBottom - localTop) * displayScale.y;

	const onEdgePointerDown = (edge: Edge) => (event: React.PointerEvent) => {
		event.stopPropagation();
		event.preventDefault();
		(event.currentTarget as Element).setPointerCapture?.(event.pointerId);
		const canvasPos = viewport.screenToCanvas({
			clientX: event.clientX,
			clientY: event.clientY,
		});
		if (!canvasPos) return;
		dragRef.current = {
			edge,
			trackId,
			elementId: element.id,
			startCrop: crop,
			startCanvas: canvasPos,
			boundsWidth: bounds.width,
			boundsHeight: bounds.height,
			rotation: bounds.rotation,
		};
	};

	const onPointerMove = (event: React.PointerEvent) => {
		const drag = dragRef.current;
		if (!drag) return;
		const canvasPos = viewport.screenToCanvas({
			clientX: event.clientX,
			clientY: event.clientY,
		});
		if (!canvasPos) return;
		const dx = canvasPos.x - drag.startCanvas.x;
		const dy = canvasPos.y - drag.startCanvas.y;
		// Inverse-rotate the screen-space delta into the element's local
		// (unrotated) space, so dragging "left" always shrinks/grows the left
		// crop edge regardless of how the clip is rotated on canvas.
		const local = rotatePoint({ x: dx, y: dy, rotationDeg: -drag.rotation });
		const next: CropRect = { ...drag.startCrop };
		if (drag.edge === "left") next.left = drag.startCrop.left + local.x / drag.boundsWidth;
		if (drag.edge === "right") next.right = drag.startCrop.right - local.x / drag.boundsWidth;
		if (drag.edge === "top") next.top = drag.startCrop.top + local.y / drag.boundsHeight;
		if (drag.edge === "bottom")
			next.bottom = drag.startCrop.bottom - local.y / drag.boundsHeight;
		editor.timeline.previewElementCrop({
			trackId: drag.trackId,
			elementId: drag.elementId,
			crop: clampCropRect(next),
		});
	};

	const onPointerUp = () => {
		if (!dragRef.current) return;
		dragRef.current = null;
		editor.timeline.commitPreview();
	};

	return (
		<div className="pointer-events-none absolute inset-0 overflow-visible" aria-hidden>
			<BoundingBoxOutline
				center={outlineCenterScreen}
				outlineWidth={outlineWidth}
				outlineHeight={outlineHeight}
				rotation={bounds.rotation}
				dashed
			/>
			{CROP_EDGES.map((edge) => {
				const local = edgeLocal[edge];
				const screen = toScreen(local.x, local.y);
				return (
					<EdgeHandle
						key={edge}
						edge={edge}
						screen={screen}
						rotation={bounds.rotation}
						onPointerDown={onEdgePointerDown(edge)}
						onPointerMove={onPointerMove}
						onPointerUp={onPointerUp}
					/>
				);
			})}
		</div>
	);
}
