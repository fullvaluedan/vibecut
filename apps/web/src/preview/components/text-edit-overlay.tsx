"use client";

import { useCallback, useEffect, useRef } from "react";
import { usePreviewViewport } from "@/preview/components/preview-viewport";
import { useEditor } from "@/editor/use-editor";
import type { TextElement } from "@/timeline";
import { DEFAULTS } from "@/timeline/defaults";
import {
	getElementLocalTime,
} from "@/animation";
import { resolveTransformAtTime } from "@/rendering/animation-values";
import { buildTransformFromParams } from "@/rendering";
import { resolveTextLayout } from "@/text/primitives";
import {
	buildTextBackgroundFromElement,
	buildTextLayoutParamsFromElement,
} from "@/text/measure-element";

export function TextEditOverlay({
	trackId,
	elementId,
	element,
	onCommit,
}: {
	trackId: string;
	elementId: string;
	element: TextElement;
	onCommit: () => void;
}) {
	const editor = useEditor();
	const viewport = usePreviewViewport();
	const divRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const div = divRef.current;
		if (!div) return;
		div.focus();
		const range = document.createRange();
		range.selectNodeContents(div);
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
	}, []);

	const handleInput = useCallback(() => {
		const div = divRef.current;
		if (!div) return;
		const text = div.innerText;
		editor.timeline.previewElements({
			updates: [{ trackId, elementId, updates: { params: { content: text } } }],
		});
	}, [editor.timeline, trackId, elementId]);

	const handleKeyDown = useCallback(
		({ event }: { event: React.KeyboardEvent }) => {
			const { key } = event;
			if (key === "Escape") {
				event.preventDefault();
				onCommit();
				return;
			}
		},
		[onCommit],
	);

	const canvasSize = editor.project.getActive().settings.canvasSize;

	if (!canvasSize) return null;

	const currentTime = editor.playback.getCurrentTime();
	const localTime = getElementLocalTime({
		timelineTime: currentTime,
		elementStartTime: element.startTime,
		elementDuration: element.duration,
	});
	const transform = resolveTransformAtTime({
		baseTransform: buildTransformFromParams({ params: element.params }),
		animations: element.animations,
		localTime,
	});

	const { x: posX, y: posY } = viewport.positionToOverlay({
		positionX: transform.position.x,
		positionY: transform.position.y,
	});

	const { x: displayScaleX } = viewport.getDisplayScale();
	const textParams = buildTextLayoutParamsFromElement({ element });
	const resolvedTextLayout = resolveTextLayout({
		text: textParams,
		canvasHeight: canvasSize.height,
	});

	const lineHeight = textParams.lineHeight ?? DEFAULTS.text.lineHeight;
	const canvasLetterSpacing = textParams.letterSpacing ?? 0;
	const lineHeightPx = resolvedTextLayout.lineHeightPx;

	const bg = buildTextBackgroundFromElement({ element });
	const shouldShowBackground =
		bg.enabled && bg.color && bg.color !== "transparent";
	const fontSizeRatio = resolvedTextLayout.fontSizeRatio;
	const canvasPaddingX = shouldShowBackground
		? (bg.paddingX ?? DEFAULTS.text.background.paddingX) * fontSizeRatio
		: 0;
	const canvasPaddingY = shouldShowBackground
		? (bg.paddingY ?? DEFAULTS.text.background.paddingY) * fontSizeRatio
		: 0;

	// Counter-scale for the edit-mode hint so it stays a legible, fixed on-screen
	// size regardless of the text element's own scale / the viewport zoom.
	const editBoxScaleX = transform.scaleX * displayScaleX;
	const hintCounterScale =
		Number.isFinite(editBoxScaleX) && editBoxScaleX !== 0
			? 1 / editBoxScaleX
			: 1;

	return (
		<div
			className="absolute"
			style={{
				left: posX,
				top: posY,
				transform: `translate(-50%, -50%) scale(${editBoxScaleX}, ${transform.scaleY * displayScaleX}) rotate(${transform.rotate}deg)`,
				transformOrigin: "center center",
			}}
		>
			{/*
			  Edit-mode affordance: a dashed ring around the caret box plus a small
			  hint telling the user how to leave edit mode to reach the resize
			  handles. Handles are intentionally hidden during caret edit (the
			  modal pattern), so this signals the exit instead of forcing them back.
			*/}
			<div
				className="pointer-events-none absolute -inset-1 rounded-sm"
				style={{
					outline: "1px dashed var(--primary)",
					outlineOffset: "1px",
				}}
			/>
			<div
				className="pointer-events-none absolute left-1/2 top-full whitespace-nowrap rounded bg-black/75 px-1.5 py-0.5 text-[11px] font-medium leading-tight text-white shadow-sm"
				style={{
					transform: `translate(-50%, 6px) scale(${hintCounterScale})`,
					transformOrigin: "top center",
				}}
			>
				Esc or click away to resize
			</div>
			<div
				ref={divRef}
				contentEditable
				suppressContentEditableWarning
				tabIndex={0}
				role="textbox"
				aria-label="Edit text"
				className="cursor-text select-text outline-none whitespace-pre"
				style={{
					fontSize: resolvedTextLayout.scaledFontSize,
					fontFamily: textParams.fontFamily,
					fontWeight: textParams.fontWeight === "bold" ? "bold" : "normal",
					fontStyle: textParams.fontStyle === "italic" ? "italic" : "normal",
					textAlign: textParams.textAlign,
					letterSpacing: `${canvasLetterSpacing}px`,
					lineHeight,
					color: "transparent",
					caretColor:
						typeof element.params.color === "string"
							? element.params.color
							: "#ffffff",
					backgroundColor: shouldShowBackground ? bg.color : "transparent",
					minHeight: lineHeightPx,
					textDecoration: textParams.textDecoration ?? "none",
					padding: shouldShowBackground
						? `${canvasPaddingY}px ${canvasPaddingX}px`
						: 0,
					minWidth: 1,
				}}
				onInput={handleInput}
				onBlur={onCommit}
				onKeyDown={(event) => handleKeyDown({ event })}
			>
				{textParams.content}
			</div>
		</div>
	);
}
