"use client";

import { useElementSelection } from "@/timeline/hooks/element/use-element-selection";
import { TimelineElement } from "./timeline-element";
import type { TimelineTrack } from "@/timeline";
import type { TimelineElement as TimelineElementType } from "@/timeline";
import { TIMELINE_LAYERS } from "./layers";
import type { ElementDragView } from "@/timeline";
import { useEditor } from "@/editor/use-editor";
import { useGapSelectionStore } from "@/timeline/gap-selection-store";
import { usePlaceToolStore } from "@/preview/place-tool-store";
import { BASE_TIMELINE_PIXELS_PER_SECOND } from "@/timeline/scale";
import { timelineTimeToPixels } from "@/timeline/pixel-utils";
import { TICKS_PER_SECOND } from "@/wasm";

interface TimelineTrackContentProps {
	track: TimelineTrack;
	zoomLevel: number;
	dragView: ElementDragView;
	onResizeStart: (params: {
		event: React.MouseEvent;
		element: TimelineElementType;
		track: TimelineTrack;
		side: "left" | "right";
	}) => void;
	onElementMouseDown: (params: {
		event: React.MouseEvent;
		element: TimelineElementType;
		track: TimelineTrack;
	}) => void;
	onElementClick: (params: {
		event: React.MouseEvent;
		element: TimelineElementType;
		track: TimelineTrack;
	}) => void;
	onTrackMouseDown?: (event: React.MouseEvent) => void;
	onTrackMouseUp?: (event: React.MouseEvent) => void;
	shouldIgnoreClick?: () => boolean;
	targetElementId?: string | null;
}

export function TimelineTrackContent({
	track,
	zoomLevel,
	dragView,
	onResizeStart,
	onElementMouseDown,
	onElementClick,
	onTrackMouseDown,
	onTrackMouseUp,
	shouldIgnoreClick,
	targetElementId = null,
}: TimelineTrackContentProps) {
	const { isElementSelected } = useElementSelection();
	const editor = useEditor();
	const selectedGap = useGapSelectionStore((s) => s.gap);
	const setGap = useGapSelectionStore((s) => s.setGap);
	const placeTool = usePlaceToolStore((s) => s.tool);
	const isForwardTool = placeTool?.kind === "track-select-forward";

	const clickedTimeTicks = (event: React.MouseEvent): number => {
		const rect = event.currentTarget.getBoundingClientRect();
		const seconds =
			(event.clientX - rect.left) /
			(BASE_TIMELINE_PIXELS_PER_SECOND * zoomLevel);
		return Math.max(0, seconds * TICKS_PER_SECOND);
	};

	// Premiere's Track Select Forward: everything to the right of the click
	// on all tracks; Shift+click = just this track.
	const selectForwardFrom = (event: React.MouseEvent, time: number) => {
		const tracks = editor.scenes.getActiveScene().tracks;
		const pool = event.shiftKey
			? [track]
			: [tracks.main, ...tracks.overlay, ...tracks.audio];
		const refs = pool.flatMap((t) =>
			t.elements
				.filter((el) => el.startTime + el.duration > time)
				.map((el) => ({ trackId: t.id, elementId: el.id })),
		);
		editor.selection.setSelectedElements({ elements: refs });
		// Premiere parity (#2): the track-select gesture is momentary — hand
		// control back to the Selection tool so the freshly-selected group can be
		// dragged immediately (the move controller is selection-driven, not
		// tool-gated). Without this the armed tool keeps swallowing the drag
		// (the isForwardTool gate on element mousedown), so the selection looks
		// stuck.
		usePlaceToolStore.getState().setTool(null);
	};

	// Premiere gap selection: a click between two clips selects the GAP.
	// Returns true when a gap was selected (the seek still happens upstream).
	const trySelectGapAt = (time: number): boolean => {
		if (track.elements.length === 0) return false;
		let previousEnd = 0;
		let nextStart: number | null = null;
		for (const el of track.elements) {
			const start = el.startTime as number;
			const end = el.startTime + el.duration;
			if (time >= start && time < end) return false; // on a clip
			if (end <= time && end > previousEnd) previousEnd = end;
			if (start > time && (nextStart === null || start < nextStart)) {
				nextStart = start;
			}
		}
		// The space after the last clip is not a gap (matches Premiere).
		if (nextStart === null || nextStart - previousEnd <= 0) return false;
		setGap({ trackId: track.id, start: previousEnd, end: nextStart });
		return true;
	};

	const handleBackgroundMouseUp = (event: React.MouseEvent): boolean => {
		const time = clickedTimeTicks(event);
		if (isForwardTool) {
			selectForwardFrom(event, time);
			return true; // consumed — no seek, no deselect
		}
		if (!trySelectGapAt(time)) setGap(null);
		return false;
	};

	return (
		<div className="relative size-full">
			<button
				type="button"
				className="absolute inset-0 m-0 size-full appearance-none border-0 bg-transparent p-0"
				aria-label={`Select ${track.name} track`}
				onMouseUp={(event) => {
					if (shouldIgnoreClick?.()) return;
					if (handleBackgroundMouseUp(event)) return;
					onTrackMouseUp?.(event);
				}}
				onMouseDown={(event) => {
					event.preventDefault();
					if (isForwardTool) return;
					onTrackMouseDown?.(event);
				}}
			/>
			{/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- spatial gesture surface; the wrapping <button> handles keyboard track selection, this <div> only forwards background clicks for box-select / deselect. */}
			<div
				className="relative h-full min-w-full"
				style={{ zIndex: TIMELINE_LAYERS.trackContent }}
				onMouseUp={(event) => {
					if (event.target !== event.currentTarget) return;
					if (shouldIgnoreClick?.()) return;
					if (handleBackgroundMouseUp(event)) return;
					onTrackMouseUp?.(event);
				}}
				onMouseDown={(event) => {
					if (event.target !== event.currentTarget) return;
					event.preventDefault();
					if (isForwardTool) return;
					onTrackMouseDown?.(event);
				}}
			>
				{selectedGap?.trackId === track.id && (
					<div
						className="bg-foreground/20 ring-primary pointer-events-none absolute top-0.5 bottom-0.5 rounded-sm ring-2"
						style={{
							left: timelineTimeToPixels({
								time: selectedGap.start,
								zoomLevel,
							}),
							width: timelineTimeToPixels({
								time: selectedGap.end - selectedGap.start,
								zoomLevel,
							}),
							zIndex: TIMELINE_LAYERS.trackContent,
						}}
					/>
				)}
				{track.elements.length === 0 ? (
					<div className="text-muted-foreground border-muted/30 pointer-events-none flex size-full items-center justify-center rounded-sm border-2 border-dashed text-xs" />
				) : (
					track.elements.map((element) => {
						const isSelected = isElementSelected({
							trackId: track.id,
							elementId: element.id,
						});

						return (
							<TimelineElement
								key={element.id}
								element={element}
								track={track}
								zoomLevel={zoomLevel}
								isSelected={isSelected}
								onResizeStart={({ event, element, side }) =>
									onResizeStart({ event, element, track, side })
								}
								onElementMouseDown={({ event, element }) => {
									if (isForwardTool) return; // no drag with the tool armed
									onElementMouseDown({ event, element, track });
								}}
								onElementClick={({ event, element }) => {
									if (isForwardTool) {
										// Clicking a clip selects it and everything after it.
										selectForwardFrom(event, element.startTime as number);
										return;
									}
									setGap(null);
									onElementClick({ event, element, track });
								}}
								dragView={dragView}
								isDropTarget={element.id === targetElementId}
							/>
						);
					})
				)}
			</div>
		</div>
	);
}
