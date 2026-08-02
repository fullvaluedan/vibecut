"use client";

/**
 * T19.2 eyedropper overlay. Armed from a chroma-key effect's "Pick color"
 * button; sits exactly over the scene rect (same mount geometry as
 * PlaceToolOverlay), follows the cursor with an 11x11-pixel magnifier, and
 * writes the clicked colour into the effect's colour param. Escape cancels.
 *
 * It samples the clip's DECODED SOURCE frame, not the composited canvas - see
 * the long note at the top of effects/eyedropper/sample.ts for why that is the
 * only correct source for a key colour.
 */

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { EditorCore } from "@/core";
import { useEditor } from "@/editor/use-editor";
import {
	MAGNIFIER_PIXEL_SPAN,
	SAMPLE_RADIUS,
	previewPointToSourcePixel,
	rgbToHex,
	sampleAverageColor,
} from "@/effects/eyedropper/sample";
import { useEyedropperStore } from "@/effects/eyedropper/eyedropper-store";
import {
	type DecodedSourceFrame,
	getDecodedSourceFrame,
} from "@/effects/eyedropper/source-frame";
import { getElementLocalTime } from "@/animation";
import { buildTransformFromParams } from "@/rendering";
import { resolveTransformAtTime } from "@/rendering/animation-values";
import type { Effect } from "@/effects/types";
import type { MediaTime } from "@/wasm";
import type { CropRect, VisualElement } from "@/timeline";

/** On-screen size of the magnifier square, in CSS px. */
const MAGNIFIER_SIZE = 132;
/** How far the magnifier sits from the cursor so it never covers the target. */
const MAGNIFIER_OFFSET = 18;

interface ArmedTarget {
	element: VisualElement;
	mediaId: string | undefined;
	crop: CropRect | undefined;
	localTime: number;
}

export function EyedropperOverlay({
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
	const request = useEyedropperStore((s) => s.request);
	const cancel = useEyedropperStore((s) => s.cancel);
	const [frame, setFrame] = useState<DecodedSourceFrame | null>(null);
	const [hover, setHover] = useState<{
		left: number;
		top: number;
		hex: string;
	} | null>(null);
	const magnifierRef = useRef<HTMLCanvasElement>(null);

	useEffect(() => {
		if (!request) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") cancel();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [request, cancel]);

	// Decode the target clip's source frame once per arming. Held in state so
	// every mousemove reads pixels instead of re-decoding.
	useEffect(() => {
		if (!request) {
			setFrame(null);
			setHover(null);
			return;
		}

		let cancelled = false;
		const target = findTarget({ editor, request });
		if (!target) {
			toast.error("Nothing to pick from", {
				description: "The clip is no longer at the playhead.",
			});
			cancel();
			return;
		}

		const mediaAsset = editor.media
			.getAssets()
			.find((asset) => asset.id === target.mediaId);

		void getDecodedSourceFrame({
			element: target.element,
			mediaAsset,
			currentTime: editor.playback.getCurrentTime(),
		}).then((decoded) => {
			if (cancelled) return;
			if (!decoded) {
				toast.error("Couldn't read this clip's pixels", {
					description:
						"Pick color reads the clip's own decoded frame, so it works on video and image clips that this browser can decode.",
				});
				cancel();
				return;
			}
			setFrame(decoded);
		});

		return () => {
			cancelled = true;
		};
		// editor is a stable singleton; re-running on every render would
		// re-decode the frame continuously.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [request, cancel]);

	if (!request || !frame) return null;

	const resolveSourcePixel = ({
		event,
	}: {
		event: React.MouseEvent<HTMLDivElement>;
	}) => {
		const target = findTarget({ editor, request });
		if (!target) return null;
		const rect = event.currentTarget.getBoundingClientRect();
		const canvasSize = editor.project.getActive().settings.canvasSize;
		const transform = resolveTransformAtTime({
			baseTransform: buildTransformFromParams({ params: target.element.params }),
			animations: target.element.animations,
			localTime: target.localTime,
		});

		return previewPointToSourcePixel({
			point: {
				x: (event.clientX - rect.left) / rect.width,
				y: (event.clientY - rect.top) / rect.height,
			},
			canvasSize,
			sourceSize: { width: frame.width, height: frame.height },
			crop: target.crop,
			transform,
		});
	};

	const handleMove = (event: React.MouseEvent<HTMLDivElement>) => {
		const rect = event.currentTarget.getBoundingClientRect();
		const pixel = resolveSourcePixel({ event });
		if (!pixel) {
			setHover(null);
			return;
		}

		const average = sampleAverageColor({
			data: frame.data,
			width: frame.width,
			height: frame.height,
			x: pixel.x,
			y: pixel.y,
			radius: SAMPLE_RADIUS,
		});
		if (!average) {
			setHover(null);
			return;
		}

		setHover({
			left: event.clientX - rect.left,
			top: event.clientY - rect.top,
			hex: rgbToHex(average),
		});
		drawMagnifier({ canvas: magnifierRef.current, frame, pixel });
	};

	const handleClick = (event: React.MouseEvent<HTMLDivElement>) => {
		event.stopPropagation();
		const pixel = resolveSourcePixel({ event });
		if (!pixel) {
			toast.error("That point is outside the clip", {
				description: "Click inside the clip's own picture to pick a colour.",
			});
			return;
		}

		const average = sampleAverageColor({
			data: frame.data,
			width: frame.width,
			height: frame.height,
			x: pixel.x,
			y: pixel.y,
			radius: SAMPLE_RADIUS,
		});
		if (!average) return;

		const hex = rgbToHex(average);
		const applied = applyPickedColor({ editor, request, hex });
		cancel();
		if (applied) {
			toast.success(`Key color set to ${hex}`);
		}
	};

	return (
		// eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- transient click-to-sample surface; Escape exits.
		<div
			className="absolute z-40 cursor-crosshair"
			title="Click the colour to key out (Esc to cancel)"
			style={{
				left: sceneLeft,
				top: sceneTop,
				width: sceneWidth,
				height: sceneHeight,
			}}
			onMouseMove={handleMove}
			onMouseLeave={() => setHover(null)}
			onClick={handleClick}
		>
			<div
				className="pointer-events-none absolute flex flex-col items-center gap-1"
				style={{
					left: (hover?.left ?? 0) + MAGNIFIER_OFFSET,
					top: (hover?.top ?? 0) + MAGNIFIER_OFFSET,
					visibility: hover ? "visible" : "hidden",
				}}
			>
				<canvas
					ref={magnifierRef}
					width={MAGNIFIER_PIXEL_SPAN}
					height={MAGNIFIER_PIXEL_SPAN}
					className="rounded-full border-2 border-white shadow-lg"
					style={{
						width: MAGNIFIER_SIZE,
						height: MAGNIFIER_SIZE,
						imageRendering: "pixelated",
					}}
				/>
				<div className="flex items-center gap-1.5 rounded-sm bg-black/70 px-2 py-1 font-mono text-white text-xs">
					<span
						className="size-3 rounded-xs border border-white/50"
						style={{ backgroundColor: hover?.hex ?? "transparent" }}
					/>
					{hover?.hex ?? ""}
				</div>
			</div>
		</div>
	);
}

function drawMagnifier({
	canvas,
	frame,
	pixel,
}: {
	canvas: HTMLCanvasElement | null;
	frame: DecodedSourceFrame;
	pixel: { x: number; y: number };
}) {
	if (!canvas) return;
	const context = canvas.getContext("2d");
	if (!context) return;

	const half = Math.floor(MAGNIFIER_PIXEL_SPAN / 2);
	context.imageSmoothingEnabled = false;
	context.clearRect(0, 0, MAGNIFIER_PIXEL_SPAN, MAGNIFIER_PIXEL_SPAN);
	context.drawImage(
		frame.source,
		pixel.x - half,
		pixel.y - half,
		MAGNIFIER_PIXEL_SPAN,
		MAGNIFIER_PIXEL_SPAN,
		0,
		0,
		MAGNIFIER_PIXEL_SPAN,
		MAGNIFIER_PIXEL_SPAN,
	);
}

function findTarget({
	editor,
	request,
}: {
	editor: EditorCore;
	request: { trackId: string; elementId: string };
}): ArmedTarget | null {
	const tracks = editor.scenes.getActiveScene().tracks;
	const track = [tracks.main, ...tracks.overlay].find(
		(candidate) => candidate.id === request.trackId,
	);
	const element = track?.elements.find(
		(candidate) => candidate.id === request.elementId,
	);
	// A standalone effect layer has no picture of its own to sample.
	if (!element || element.type === "effect") {
		return null;
	}

	return {
		element: element as VisualElement,
		mediaId:
			element.type === "video" || element.type === "image"
				? element.mediaId
				: undefined,
		crop:
			element.type === "video" || element.type === "image"
				? element.crop
				: undefined,
		localTime: getElementLocalTime({
			timelineTime: editor.playback.getCurrentTime() as MediaTime,
			elementStartTime: element.startTime,
			elementDuration: element.duration,
		}),
	};
}

/**
 * Writes the picked colour through the SAME element-update command the param
 * fields use, so it is one undo step and no state lives anywhere else.
 */
function applyPickedColor({
	editor,
	request,
	hex,
}: {
	editor: EditorCore;
	request: {
		trackId: string;
		elementId: string;
		effectId: string;
		paramKey: string;
	};
	hex: string;
}): boolean {
	const target = findTarget({ editor, request });
	const effects: Effect[] = target?.element.effects ?? [];
	if (!effects.some((effect) => effect.id === request.effectId)) {
		return false;
	}

	editor.timeline.updateElements({
		updates: [
			{
				trackId: request.trackId,
				elementId: request.elementId,
				patch: {
					effects: effects.map((effect) =>
						effect.id !== request.effectId
							? effect
							: {
									...effect,
									params: { ...effect.params, [request.paramKey]: hex },
								},
					),
				} as Partial<VisualElement>,
			},
		],
	});
	return true;
}
