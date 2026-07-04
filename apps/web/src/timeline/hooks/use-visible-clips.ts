import { useMemo } from "react";
import type { TimelineElement } from "@/timeline";
import { timelineTimeToPixels } from "@/timeline/pixel-utils";

/**
 * How far beyond the visible scroll window (in timeline pixels, each side) a clip
 * stays mounted. Scrolling then reveals already-rendered clips instead of a blank
 * gap before the next frame's cull runs. Roughly half a screen at typical widths.
 */
export const TIMELINE_VISIBLE_OVERSCAN_PX = 600;

/** The horizontal viewport we cull against, in timeline pixels. */
export interface VisibleWindow {
	/** Left edge of the visible scroll window (scrollLeft). */
	start: number;
	/** Right edge (scrollLeft + viewport width). */
	end: number;
	/** Extra pixels kept mounted on each side. */
	overscan: number;
}

interface Span {
	id: string;
	/** Left pixel of the clip's span. */
	start: number;
	/** Right pixel of the clip's span. */
	end: number;
}

/** A `.has(id)`-shaped lookup (a Set or a Map both satisfy this). */
interface ForceInclude {
	has(id: string): boolean;
}

/**
 * PURE viewport-culling core (U7 / KTD6). Returns the spans whose pixel range
 * [start, end] intersects the window grown by `overscan` on each side, PLUS any
 * span whose id is force-included. Force-include keeps the active drag target
 * mounted even after it scrolls out of the window (unmounting it mid-drag would
 * break the drag). Edge-touching spans count as visible.
 */
export function selectVisibleSpans<T extends Span>({
	spans,
	window,
	forceInclude,
}: {
	spans: readonly T[];
	window: VisibleWindow;
	forceInclude?: ForceInclude | null;
}): T[] {
	const lo = window.start - window.overscan;
	const hi = window.end + window.overscan;
	const visible: T[] = [];
	for (const span of spans) {
		const intersects = span.start <= hi && span.end >= lo;
		if (intersects || forceInclude?.has(span.id)) {
			visible.push(span);
		}
	}
	return visible;
}

/**
 * Cull a track's elements to those on screen. Absolute positioning is unchanged
 * (each surviving clip is still placed by its own `startTime`), so scroll geometry
 * and layout are identical; only off-screen clips are unmounted.
 *
 * When `window` is null (viewport not measured yet) culling is disabled and every
 * element is returned, so the timeline never renders empty before the first scroll
 * measurement lands.
 */
export function useVisibleClips({
	elements,
	zoomLevel,
	window,
	forceInclude,
}: {
	elements: readonly TimelineElement[];
	zoomLevel: number;
	window: VisibleWindow | null;
	forceInclude?: ForceInclude | null;
}): readonly TimelineElement[] {
	return useMemo(() => {
		if (!window) return elements;
		const spans = elements.map((element) => ({
			id: element.id,
			start: timelineTimeToPixels({ time: element.startTime, zoomLevel }),
			end: timelineTimeToPixels({
				time: element.startTime + element.duration,
				zoomLevel,
			}),
			element,
		}));
		return selectVisibleSpans({ spans, window, forceInclude }).map(
			(span) => span.element,
		);
	}, [elements, zoomLevel, window, forceInclude]);
}
