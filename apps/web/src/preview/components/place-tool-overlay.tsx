"use client";

/**
 * Click-capture layer for the Text/Shape place tools. Sits exactly over the
 * scene rect; a click converts to project-pixel coordinates (0,0 = canvas
 * center) and creates the element there at the playhead.
 */

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useEditor } from "@/editor/use-editor";
import { DEFAULT_GRAPHIC_SOURCE_SIZE } from "@/graphics/types";
import { buildDefaultMaskInstance } from "@/masks";
import { freeformCanvasPointToLocal } from "@/masks/freeform/path";
import type { FreeformPathMaskParams } from "@/masks/types";
import { getVisibleElementsWithBounds } from "@/preview/element-bounds";
import type { ElementRef, MaskableElement } from "@/timeline";
import { generateUUID } from "@/utils/id";
import { usePlaceToolStore } from "@/preview/place-tool-store";
import {
	buildGraphicElement,
	buildTextElement,
} from "@/timeline/element-utils";

export function PlaceToolOverlay({
	sceneLeft,
	sceneTop,
	sceneWidth,
	sceneHeight,
}: {
	sceneLeft: number;
	sceneTop: number;
	sceneWidth: number;
	sceneHeight: number;
}) {
	const editor = useEditor();
	const tool = usePlaceToolStore((s) => s.tool);
	const setTool = usePlaceToolStore((s) => s.setTool);
	// Pen tool: clicked points in scene-normalized (0..1) coordinates.
	const [penPoints, setPenPoints] = useState<[number, number][]>([]);
	// The maskable target is LATCHED when the Pen arms, so a mid-draw canvas click
	// that clears the selection can't flip "mask the selected clip" into "create a
	// new shape". finishPenAsMask consults this latch, falling back to the live
	// selection only when nothing was latched (e.g. the clip was selected after arming).
	const maskTargetRef = useRef<ElementRef[]>([]);
	useEffect(() => {
		if (tool?.kind !== "pen") {
			setPenPoints([]);
			maskTargetRef.current = [];
			return;
		}
		maskTargetRef.current = editor.selection.getSelectedElements();
	}, [tool, editor]);
	// Track Select Forward, Razor, Rate-Stretch, Ripple and Roll act on the
	// timeline, not the preview canvas, so this overlay never mounts for them.
	if (
		!tool ||
		tool.kind === "track-select-forward" ||
		tool.kind === "razor" ||
		tool.kind === "rate-stretch" ||
		tool.kind === "ripple" ||
		tool.kind === "roll"
	)
		return null;

	const isMaskableType = (type: string): boolean =>
		type === "video" || type === "image" || type === "graphic";

	// U9: the topmost visible maskable clip under the drawn path's centroid, so you
	// can draw over a clip and mask it without selecting it first. Returns null when
	// no maskable clip sits under the path (the caller then makes a Custom shape).
	const resolveUnderPathMaskTarget = (): ElementRef | null => {
		if (penPoints.length === 0) return null;
		const canvasSize = editor.project.getActive().settings.canvasSize;
		const px =
			(penPoints.reduce((sum, [x]) => sum + x, 0) / penPoints.length) *
			canvasSize.width;
		const py =
			(penPoints.reduce((sum, [, y]) => sum + y, 0) / penPoints.length) *
			canvasSize.height;
		let hit: ElementRef | null = null;
		for (const item of getVisibleElementsWithBounds({
			tracks: editor.scenes.getActiveScene().tracks,
			currentTime: editor.playback.getCurrentTime(),
			canvasSize,
			mediaAssets: editor.media.getAssets(),
		})) {
			if (!isMaskableType(item.element.type)) continue;
			const { cx, cy, width, height, rotation } = item.bounds;
			const rad = (-rotation * Math.PI) / 180;
			const dx = px - cx;
			const dy = py - cy;
			const localX = dx * Math.cos(rad) - dy * Math.sin(rad);
			const localY = dx * Math.sin(rad) + dy * Math.cos(rad);
			// Keep the LAST hit: getVisibleElementsWithBounds is bottom-to-top, so the
			// last clip containing the point is the topmost.
			if (Math.abs(localX) <= width / 2 && Math.abs(localY) <= height / 2) {
				hit = { trackId: item.trackId, elementId: item.elementId };
			}
		}
		return hit;
	};

	// The mask target: the single selected/latched maskable clip, else (U9) the
	// maskable clip under the drawn path.
	const resolveMaskTargetRef = (): ElementRef | null => {
		const latched =
			maskTargetRef.current.length > 0
				? maskTargetRef.current
				: editor.selection.getSelectedElements();
		if (latched.length === 1) {
			const withTrack = editor.timeline.getElementsWithTracks({
				elements: latched,
			})[0];
			if (withTrack && isMaskableType(withTrack.element.type)) {
				return latched[0];
			}
		}
		return resolveUnderPathMaskTarget();
	};

	/**
	 * Premiere behavior: drawing with a video/image/graphic clip selected cuts
	 * a freeform MASK into that clip (feather + invert live in the Masks tab).
	 * "no-target" = nothing maskable selected (fall back to a custom shape);
	 * "failed" = a maskable clip IS selected but the mask couldn't be placed
	 * (never silently turn that into a shape layer — tell the user why).
	 */
	const finishPenAsMask = (): "masked" | "no-target" | "failed" => {
		// Target the single selected/latched maskable clip (U7 latch), or — when
		// nothing maskable is selected — the maskable clip under the drawn path (U9).
		const ref = resolveMaskTargetRef();
		if (!ref) return "no-target";
		const withTrack = editor.timeline.getElementsWithTracks({
			elements: [ref],
		})[0];
		if (!withTrack) return "no-target";
		const target = withTrack.element;

		const canvasSize = editor.project.getActive().settings.canvasSize;
		const clampedTime = Math.min(
			Math.max(editor.playback.getCurrentTime(), target.startTime),
			target.startTime + target.duration - 1,
		);
		const bounds = getVisibleElementsWithBounds({
			tracks: editor.scenes.getActiveScene().tracks,
			currentTime: clampedTime,
			canvasSize,
			mediaAssets: editor.media.getAssets(),
		}).find(
			(item) => item.trackId === ref.trackId && item.elementId === target.id,
		)?.bounds;
		if (!bounds) return "failed";

		const mask = buildDefaultMaskInstance({
			maskType: "freeform",
			elementSize: { width: bounds.width, height: bounds.height },
		});
		if (mask.type !== "freeform") return "failed";
		const params = mask.params as FreeformPathMaskParams;
		params.path = penPoints.map(([nx, ny]) => {
			const local = freeformCanvasPointToLocal({
				point: { x: nx * canvasSize.width, y: ny * canvasSize.height },
				centerX: params.centerX,
				centerY: params.centerY,
				rotation: params.rotation,
				scale: params.scale,
				bounds,
			});
			return {
				id: generateUUID(),
				x: local.x,
				y: local.y,
				inX: 0,
				inY: 0,
				outX: 0,
				outY: 0,
			};
		});
		params.closed = true;

		editor.timeline.updateElements({
			updates: [
				{
					trackId: ref.trackId,
					elementId: target.id,
					patch: { masks: [mask] } as Partial<MaskableElement>,
				},
			],
		});
		toast.success("Mask cut into the clip", {
			description:
				"Feather, Invert, and point editing live in the Masks tab. Drawing again replaces the mask.",
		});
		return "masked";
	};

	const finishPen = () => {
		if (penPoints.length < 3) {
			setTool(null);
			return;
		}
		const maskOutcome = finishPenAsMask();
		if (maskOutcome === "masked") {
			setTool(null);
			return;
		}
		if (maskOutcome === "failed") {
			toast.error("Couldn't cut the mask into the selected clip", {
				description:
					"The clip isn't visible at the playhead. Park the playhead over it (and make sure its track is visible), then draw again.",
			});
			setTool(null);
			return;
		}
		const { width, height } = editor.project.getActive().settings.canvasSize;
		const xs = penPoints.map(([x]) => x);
		const ys = penPoints.map(([, y]) => y);
		const minX = Math.min(...xs);
		const maxX = Math.max(...xs);
		const minY = Math.min(...ys);
		const maxY = Math.max(...ys);
		const bboxWidth = Math.max(0.01, maxX - minX);
		const bboxHeight = Math.max(0.01, maxY - minY);
		// Points re-normalized into the shape's own bounding box; the element's
		// transform places + sizes the 512px graphic source over that box.
		const boxPoints = penPoints.map(([x, y]) => [
			(x - minX) / bboxWidth,
			(y - minY) / bboxHeight,
		]);
		const element = buildGraphicElement({
			definitionId: "custom-path",
			name: "Custom shape",
			startTime: editor.playback.getCurrentTime(),
			params: {
				points: JSON.stringify(
					boxPoints.map(([x, y]) => [
						Math.round(x * 1000) / 1000,
						Math.round(y * 1000) / 1000,
					]),
				),
				"transform.positionX": Math.round(
					((minX + maxX) / 2 - 0.5) * width,
				),
				"transform.positionY": Math.round(
					((minY + maxY) / 2 - 0.5) * height,
				),
				"transform.scaleX": (bboxWidth * width) / DEFAULT_GRAPHIC_SOURCE_SIZE,
				"transform.scaleY":
					(bboxHeight * height) / DEFAULT_GRAPHIC_SOURCE_SIZE,
			},
		});
		editor.timeline.insertElement({ element, placement: { mode: "auto" } });
		setTool(null);
		toast.success("Custom shape added", {
			description: "Adjust fill, feather, and expand in the properties panel.",
		});
	};

	const handleClick = (event: React.MouseEvent<HTMLDivElement>) => {
		event.stopPropagation();
		const rect = event.currentTarget.getBoundingClientRect();
		const nx = (event.clientX - rect.left) / rect.width;
		const ny = (event.clientY - rect.top) / rect.height;

		if (tool.kind === "pen") {
			// Premiere closes the path when you click the FIRST vertex again.
			if (penPoints.length >= 3) {
				const [fx, fy] = penPoints[0];
				const pxDistance = Math.hypot(
					(nx - fx) * rect.width,
					(ny - fy) * rect.height,
				);
				if (pxDistance <= 12) {
					finishPen();
					return;
				}
			}
			setPenPoints((prev) => [...prev, [nx, ny]]);
			return;
		}

		const { width, height } = editor.project.getActive().settings.canvasSize;
		const positionX = Math.round((nx - 0.5) * width);
		const positionY = Math.round((ny - 0.5) * height);
		const startTime = editor.playback.getCurrentTime();
		const positionParams = {
			"transform.positionX": positionX,
			"transform.positionY": positionY,
		};

		const element =
			tool.kind === "text"
				? buildTextElement({
						raw: { params: positionParams },
						startTime,
					})
				: buildGraphicElement({
						definitionId: tool.definitionId,
						startTime,
						params: positionParams,
					});
		editor.timeline.insertElement({ element, placement: { mode: "auto" } });
		setTool(null);
		toast.success(
			tool.kind === "text" ? "Text added — start typing in the panel" : "Shape added",
		);
	};

	return (
		// eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- transient click-to-place surface; Escape/toggle exits the tool.
		<div
			className="absolute z-30 cursor-crosshair"
			title={
				tool.kind === "text"
					? "Click to place text (Esc to cancel)"
					: tool.kind === "pen"
						? "Click to add points; close by clicking the FIRST point (like Premiere). With a clip selected this cuts a MASK into it. Esc cancels."
						: "Click to place the shape (Esc to cancel)"
			}
			style={{
				left: sceneLeft,
				top: sceneTop,
				width: sceneWidth,
				height: sceneHeight,
			}}
			onPointerDown={(event) => event.stopPropagation()}
			onPointerUp={(event) => event.stopPropagation()}
			onClick={handleClick}
		>
			{tool.kind === "pen" && penPoints.length > 0 && (
				<svg
					className="pointer-events-none absolute inset-0 size-full"
					viewBox="0 0 1 1"
					preserveAspectRatio="none"
				>
					{/* Open polyline while drawing — Premiere only closes the path
					    when you click the first vertex, so don't pre-close it. */}
					<polyline
						points={penPoints.map(([x, y]) => `${x},${y}`).join(" ")}
						fill="rgba(56,189,248,0.15)"
						stroke="#38bdf8"
						strokeWidth={0.003}
					/>
					{penPoints.map(([x, y], index) => (
						// eslint-disable-next-line react/no-array-index-key -- points are append-only while drawing
						<circle
							key={index}
							cx={x}
							cy={y}
							r={index === 0 && penPoints.length >= 3 ? 0.012 : 0.006}
							fill={index === 0 && penPoints.length >= 3 ? "#ffffff" : "#38bdf8"}
							stroke="#38bdf8"
							strokeWidth={index === 0 ? 0.003 : 0}
						/>
					))}
				</svg>
			)}
		</div>
	);
}
