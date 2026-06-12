"use client";

/**
 * Click-capture layer for the Text/Shape place tools. Sits exactly over the
 * scene rect; a click converts to project-pixel coordinates (0,0 = canvas
 * center) and creates the element there at the playhead.
 */

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useEditor } from "@/editor/use-editor";
import { DEFAULT_GRAPHIC_SOURCE_SIZE } from "@/graphics/types";
import { buildDefaultMaskInstance } from "@/masks";
import { freeformCanvasPointToLocal } from "@/masks/freeform/path";
import type { FreeformPathMaskParams } from "@/masks/types";
import { getVisibleElementsWithBounds } from "@/preview/element-bounds";
import type { MaskableElement } from "@/timeline";
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
	useEffect(() => {
		if (tool?.kind !== "pen") setPenPoints([]);
	}, [tool]);
	if (!tool) return null;

	/**
	 * Premiere behavior: drawing with a video/image/graphic clip selected cuts
	 * a freeform MASK into that clip (feather + invert live in the Masks tab).
	 * Returns false when there's no maskable selection — we fall back to
	 * creating a standalone custom shape instead.
	 */
	const finishPenAsMask = (): boolean => {
		const selected = editor.selection.getSelectedElements();
		if (selected.length !== 1) return false;
		const ref = selected[0];
		const withTrack = editor.timeline.getElementsWithTracks({
			elements: selected,
		})[0];
		if (!withTrack) return false;
		const target = withTrack.element;
		if (!["video", "image", "graphic"].includes(target.type)) return false;

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
		if (!bounds) return false;

		const mask = buildDefaultMaskInstance({
			maskType: "freeform",
			elementSize: { width: bounds.width, height: bounds.height },
		});
		if (mask.type !== "freeform") return false;
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
		toast.success("Mask drawn on the clip", {
			description:
				"Feather, Invert, and point editing live in the Masks tab. Drawing again replaces the mask.",
		});
		return true;
	};

	const finishPen = () => {
		if (penPoints.length < 3) {
			setTool(null);
			return;
		}
		if (finishPenAsMask()) {
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
						? "Click to add points; click the first point (or double-click) to close. With a clip selected this draws a MASK on it. Esc cancels."
						: "Click to place the shape (Esc to cancel)"
			}
			style={{
				left: sceneLeft,
				top: sceneTop,
				width: sceneWidth,
				height: sceneHeight,
			}}
			onClick={handleClick}
			onDoubleClick={tool.kind === "pen" ? finishPen : undefined}
		>
			{tool.kind === "pen" && penPoints.length > 0 && (
				<svg
					className="pointer-events-none absolute inset-0 size-full"
					viewBox="0 0 1 1"
					preserveAspectRatio="none"
				>
					<polygon
						points={penPoints.map(([x, y]) => `${x},${y}`).join(" ")}
						fill="rgba(56,189,248,0.25)"
						stroke="#38bdf8"
						strokeWidth={0.003}
					/>
					{penPoints.map(([x, y], index) => (
						// eslint-disable-next-line react/no-array-index-key -- points are append-only while drawing
						<circle key={index} cx={x} cy={y} r={0.006} fill="#38bdf8" />
					))}
				</svg>
			)}
		</div>
	);
}
