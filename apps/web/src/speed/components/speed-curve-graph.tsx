"use client";

import { useRef, useState, type PointerEvent } from "react";
import { useCommittedRef } from "@/hooks/use-committed-ref";
import { MAX_RETIME_RATE, MIN_RETIME_RATE } from "@/retime/rate";
import type { RetimeCurvePoint } from "@/retime/curve";
import { cn } from "@/utils/ui";

/**
 * T18.2: the piecewise-linear sibling of timeline/components/graph-editor's
 * `BezierGraph`. That component can't be reused unchanged here - it's built
 * for exactly TWO draggable control handles of a normalized cubic bezier
 * ([0,1]x[0,1] with fixed endpoints), while a speed curve is N draggable
 * points with a rate axis that goes well past 1 (up to `MAX_RETIME_RATE`).
 * This file mirrors its visual language and interaction pattern instead -
 * same SVG sizing/padding proportions, the same `useCommittedRef` +
 * pointer-capture drag pattern, the same `onChange` (live preview) /
 * `onChangeEnd` (commit) / `onCancel` callback shape - so the Curve section
 * reads as a natural sibling of the bezier editor rather than a bespoke
 * one-off.
 *
 * v1 ships FIXED point counts per preset (no add/remove point on
 * double-click/right-click, per the T18.2 plan's own fallback allowance):
 * dragging a point vertically changes its rate, dragging horizontally shifts
 * its `t` within its immediate neighbors. The first and last points are
 * pinned to t=0/t=1 (curve validation requires it) and only move vertically.
 */

const GRAPH_WIDTH = 220;
const GRAPH_HEIGHT = 94;
const GRAPH_PADDING = 12;
const SVG_WIDTH = GRAPH_WIDTH + GRAPH_PADDING * 2;
const SVG_HEIGHT = GRAPH_HEIGHT + GRAPH_PADDING * 2;
const HANDLE_RADIUS = 4;
const RATE_AXIS_MAX = MAX_RETIME_RATE;
const T_NEIGHBOR_MARGIN = 0.02;

export const SPEED_CURVE_GRAPH_MIN_HEIGHT = SVG_HEIGHT;

function toSvgX({ t }: { t: number }): number {
	return GRAPH_PADDING + t * GRAPH_WIDTH;
}

function toSvgY({ rate }: { rate: number }): number {
	const clamped = Math.min(RATE_AXIS_MAX, Math.max(0, rate));
	return GRAPH_PADDING + (1 - clamped / RATE_AXIS_MAX) * GRAPH_HEIGHT;
}

function fromSvgX({ svgX }: { svgX: number }): number {
	return Math.max(0, Math.min(1, (svgX - GRAPH_PADDING) / GRAPH_WIDTH));
}

function fromSvgY({ svgY }: { svgY: number }): number {
	const fraction = 1 - (svgY - GRAPH_PADDING) / GRAPH_HEIGHT;
	return Math.min(
		MAX_RETIME_RATE,
		Math.max(MIN_RETIME_RATE, fraction * RATE_AXIS_MAX),
	);
}

function curvePath({ points }: { points: RetimeCurvePoint[] }): string {
	return points
		.map((point, index) => {
			const command = index === 0 ? "M" : "L";
			return `${command}${toSvgX({ t: point.t })},${toSvgY({ rate: point.rate })}`;
		})
		.join("");
}

export function SpeedCurveGraph({
	points,
	onChange,
	onChangeEnd,
	onCancel,
}: {
	points: RetimeCurvePoint[];
	onChange?: (points: RetimeCurvePoint[]) => void;
	onChangeEnd?: (points: RetimeCurvePoint[]) => void;
	onCancel?: () => void;
}) {
	const svgRef = useRef<SVGSVGElement>(null);
	const [activeIndex, setActiveIndex] = useState<number | null>(null);
	const latestPointsRef = useCommittedRef(points);

	function getPointerPosition({
		event,
	}: {
		event: PointerEvent;
	}): { x: number; y: number } {
		const svg = svgRef.current;
		if (!svg) return { x: 0, y: 0 };
		const rect = svg.getBoundingClientRect();
		return {
			x: (event.clientX - rect.left) * (SVG_WIDTH / rect.width),
			y: (event.clientY - rect.top) * (SVG_HEIGHT / rect.height),
		};
	}

	function onHandlePointerDown({ index }: { index: number }) {
		return (event: PointerEvent<SVGCircleElement>) => {
			event.preventDefault();
			event.stopPropagation();
			setActiveIndex(index);
			event.currentTarget.setPointerCapture(event.pointerId);
		};
	}

	function onPointerMove({ event }: { event: PointerEvent<SVGSVGElement> }) {
		if (activeIndex === null) return;
		const current = latestPointsRef.current;
		const pointerPos = getPointerPosition({ event });
		const rate = fromSvgY({ svgY: pointerPos.y });
		const isEndpoint = activeIndex === 0 || activeIndex === current.length - 1;
		const prevT = current[activeIndex - 1]?.t ?? 0;
		const nextT = current[activeIndex + 1]?.t ?? 1;
		const t = isEndpoint
			? current[activeIndex].t
			: Math.min(
					nextT - T_NEIGHBOR_MARGIN,
					Math.max(prevT + T_NEIGHBOR_MARGIN, fromSvgX({ svgX: pointerPos.x })),
				);
		const next = current.map((point, index) =>
			index === activeIndex ? { t, rate } : point,
		);
		latestPointsRef.current = next;
		onChange?.(next);
	}

	function onPointerUp() {
		if (activeIndex === null) return;
		setActiveIndex(null);
		onChangeEnd?.(latestPointsRef.current);
	}

	function onPointerCancel() {
		if (activeIndex === null) return;
		setActiveIndex(null);
		onCancel?.();
	}

	const path = curvePath({ points });
	const oneXLineY = toSvgY({ rate: 1 });

	return (
		<svg
			ref={svgRef}
			viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`}
			className="bg-foreground/3 w-full cursor-crosshair select-none"
			onPointerMove={(event) => onPointerMove({ event })}
			onPointerUp={onPointerUp}
			onPointerCancel={onPointerCancel}
		>
			<title>Speed curve editor</title>
			<line
				x1={GRAPH_PADDING}
				y1={oneXLineY}
				x2={SVG_WIDTH - GRAPH_PADDING}
				y2={oneXLineY}
				className="stroke-foreground/10"
				strokeWidth={1}
				strokeDasharray="3 3"
			/>
			<path
				d={path}
				fill="none"
				className="stroke-primary"
				strokeWidth={2}
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
			{points.map((point, index) => (
				<circle
					// eslint-disable-next-line react/no-array-index-key -- point count is fixed per preset (v1); index is a stable identity here.
					key={index}
					cx={toSvgX({ t: point.t })}
					cy={toSvgY({ rate: point.rate })}
					r={HANDLE_RADIUS}
					className={cn(
						"fill-primary cursor-grab",
						activeIndex === index && "cursor-grabbing",
					)}
					onPointerDown={onHandlePointerDown({ index })}
				/>
			))}
		</svg>
	);
}
