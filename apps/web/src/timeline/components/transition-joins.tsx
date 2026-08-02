"use client";

import { useMemo, useState } from "react";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { NumberField } from "@/components/ui/number-field";
import { useEditor } from "@/editor/use-editor";
import type { TimelineTrack } from "@/timeline";
import { timelineTimeToPixels } from "@/timeline/pixel-utils";
import {
	canBoundaryHoldTransition,
	clampTransitionDurationSec,
	collectTransitionBoundaries,
	DEFAULT_TRANSITION_DURATION_SEC,
	describeTransitionHeadroom,
	isTransitionCapableElement,
	TRANSITION_AUDIO_NOTE,
	TRANSITION_DURATION_PRESETS_SEC,
	TRANSITION_KIND_INFO,
	type TransitionBoundary,
	type TransitionKind,
	type TransitionSpec,
} from "@/timeline/transitions";
import { generateUUID } from "@/utils/id";
import { cn } from "@/utils/ui";
import { TICKS_PER_SECOND } from "@/wasm";
import { TIMELINE_LAYERS } from "./layers";

/** Half-width of the invisible hover strip that reveals a boundary's chip. */
const HOVER_ZONE_HALF_WIDTH_PX = 14;

/**
 * T19.3 join UI. A main-track boundary shows a small chip on hover; clicking it
 * opens the mini-picker (kinds + duration presets + custom). An APPLIED
 * boundary draws a bracket spanning the two clip ends (CapCut's join badge) and
 * right-clicking the badge removes it. Every apply / re-time / remove is one
 * undoable command (`TimelineManager.setElementTransition`).
 */
export function TransitionJoinLayer({
	track,
	zoomLevel,
}: {
	track: TimelineTrack;
	zoomLevel: number;
}) {
	const editor = useEditor();
	const [openKey, setOpenKey] = useState<string | null>(null);

	const boundaries = useMemo(
		() =>
			collectTransitionBoundaries({ elements: track.elements }).filter(
				(boundary) => canBoundaryHoldTransition({ boundary }),
			),
		[track.elements],
	);

	const applyTransition = ({
		boundary,
		spec,
	}: {
		boundary: TransitionBoundary;
		spec: TransitionSpec | null;
	}) => {
		editor.timeline.setElementTransition({
			trackId: track.id,
			elementId: boundary.ownerElementId,
			field: boundary.ownerField,
			spec,
		});
	};

	if (boundaries.length === 0) return null;

	return (
		<div
			className="pointer-events-none absolute inset-0"
			style={{ zIndex: TIMELINE_LAYERS.transitionChip }}
		>
			{boundaries.map((boundary) => (
				<BoundarySlot
					key={boundary.key}
					boundary={boundary}
					track={track}
					zoomLevel={zoomLevel}
					isOpen={openKey === boundary.key}
					onOpenChange={(open) => setOpenKey(open ? boundary.key : null)}
					onApply={(spec) => applyTransition({ boundary, spec })}
				/>
			))}
		</div>
	);
}

/** Timeline span the applied transition visually covers, in ticks. */
function getAppliedSpanTicks({
	boundary,
	spec,
}: {
	boundary: TransitionBoundary;
	spec: TransitionSpec;
}): { startTicks: number; endTicks: number } {
	const totalTicks = timelineTicksFromSeconds({ seconds: spec.durationSec });
	if (boundary.kind === "join") {
		const half = Math.round(totalTicks / 2);
		return {
			startTicks: boundary.timeTicks - half,
			endTicks: boundary.timeTicks + half,
		};
	}
	if (boundary.kind === "openHead") {
		return {
			startTicks: boundary.timeTicks,
			endTicks: boundary.timeTicks + totalTicks,
		};
	}
	return {
		startTicks: boundary.timeTicks - totalTicks,
		endTicks: boundary.timeTicks,
	};
}

function timelineTicksFromSeconds({ seconds }: { seconds: number }): number {
	return Math.round(seconds * TICKS_PER_SECOND);
}

function BoundarySlot({
	boundary,
	track,
	zoomLevel,
	isOpen,
	onOpenChange,
	onApply,
}: {
	boundary: TransitionBoundary;
	track: TimelineTrack;
	zoomLevel: number;
	isOpen: boolean;
	onOpenChange: (open: boolean) => void;
	onApply: (spec: TransitionSpec | null) => void;
}) {
	const centerPx = timelineTimeToPixels({
		time: boundary.timeTicks,
		zoomLevel,
	});
	const spec = boundary.spec;
	const applied = spec
		? getAppliedSpanTicks({ boundary, spec })
		: null;

	return (
		<>
			{applied && (
				<div
					className="border-primary/70 bg-primary/15 pointer-events-none absolute top-1 bottom-1 rounded-sm border"
					style={{
						left: timelineTimeToPixels({
							time: applied.startTicks,
							zoomLevel,
						}),
						width: Math.max(
							4,
							timelineTimeToPixels({
								time: applied.endTicks - applied.startTicks,
								zoomLevel,
							}),
						),
					}}
				/>
			)}
			<div
				className="group pointer-events-auto absolute top-0 bottom-0 flex items-center justify-center"
				style={{
					left: centerPx - HOVER_ZONE_HALF_WIDTH_PX,
					width: HOVER_ZONE_HALF_WIDTH_PX * 2,
				}}
			>
				<Popover open={isOpen} onOpenChange={onOpenChange}>
					<PopoverTrigger asChild>
						<button
							type="button"
							aria-label={
								spec
									? `Edit ${TRANSITION_KIND_INFO[spec.kind].label}`
									: "Add transition"
							}
							title={
								spec
									? `${TRANSITION_KIND_INFO[spec.kind].label} ${spec.durationSec}s`
									: "Add transition"
							}
							onContextMenu={(event) => {
								if (!spec) return;
								event.preventDefault();
								event.stopPropagation();
								onApply(null);
							}}
							onMouseDown={(event) => {
								// The track surface behind this layer starts box-select /
								// deselect on mousedown; the chip is its own gesture.
								event.stopPropagation();
							}}
							className={cn(
								"border-border bg-background/95 text-foreground flex size-4 items-center justify-center rounded-full border shadow-sm transition-opacity",
								spec || isOpen
									? "opacity-100"
									: "opacity-0 group-hover:opacity-100",
							)}
						>
							<TransitionGlyph kind={spec?.kind ?? null} />
						</button>
					</PopoverTrigger>
					<PopoverContent align="center" className="w-60 p-2">
						<TransitionPicker
							boundary={boundary}
							track={track}
							onApply={(next) => {
								onApply(next);
								onOpenChange(false);
							}}
						/>
					</PopoverContent>
				</Popover>
			</div>
		</>
	);
}

function TransitionGlyph({ kind }: { kind: TransitionKind | null }) {
	if (kind === null) {
		return (
			<svg viewBox="0 0 12 12" className="size-2.5" aria-hidden="true">
				<path
					d="M6 2v8M2 6h8"
					stroke="currentColor"
					strokeWidth="1.6"
					strokeLinecap="round"
				/>
			</svg>
		);
	}
	if (kind === "crossDissolve") {
		return (
			<svg viewBox="0 0 12 12" className="size-2.5" aria-hidden="true">
				<path d="M1 10 6 2v8Z" fill="currentColor" opacity="0.9" />
				<path d="M11 10 6 2v8Z" fill="currentColor" opacity="0.45" />
			</svg>
		);
	}
	if (kind === "fade") {
		return (
			<svg viewBox="0 0 12 12" className="size-2.5" aria-hidden="true">
				<path d="M1 10 11 2v8Z" fill="currentColor" opacity="0.8" />
			</svg>
		);
	}
	const dipFill = kind === "dipToBlack" ? "#000000" : "#ffffff";
	return (
		<svg viewBox="0 0 12 12" className="size-2.5" aria-hidden="true">
			<rect
				x="1"
				y="2"
				width="10"
				height="8"
				rx="1.5"
				fill={dipFill}
				stroke="currentColor"
				strokeWidth="1"
			/>
		</svg>
	);
}

function TransitionPicker({
	boundary,
	track,
	onApply,
}: {
	boundary: TransitionBoundary;
	track: TimelineTrack;
	onApply: (spec: TransitionSpec | null) => void;
}) {
	const spec = boundary.spec;
	const [durationDraft, setDurationDraft] = useState(
		String(spec?.durationSec ?? DEFAULT_TRANSITION_DURATION_SEC),
	);

	const headroom = useMemo(() => {
		const byId = new Map(track.elements.map((element) => [element.id, element]));
		const pick = (id: string | null) => {
			if (!id) return null;
			const element = byId.get(id);
			return element && isTransitionCapableElement(element) ? element : null;
		};
		return describeTransitionHeadroom({
			left: pick(boundary.leftElementId),
			right: pick(boundary.rightElementId),
			durationSec: spec?.durationSec ?? DEFAULT_TRANSITION_DURATION_SEC,
		});
	}, [
		track.elements,
		boundary.leftElementId,
		boundary.rightElementId,
		spec?.durationSec,
	]);

	const commit = ({
		kind,
		durationSec,
	}: {
		kind: TransitionKind;
		durationSec: number;
	}) => {
		onApply({
			id: spec?.id ?? generateUUID(),
			kind,
			durationSec: clampTransitionDurationSec({
				requestedSec: durationSec,
				maxDurationSec: boundary.maxDurationSec,
			}),
		});
	};

	const currentDuration = spec?.durationSec ?? DEFAULT_TRANSITION_DURATION_SEC;
	const activeKind = spec?.kind ?? boundary.allowedKinds[0];

	return (
		<div className="flex flex-col gap-2">
			<div className="grid grid-cols-2 gap-1">
				{boundary.allowedKinds.map((kind) => (
					<button
						key={kind}
						type="button"
						onClick={() => commit({ kind, durationSec: currentDuration })}
						className={cn(
							"hover:bg-accent flex items-center gap-1.5 rounded-sm border px-1.5 py-1 text-left text-[11px]",
							spec?.kind === kind ? "border-primary" : "border-transparent",
						)}
					>
						<span className="text-foreground flex size-4 items-center justify-center">
							<TransitionGlyph kind={kind} />
						</span>
						<span className="truncate">{TRANSITION_KIND_INFO[kind].label}</span>
					</button>
				))}
			</div>

			<div className="flex items-center gap-1">
				{TRANSITION_DURATION_PRESETS_SEC.filter(
					(preset) => preset <= boundary.maxDurationSec,
				).map((preset) => (
					<button
						key={preset}
						type="button"
						onClick={() => {
							setDurationDraft(String(preset));
							commit({ kind: activeKind, durationSec: preset });
						}}
						className={cn(
							"hover:bg-accent rounded-sm border px-1.5 py-0.5 text-[11px]",
							currentDuration === preset
								? "border-primary"
								: "border-transparent",
						)}
					>
						{preset}s
					</button>
				))}
				<NumberField
					value={durationDraft}
					suffix="s"
					className="ml-auto w-16"
					aria-label="Transition duration in seconds"
					allowExpressions={false}
					onChange={(event) => setDurationDraft(event.target.value)}
					onBlur={() => {
						const parsed = Number(durationDraft.trim());
						if (!Number.isFinite(parsed)) {
							setDurationDraft(String(currentDuration));
							return;
						}
						commit({ kind: activeKind, durationSec: parsed });
					}}
					onCancel={() => setDurationDraft(String(currentDuration))}
				/>
			</div>

			{spec && (
				<button
					type="button"
					onClick={() => onApply(null)}
					className="hover:bg-accent rounded-sm border border-transparent px-1.5 py-0.5 text-left text-[11px]"
				>
					Remove transition
				</button>
			)}

			<p className="text-muted-foreground text-[10px] leading-tight">
				{TRANSITION_AUDIO_NOTE}
				{boundary.kind === "join" &&
					activeKind === "crossDissolve" &&
					(headroom.leftEdgeHold || headroom.rightEdgeHold) && (
						<>
							{" "}
							One side has no spare footage, so it holds its edge frame through
							the blend.
						</>
					)}
			</p>
		</div>
	);
}
