/**
 * Non-rippling region-overwrite geometry (Premiere "overwrite", not "insert").
 *
 * Given the elements on a single track and the region `[regionStart, regionEnd)`
 * that a freshly-dropped clip will fill, decide what happens to each existing
 * element so the new clip can sit on top WITHOUT shifting anything downstream:
 *
 *   - element fully inside the region        → delete it
 *   - region covers its head, its tail lives → head-trim it (start + in-point)
 *   - element clear of the region            → leave it untouched
 *
 * Pure numbers (ticks), no `@/wasm` import, so it runs under bun; the caller
 * re-brands the results as `MediaTime`.
 *
 * ponytail: the only caller passes a region that STARTS on a clip boundary (the
 * replaced clip's start), so nothing can start before `regionStart` and a
 * left-edge straddle/split can't occur — no split logic. The `elStart <
 * regionStart` branch is a defensive tail-trim that never drops data wrongly,
 * not a real code path.
 */

export interface OverwriteRegionElement {
	id: string;
	startTime: number;
	duration: number;
	trimStart: number;
	/** Retime rate (sourceDuration = timelineDuration * rate). Defaults to 1. */
	rate?: number;
}

export interface OverwriteRegionTrim {
	id: string;
	startTime: number;
	trimStart: number;
	duration: number;
}

export interface OverwriteRegionPlan {
	deleteIds: string[];
	trims: OverwriteRegionTrim[];
}

export function planRegionOverwrite({
	elements,
	regionStart,
	regionEnd,
}: {
	elements: OverwriteRegionElement[];
	regionStart: number;
	regionEnd: number;
}): OverwriteRegionPlan {
	const deleteIds: string[] = [];
	const trims: OverwriteRegionTrim[] = [];

	for (const el of elements) {
		const elStart = el.startTime;
		const elEnd = el.startTime + el.duration;

		// Clear of the region — untouched.
		if (elEnd <= regionStart || elStart >= regionEnd) continue;

		// Fully covered — delete.
		if (elStart >= regionStart && elEnd <= regionEnd) {
			deleteIds.push(el.id);
			continue;
		}

		// Region covers the head, the tail survives — head-trim to regionEnd.
		// The new start advances by `cut` TIMELINE ticks, so the source in-point
		// advances by the matching SOURCE span: cut * rate (sourceDuration =
		// timelineDuration * rate). At rate==1 this is just `cut`. Matches the
		// retime resolver's getSourceTimeAtClipTime(clipTime) = clipTime * rate.
		if (elStart >= regionStart) {
			const cut = regionEnd - elStart;
			const sourceCut = Math.round(cut * (el.rate ?? 1));
			trims.push({
				id: el.id,
				startTime: regionEnd,
				trimStart: el.trimStart + sourceCut,
				duration: el.duration - cut,
			});
			continue;
		}

		// elStart < regionStart: impossible via the real caller. Keep the head up
		// to regionStart, drop the rest — conservative, never deletes data wrongly.
		trims.push({
			id: el.id,
			startTime: el.startTime,
			trimStart: el.trimStart,
			duration: regionStart - elStart,
		});
	}

	return { deleteIds, trims };
}
