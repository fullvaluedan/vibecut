"use client";

import { useCallback } from "react";
import { useElementSelection } from "@/timeline/hooks/element/use-element-selection";
import { useCommittedRef } from "@/hooks/use-committed-ref";
import { TimelineElement } from "./timeline-element";
import type { TimelineTrack } from "@/timeline";
import type { TimelineElement as TimelineElementType } from "@/timeline";
import { TIMELINE_LAYERS } from "./layers";
import type { ElementDragSlice, ElementDragView } from "@/timeline";
import { useEditor } from "@/editor/use-editor";
import { useGapSelectionStore } from "@/timeline/gap-selection-store";
import { usePlaceToolStore } from "@/preview/place-tool-store";
import { BASE_TIMELINE_PIXELS_PER_SECOND } from "@/timeline/scale";
import { timelineTimeToPixels } from "@/timeline/pixel-utils";
import { TICKS_PER_SECOND } from "@/wasm";
import { cn } from "@/utils/ui";

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
	const selectForwardFrom = ({
		event,
		time,
	}: {
		event: React.MouseEvent;
		time: number;
	}) => {
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
			selectForwardFrom({ event, time });
			return true; // consumed — no seek, no deselect
		}
		if (!trySelectGapAt(time)) setGap(null);
		return false;
	};

	// The per-clip callbacks below MUST keep a stable identity across a drag so
	// the memoized TimelineElement skips re-rendering untouched clips. They close
	// over values that change identity every render (selectForwardFrom, setGap,
	// the handlers), so read those from a committed ref and keep the callbacks
	// themselves referentially stable. Behavior is unchanged: the ref always
	// holds the latest values by the time an event fires.
	const clipHandlerCtxRef = useCommittedRef({
		track,
		isForwardTool,
		isElementSelected,
		selectForwardFrom,
		setGap,
		onResizeStart,
		onElementMouseDown,
		onElementClick,
	});

	const handleClipResizeStart = useCallback(
		({
			event,
			element,
			side,
		}: {
			event: React.MouseEvent;
			element: TimelineElementType;
			side: "left" | "right";
		}) => {
			const ctx = clipHandlerCtxRef.current;
			ctx.onResizeStart({ event, element, track: ctx.track, side });
		},
		[clipHandlerCtxRef],
	);

	const handleClipMouseDown = useCallback(
		({
			event,
			element,
		}: {
			event: React.MouseEvent;
			element: TimelineElementType;
		}) => {
			const ctx = clipHandlerCtxRef.current;
			// Track Select Forward: pressing an unselected clip selects everything
			// forward AND begins a drag in the same gesture, so one press-drag shoves
			// the whole group right (open a gap to drag a cut clip's head into). A
			// plain press still just forward-selects (the controller only commits a
			// move if you actually move). The controller reads LIVE selection, so the
			// just-made forward selection is the move group.
			if (
				ctx.isForwardTool &&
				!ctx.isElementSelected({
					trackId: ctx.track.id,
					elementId: element.id,
				})
			) {
				ctx.selectForwardFrom({ event, time: element.startTime as number });
			}
			ctx.onElementMouseDown({ event, element, track: ctx.track });
		},
		[clipHandlerCtxRef],
	);

	const handleClipClick = useCallback(
		({
			event,
			element,
		}: {
			event: React.MouseEvent;
			element: TimelineElementType;
		}) => {
			const ctx = clipHandlerCtxRef.current;
			if (ctx.isForwardTool) {
				// Only (re)select forward when the clip isn't already part of the
				// selection, so the click that follows a move-drag doesn't reset what
				// you just moved.
				if (
					!ctx.isElementSelected({
						trackId: ctx.track.id,
						elementId: element.id,
					})
				) {
					ctx.selectForwardFrom({ event, time: element.startTime as number });
				}
				return;
			}
			ctx.setGap(null);
			ctx.onElementClick({ event, element, track: ctx.track });
		},
		[clipHandlerCtxRef],
	);

	const isDragging = dragView.kind === "dragging";

	return (
		<div className={cn("relative size-full", isForwardTool && "cursor-e-resize")}>
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

						// Only clips actually carried by the drag get a (fresh) drag slice;
						// every other clip gets `null` (a stable reference) so its props are
						// unchanged and the memoized TimelineElement skips re-rendering.
						const timeOffset =
							isDragging && dragView.kind === "dragging"
								? dragView.memberTimeOffsets.get(element.id)
								: undefined;
						const drag: ElementDragSlice | null =
							timeOffset !== undefined && dragView.kind === "dragging"
								? {
										timeOffset,
										currentTime: dragView.currentTime,
										offsetY: dragView.currentMouseY - dragView.startMouseY,
									}
								: null;

						return (
							<TimelineElement
								key={element.id}
								element={element}
								track={track}
								zoomLevel={zoomLevel}
								isSelected={isSelected}
								onResizeStart={handleClipResizeStart}
								onElementMouseDown={handleClipMouseDown}
								onElementClick={handleClipClick}
								drag={drag}
								isDropTarget={element.id === targetElementId}
							/>
						);
					})
				)}
			</div>
		</div>
	);
}
