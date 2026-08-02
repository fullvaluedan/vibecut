"use client";

import { useCallback, useRef, useState } from "react";
import { useEditor } from "@/editor/use-editor";
import { useTimelineStore } from "@/timeline/timeline-store";
import {
	getElementFadeInSec,
	getElementFadeOutSec,
	type AudioCapableElement,
} from "@/timeline/audio-state";
import { computeFadeGain, resolveFadePair } from "@/timeline/audio-fade";
import { clamp, snapToStep } from "@/utils/math";
import { cn } from "@/utils/ui";
import { TICKS_PER_SECOND } from "@/wasm";

const HANDLE_SIZE_PX = 8;
const CURVE_SAMPLE_COUNT = 10;
/** Fine-grained step when snapping is off; whole seconds when it's on. */
const FADE_STEP_SECONDS = 0.1;

type FadeSide = "in" | "out";

/**
 * CapCut-style corner fade handles + curve overlay, drawn over an audio
 * clip's waveform area. Works for both stand-alone audio clips and a video
 * clip's own embedded audio (T18.3) - the caller passes whichever element
 * actually carries the fade params.
 */
export function AudioFadeHandles({
	element,
	trackId,
	pixelsPerSecond,
}: {
	element: AudioCapableElement;
	trackId: string;
	pixelsPerSecond: number;
}) {
	const editor = useEditor();
	const snappingEnabled = useTimelineStore((s) => s.snappingEnabled);
	const activeSideRef = useRef<FadeSide | null>(null);
	const activePointerIdRef = useRef<number | null>(null);
	const dragStartClientXRef = useRef(0);
	const dragStartFadeInRef = useRef(0);
	const dragStartFadeOutRef = useRef(0);
	const hasChangedRef = useRef(false);
	const [activeDragSide, setActiveDragSide] = useState<FadeSide | null>(null);

	const durationSec = element.duration / TICKS_PER_SECOND;
	const fadeInSec = getElementFadeInSec({ element });
	const fadeOutSec = getElementFadeOutSec({ element });

	const finishDrag = useCallback(
		({ shouldCommit }: { shouldCommit: boolean }) => {
			activePointerIdRef.current = null;
			activeSideRef.current = null;
			setActiveDragSide(null);
			if (shouldCommit && hasChangedRef.current) {
				editor.timeline.commitPreview();
			} else {
				editor.timeline.discardPreview();
			}
			hasChangedRef.current = false;
		},
		[editor],
	);

	const applyDrag = useCallback(
		({ side, clientX }: { side: FadeSide; clientX: number }) => {
			if (!(durationSec > 0) || !(pixelsPerSecond > 0)) {
				return;
			}

			const deltaSec = (clientX - dragStartClientXRef.current) / pixelsPerSecond;
			const step = snappingEnabled ? 1 : FADE_STEP_SECONDS;

			const nextPair =
				side === "in"
					? resolveFadePair({
							fadeInSec: snapToStep({
								value: dragStartFadeInRef.current + deltaSec,
								step,
							}),
							fadeOutSec: dragStartFadeOutRef.current,
							durationSec,
							priority: "fadeIn",
						})
					: resolveFadePair({
							fadeInSec: dragStartFadeInRef.current,
							fadeOutSec: snapToStep({
								value: dragStartFadeOutRef.current - deltaSec,
								step,
							}),
							durationSec,
							priority: "fadeOut",
						});

			if (nextPair.fadeInSec !== fadeInSec || nextPair.fadeOutSec !== fadeOutSec) {
				hasChangedRef.current = true;
			}

			editor.timeline.previewElements({
				updates: [
					{
						trackId,
						elementId: element.id,
						updates: {
							params: {
								...element.params,
								fadeInSec: nextPair.fadeInSec,
								fadeOutSec: nextPair.fadeOutSec,
							},
						},
					},
				],
			});
		},
		[
			durationSec,
			pixelsPerSecond,
			snappingEnabled,
			fadeInSec,
			fadeOutSec,
			editor,
			trackId,
			element,
		],
	);

	const handlePointerDown = useCallback(
		(side: FadeSide) => (event: React.PointerEvent<HTMLDivElement>) => {
			if (event.button !== 0) {
				return;
			}

			event.preventDefault();
			event.stopPropagation();
			editor.selection.setSelectedElements({
				elements: [{ trackId, elementId: element.id }],
			});
			activeSideRef.current = side;
			activePointerIdRef.current = event.pointerId;
			dragStartClientXRef.current = event.clientX;
			dragStartFadeInRef.current = fadeInSec;
			dragStartFadeOutRef.current = fadeOutSec;
			hasChangedRef.current = false;
			setActiveDragSide(side);
			event.currentTarget.setPointerCapture(event.pointerId);
		},
		[editor.selection, trackId, element.id, fadeInSec, fadeOutSec],
	);

	const handlePointerMove = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			const side = activeSideRef.current;
			if (side === null || activePointerIdRef.current !== event.pointerId) {
				return;
			}

			event.preventDefault();
			applyDrag({ side, clientX: event.clientX });
		},
		[applyDrag],
	);

	const handlePointerUp = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			if (activePointerIdRef.current !== event.pointerId) {
				return;
			}

			event.preventDefault();
			event.stopPropagation();
			finishDrag({ shouldCommit: true });
		},
		[finishDrag],
	);

	const handlePointerCancel = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			if (activePointerIdRef.current !== event.pointerId) {
				return;
			}

			event.preventDefault();
			event.stopPropagation();
			finishDrag({ shouldCommit: false });
		},
		[finishDrag],
	);

	const handleLostPointerCapture = useCallback(() => {
		if (activePointerIdRef.current === null) {
			return;
		}

		finishDrag({ shouldCommit: hasChangedRef.current });
	}, [finishDrag]);

	const handleClick = useCallback((event: React.MouseEvent) => {
		event.preventDefault();
		event.stopPropagation();
	}, []);

	const handleMouseDown = useCallback((event: React.MouseEvent) => {
		event.stopPropagation();
	}, []);

	return (
		<div className="pointer-events-none absolute inset-0">
			<FadeCurveOverlay
				durationSec={durationSec}
				fadeInSec={fadeInSec}
				fadeOutSec={fadeOutSec}
			/>
			{(["in", "out"] as const).map((side) => (
				<div
					// eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- corner drag grip, same pattern as AudioVolumeLine's hit area.
					key={side}
					className={cn(
						"pointer-events-auto absolute top-0.5 touch-none cursor-ew-resize rounded-sm transition-colors",
						side === "in" ? "left-0.5" : "right-0.5",
						activeDragSide === side
							? "bg-white"
							: "bg-white/60 hover:bg-white/85",
					)}
					style={{ width: HANDLE_SIZE_PX, height: HANDLE_SIZE_PX }}
					title={side === "in" ? "Drag to set fade in" : "Drag to set fade out"}
					onClick={handleClick}
					onMouseDown={handleMouseDown}
					onPointerDown={handlePointerDown(side)}
					onPointerMove={handlePointerMove}
					onPointerUp={handlePointerUp}
					onPointerCancel={handlePointerCancel}
					onLostPointerCapture={handleLostPointerCapture}
				/>
			))}
		</div>
	);
}

/**
 * Live envelope line over the waveform: samples `computeFadeGain` (the same
 * function the render/playback gain path uses) so the drawn curve always
 * matches what's actually audible - no separate approximation to drift out
 * of sync.
 */
function FadeCurveOverlay({
	durationSec,
	fadeInSec,
	fadeOutSec,
}: {
	durationSec: number;
	fadeInSec: number;
	fadeOutSec: number;
}) {
	if (!(durationSec > 0) || (fadeInSec <= 0 && fadeOutSec <= 0)) {
		return null;
	}

	const gainAt = (tSec: number) =>
		computeFadeGain({ localTimeSec: tSec, durationSec, fadeInSec, fadeOutSec });

	const points: Array<{ tSec: number; gain: number }> = [
		{ tSec: 0, gain: gainAt(0) },
	];

	if (fadeInSec > 0) {
		for (let i = 1; i <= CURVE_SAMPLE_COUNT; i++) {
			const tSec = (i / CURVE_SAMPLE_COUNT) * fadeInSec;
			points.push({ tSec, gain: gainAt(tSec) });
		}
	}

	if (fadeOutSec > 0) {
		const fadeOutStartSec = durationSec - fadeOutSec;
		for (let i = 0; i <= CURVE_SAMPLE_COUNT; i++) {
			const tSec = fadeOutStartSec + (i / CURVE_SAMPLE_COUNT) * fadeOutSec;
			points.push({ tSec, gain: gainAt(tSec) });
		}
	} else {
		points.push({ tSec: durationSec, gain: gainAt(durationSec) });
	}

	const pathD = points
		.map(({ tSec, gain }, index) => {
			const xPct = clamp({ value: (tSec / durationSec) * 100, min: 0, max: 100 });
			const yPct = clamp({ value: (1 - gain) * 100, min: 0, max: 100 });
			return `${index === 0 ? "M" : "L"}${xPct.toFixed(2)},${yPct.toFixed(2)}`;
		})
		.join(" ");

	return (
		<svg
			className="pointer-events-none absolute inset-0 size-full"
			viewBox="0 0 100 100"
			preserveAspectRatio="none"
		>
			<path
				d={pathD}
				fill="none"
				stroke="rgba(255,255,255,0.85)"
				strokeWidth={1.5}
				vectorEffect="non-scaling-stroke"
			/>
		</svg>
	);
}
