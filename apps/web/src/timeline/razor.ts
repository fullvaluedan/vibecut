import { BASE_TIMELINE_PIXELS_PER_SECOND } from "@/timeline/scale";

/**
 * Razor (C) click-position → timeline time, in ticks.
 *
 * Pure geometry, deliberately wasm-free (takes `ticksPerSecond` rather than
 * importing it from `@/wasm`) so it can be unit-tested under bun without
 * pulling in the opencut-wasm binary. Given the clicked X (relative to the
 * clip's left edge in CSS px), the clip's absolute start time and duration (in
 * ticks) and the current zoom, return the absolute timeline time under the
 * cursor — clamped strictly inside the clip so the split is never a no-op at
 * the very edges (SplitElementsCommand ignores a splitTime <= start or >= end).
 */
export function razorSplitTimeTicks({
	offsetXPx,
	elementStartTimeTicks,
	elementDurationTicks,
	zoomLevel,
	ticksPerSecond,
}: {
	offsetXPx: number;
	elementStartTimeTicks: number;
	elementDurationTicks: number;
	zoomLevel: number;
	ticksPerSecond: number;
}): number {
	const pixelsPerSecond = BASE_TIMELINE_PIXELS_PER_SECOND * zoomLevel;
	const offsetTicks =
		(Math.max(0, offsetXPx) / pixelsPerSecond) * ticksPerSecond;
	const rawTime = elementStartTimeTicks + offsetTicks;
	const minTime = elementStartTimeTicks + 1;
	const maxTime = elementStartTimeTicks + elementDurationTicks - 1;
	if (maxTime <= minTime) {
		return elementStartTimeTicks + Math.floor(elementDurationTicks / 2);
	}
	return Math.min(maxTime, Math.max(minTime, Math.round(rawTime)));
}
