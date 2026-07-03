/**
 * KTD5 adjacent-slice consolidation (U4). After the cut/trim ops are applied the
 * timeline is fragmented into many clips; this pass merges consecutive clips that
 * are the SAME source with NOTHING removed between them back into one, collapsing
 * the fragment count without changing a single output frame.
 *
 * Two consecutive clips merge when:
 *  - same `mediaId` (and both are mergeable raw media slices), AND
 *  - source-contiguous: `next.trimStart === prev.trimStart + prev.duration` (no
 *    source content was removed between them), AND
 *  - timeline-adjacent: `next.startTime === prev.startTime + prev.duration` (no
 *    timeline gap between them, so filling it changes nothing).
 *
 * All three within a small `toleranceTicks` to absorb sub-frame rounding only (far
 * below one frame, so a real removed gap never merges). Merging keeps the FIRST
 * clip's id / start / trimStart and extends its duration to the sum, so the pass is
 * idempotent and total timeline duration is unchanged. The command applies this
 * per-track; because the cuts hit every track with identical ranges, a video clip
 * and its linked audio fragment at the same points and therefore merge in lockstep.
 *
 * Pure + wasm-free (plain integer ticks) -> bun-testable. The command adapts real
 * `TimelineElement`s (MediaTime reads as number) to/from this shape.
 */

/** One timeline clip as the consolidation reasons over it (plain integer ticks). */
export interface ConsolidateClip {
	id: string;
	/** Source media id; two merged clips must share it. Ignored when not mergeable. */
	mediaId: string;
	startTime: number;
	trimStart: number;
	duration: number;
	/**
	 * False for a clip that must never merge (non-media, retimed, or carrying
	 * effects / masks / animations the merge can't preserve). Such a clip is always
	 * its own group and also breaks a run, so it is never absorbed into a neighbor.
	 */
	mergeable: boolean;
}

/** One output group: the kept clip plus the ids merged into it (in order). */
export interface ConsolidateGroup {
	/** The FIRST clip's id, kept as the merged clip. */
	keepId: string;
	/** Ids of the following clips merged into `keepId`, in timeline order (dropped). */
	absorbedIds: string[];
	startTime: number;
	trimStart: number;
	/** Merged duration = sum of the merged clips' durations. */
	duration: number;
	mediaId: string;
	mergeable: boolean;
}

function canMerge(
	group: ConsolidateGroup,
	next: ConsolidateClip,
	toleranceTicks: number,
): boolean {
	if (!group.mergeable || !next.mergeable) return false;
	if (!next.mediaId || next.mediaId !== group.mediaId) return false;
	const sourceEnd = group.trimStart + group.duration;
	const timelineEnd = group.startTime + group.duration;
	return (
		Math.abs(next.trimStart - sourceEnd) <= toleranceTicks &&
		Math.abs(next.startTime - timelineEnd) <= toleranceTicks
	);
}

/**
 * Merge consecutive same-source contiguous clips into groups. Input is one track's
 * clips; they are sorted by `startTime` defensively. Returns one group per output
 * clip (a lone clip is a group with no `absorbedIds`), in timeline order.
 */
export function consolidateAdjacentClips({
	clips,
	toleranceTicks = 0,
}: {
	clips: readonly ConsolidateClip[];
	toleranceTicks?: number;
}): ConsolidateGroup[] {
	const sorted = [...clips].sort((a, b) => a.startTime - b.startTime);
	const groups: ConsolidateGroup[] = [];
	for (const clip of sorted) {
		const last = groups[groups.length - 1];
		if (last && canMerge(last, clip, toleranceTicks)) {
			last.absorbedIds.push(clip.id);
			last.duration += clip.duration; // keep start/trimStart/keepId of the first
		} else {
			groups.push({
				keepId: clip.id,
				absorbedIds: [],
				startTime: clip.startTime,
				trimStart: clip.trimStart,
				duration: clip.duration,
				mediaId: clip.mediaId,
				mergeable: clip.mergeable,
			});
		}
	}
	return groups;
}
