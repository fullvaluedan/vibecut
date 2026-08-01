"use client";

import { useRef } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Delete02Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/utils/ui";
import {
	averageRetimeCurveRate,
	isValidRetimeCurve,
	normalizeRetimeCurve,
	type RetimeCurve,
	type RetimeCurvePoint,
} from "@/retime/curve";
import { RETIME_CURVE_PRESETS } from "@/retime/curve-presets";
import { MAX_RETIME_RATE } from "@/retime/rate";
import { SpeedCurveGraph, SPEED_CURVE_GRAPH_MIN_HEIGHT } from "./speed-curve-graph";

const THUMB_WIDTH = 40;
const THUMB_HEIGHT = 22;
const THUMB_PADDING_X = 3;
const THUMB_PADDING_Y = 3;
const PRESET_MATCH_TOLERANCE = 0.05;

function pointsMatch({
	a,
	b,
}: {
	a: RetimeCurvePoint[];
	b: RetimeCurvePoint[];
}): boolean {
	if (a.length !== b.length) return false;
	return a.every(
		(point, index) =>
			Math.abs(point.t - b[index].t) < PRESET_MATCH_TOLERANCE &&
			Math.abs(point.rate - b[index].rate) < PRESET_MATCH_TOLERANCE,
	);
}

function toThumbX({ t }: { t: number }): number {
	return THUMB_PADDING_X + t * (THUMB_WIDTH - THUMB_PADDING_X * 2);
}

function toThumbY({ rate }: { rate: number }): number {
	const fraction = Math.min(1, Math.max(0, rate / MAX_RETIME_RATE));
	return THUMB_PADDING_Y + (1 - fraction) * (THUMB_HEIGHT - THUMB_PADDING_Y * 2);
}

function CurveThumb({ points }: { points: RetimeCurvePoint[] }) {
	const path = points
		.map((point, index) => {
			const command = index === 0 ? "M" : "L";
			return `${command}${toThumbX({ t: point.t })},${toThumbY({ rate: point.rate })}`;
		})
		.join("");
	return (
		<svg
			width={THUMB_WIDTH}
			height={THUMB_HEIGHT}
			viewBox={`0 0 ${THUMB_WIDTH} ${THUMB_HEIGHT}`}
		>
			<title>Curve preset preview</title>
			<path
				d={path}
				fill="none"
				className="stroke-current"
				strokeWidth={1.5}
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

/**
 * T18.2 Speed tab "Curve" section: the seven CapCut preset chips plus, once
 * a curve is active, an inline piecewise-linear graph (see
 * speed-curve-graph.tsx) for hand-editing it. Mutually exclusive with
 * Reverse (`disabled` covers the reversed case; the caller also hides the
 * Reverse toggle's own affordance when a curve is active - see
 * speed-tab.tsx).
 */
export function SpeedCurveSection({
	curve,
	disabled,
	onPreviewCurve,
	onCommitCurve,
	onSelectPreset,
	onRemoveCurve,
}: {
	curve: RetimeCurve | undefined;
	disabled?: boolean;
	onPreviewCurve: (points: RetimeCurvePoint[]) => void;
	onCommitCurve: (points: RetimeCurvePoint[]) => void;
	onSelectPreset: (presetId: string) => void;
	onRemoveCurve: () => void;
}) {
	const pendingPointsRef = useRef<RetimeCurvePoint[] | null>(null);
	const isActive = curve !== undefined && isValidRetimeCurve({ curve });
	const activePresetId = isActive
		? (RETIME_CURVE_PRESETS.find((preset) =>
				pointsMatch({
					a: normalizeRetimeCurve({ points: preset.points }).points,
					b: curve!.points,
				}),
			)?.id ?? null)
		: null;

	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center justify-between">
				<span className="text-sm">Curve</span>
				{isActive && (
					<Button
						variant="ghost"
						size="sm"
						disabled={disabled}
						onClick={onRemoveCurve}
						className="text-muted-foreground h-6 gap-1 px-1.5 text-xs"
					>
						<HugeiconsIcon icon={Delete02Icon} className="size-3" />
						Remove curve
					</Button>
				)}
			</div>

			<div className="grid grid-cols-4 gap-1">
				{RETIME_CURVE_PRESETS.map((preset) => (
					<button
						key={preset.id}
						type="button"
						disabled={disabled}
						onClick={() => onSelectPreset(preset.id)}
						className={cn(
							"group relative flex flex-col items-center gap-1 rounded-sm px-1 py-1",
							disabled
								? "cursor-not-allowed opacity-50"
								: "hover:bg-foreground/5 cursor-pointer",
							activePresetId === preset.id && "bg-primary/5! text-primary",
						)}
					>
						<div
							className={cn(
								"flex aspect-video w-full items-center justify-center rounded-sm bg-foreground/5",
								activePresetId === preset.id && "bg-primary/5!",
							)}
						>
							<CurveThumb points={preset.points} />
						</div>
						<span
							className={cn(
								"text-[10px] leading-tight",
								activePresetId === preset.id
									? "text-primary"
									: "text-muted-foreground",
							)}
						>
							{preset.label}
						</span>
					</button>
				))}
			</div>

			{isActive && (
				<div style={{ minHeight: SPEED_CURVE_GRAPH_MIN_HEIGHT }}>
					<SpeedCurveGraph
						points={curve!.points}
						onChange={(points) => {
							pendingPointsRef.current = points;
							onPreviewCurve(points);
						}}
						onChangeEnd={(points) => {
							pendingPointsRef.current = null;
							onCommitCurve(points);
						}}
						onCancel={() => {
							if (pendingPointsRef.current) {
								onPreviewCurve(curve!.points);
							}
							pendingPointsRef.current = null;
						}}
					/>
				</div>
			)}

			{isActive && (
				<span className="text-muted-foreground text-[11px] leading-tight">
					Average speed {averageRetimeCurveRate({ curve: curve! }).toFixed(2)}x.
					Drag a point up/down to change its speed, left/right to shift it in
					time.
				</span>
			)}
		</div>
	);
}
