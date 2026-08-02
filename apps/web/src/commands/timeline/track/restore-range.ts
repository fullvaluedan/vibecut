import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { SceneTracks, TimelineElement, TimelineTrack } from "@/timeline";
import { isRetimableElement } from "@/timeline";
import { getSourceSpanAtClipTime } from "@/retime";
import { generateUUID } from "@/utils/id";

/**
 * RESTORE (T16.2): the sub-range inverse of `RemoveRangesCommand`. It re-opens a
 * gap the cut closed and puts the removed footage back, as ONE undoable command,
 * so the transcript panel's per-word restore is a real edit rather than a
 * whole-batch undo.
 *
 * HOW THE CONTENT IS RECOVERED. The transcript lineage remembers WHICH source
 * span a cut removed, not what media filled it - so the footage is recovered
 * GEOMETRICALLY, from the clip the cut was made in. At the seam, the clip on the
 * left ends exactly where the cut started and the clip on the right resumes
 * exactly `removedTotal` further into the same source (that is precisely what
 * `RemoveRangesCommand.cutElement` does to a straddled element). When both
 * neighbours agree on that, the removed footage is unambiguously the donor's own
 * source continuing past its out-point, and the filler is a slice of the donor.
 *
 * When the neighbours do NOT agree - the cut removed a whole clip, or it spanned
 * a real join between two different clips - the media is genuinely unknowable
 * from the lineage alone. That track then re-opens the gap WITHOUT a filler:
 * every track still shifts by the same amount at the same time, so A/V sync and
 * the other tracks' restored content stay exact; only that one lane has a hole.
 * Restoring wrong footage would be far worse than a visible gap.
 *
 * MERGE-BACK. After the filler lands it is merged with either neighbour it is
 * source-contiguous with (same rule as `ConsolidateAdjacentClipsCommand`, scoped
 * to the seam instead of the whole timeline so a restore never silently
 * re-merges clips elsewhere). A FULL restore therefore returns the timeline to
 * byte-identical pre-cut state, ids included, rather than leaving three
 * fragments behind.
 */

/** Sub-frame rounding slack: 1ms in ticks, as in consolidate-adjacent-clips.ts. */
const TOLERANCE_TICKS = 120;

/**
 * Snap a source span to whole ticks. A local copy of `roundMediaTime`'s rule
 * (round half away from zero) rather than the `@/wasm` import, so this module -
 * the inverse of a cut the transcript panel drives - stays bun-testable without
 * the opencut-wasm binary, the same precedent as `lineage.ts` and
 * `director/source-map.ts`. Every value here is a non-negative tick count.
 */
const roundTicks = (value: number): number =>
	Math.sign(value) * Math.round(Math.abs(value));

/** One span of removed time to put back. All values are plain ticks. */
export interface RestoreRange {
	/** Where the content re-enters the CURRENT timeline. */
	insertAt: number;
	/** Offset of this span from the START of the removal it came out of. */
	offset: number;
	/** How much timeline time to re-open at `insertAt`. */
	duration: number;
	/** Total time the removal took out here (>= `offset` + `duration`). */
	removedTotal: number;
}

/** Source ticks consumed by `clipTime` timeline ticks of `element`. */
function sourceSpan({
	element,
	clipTime,
}: {
	element: TimelineElement;
	clipTime: number;
}): number {
	return roundTicks(
		getSourceSpanAtClipTime({
			clipTime,
			retime: isRetimableElement(element) ? element.retime : undefined,
		}),
	);
}

/** The source tick the element's out-point sits on. */
function sourceEnd(element: TimelineElement): number {
	return element.trimStart + sourceSpan({ element, clipTime: element.duration });
}

/**
 * Everything that identifies WHICH source slice an element shows, minus the four
 * fields a cut rewrites. Two elements with the same key came from the same
 * original clip, so one can donate footage to the other's side of a seam. A
 * plain serialization covers media clips, library audio and text alike, and any
 * difference at all (a different mediaId, different effects, a different retime)
 * simply means "not the same source", which is the safe answer.
 */
function sourceKey(element: TimelineElement): string {
	const rest: Record<string, unknown> = {
		...(element as unknown as Record<string, unknown>),
	};
	delete rest.id;
	delete rest.startTime;
	delete rest.duration;
	delete rest.trimStart;
	delete rest.trimEnd;
	delete rest.linkId;
	try {
		return JSON.stringify(rest);
	} catch {
		// A non-serializable field (an AudioBuffer on a library clip): fall back to
		// the coarse identity rather than throwing mid-command.
		return `${element.type}:${element.name}`;
	}
}

const near = (a: number, b: number): boolean => Math.abs(a - b) <= TOLERANCE_TICKS;

/** The element to take the restored footage from, and where in its source. */
interface Donor {
	element: TimelineElement;
	/** Source tick the restored slice starts at. */
	sourceStart: number;
}

/**
 * Resolve the donor for one seam on one track (see the module comment). `left`
 * ends at the seam, `right` resumes at it; either may be missing at the head or
 * tail of the timeline.
 */
function resolveDonor({
	left,
	right,
	hasLater,
	hasEarlier,
	range,
}: {
	left: TimelineElement | null;
	right: TimelineElement | null;
	/** Some element starts at or after the seam (so this is not the track's tail). */
	hasLater: boolean;
	/** Some element ends at or before the seam (so this is not the track's head). */
	hasEarlier: boolean;
	range: RestoreRange;
}): Donor | null {
	if (left && right) {
		if (sourceKey(left) !== sourceKey(right)) return null;
		const removedSource = sourceSpan({
			element: left,
			clipTime: range.removedTotal,
		});
		if (!near(right.trimStart - sourceEnd(left), removedSource)) return null;
		return {
			element: left,
			sourceStart:
				sourceEnd(left) + sourceSpan({ element: left, clipTime: range.offset }),
		};
	}
	if (left && !hasLater) {
		// Tail cut: nothing follows on this track, so the removed time can only have
		// been this clip's own source continuing past its out-point. Refuse when the
		// media provably does not reach that far. (A whole trailing CLIP removed by
		// the same cut is indistinguishable from this and would restore the donor's
		// footage instead - the one ambiguity the geometry cannot settle, and the
		// reason a mid-timeline hole refuses rather than guesses.)
		const start =
			sourceEnd(left) + sourceSpan({ element: left, clipTime: range.offset });
		const span = sourceSpan({ element: left, clipTime: range.duration });
		if (left.sourceDuration != null && start + span > left.sourceDuration) return null;
		return { element: left, sourceStart: start };
	}
	if (right && !hasEarlier) {
		// Head cut: nothing precedes on this track, so walk BACK from the right
		// neighbour's in-point by whatever the removal still holds after this slice.
		const trailing = sourceSpan({
			element: right,
			clipTime: range.removedTotal - range.offset - range.duration,
		});
		const span = sourceSpan({ element: right, clipTime: range.duration });
		const start = right.trimStart - trailing - span;
		if (start < 0) return null;
		return { element: right, sourceStart: start };
	}
	return null;
}

/** Split an element that straddles `at` into two adjacent halves. */
function splitAt({
	element,
	at,
}: {
	element: TimelineElement;
	at: number;
}): TimelineElement[] {
	const leftDuration = at - element.startTime;
	const leftSource = sourceSpan({ element, clipTime: leftDuration });
	const totalSource = sourceSpan({ element, clipTime: element.duration });
	return [
		{
			...element,
			duration: leftDuration,
			trimEnd: element.trimEnd + (totalSource - leftSource),
		} as TimelineElement,
		{
			...element,
			id: generateUUID(),
			startTime: at,
			duration: element.duration - leftDuration,
			trimStart: element.trimStart + leftSource,
		} as TimelineElement,
	];
}

/** Merge `b` into `a` when they are adjacent AND source-contiguous. */
function merged({
	a,
	b,
}: {
	a: TimelineElement;
	b: TimelineElement;
}): TimelineElement | null {
	if (!near(a.startTime + a.duration, b.startTime)) return null;
	if (sourceKey(a) !== sourceKey(b)) return null;
	if (!near(b.trimStart, sourceEnd(a))) return null;
	return {
		...a,
		duration: a.duration + b.duration,
		trimEnd: b.trimEnd,
	} as TimelineElement;
}

/**
 * Re-open `range` on one track: split any straddler, shift everything at or
 * after the seam right, and drop in the donor's slice where the cut was.
 */
export function restoreRangeInTrack<T extends TimelineTrack>({
	track,
	range,
	linkIdFor,
}: {
	track: T;
	range: RestoreRange;
	/** Fresh link id for a standalone filler, shared across tracks per group. */
	linkIdFor: (linkId: string) => string;
}): T {
	const { insertAt, duration } = range;

	// 1. A straddler means this is NOT a cut point on this track (its source runs
	// straight through), so it is torn open rather than filled.
	let torn = false;
	const split = track.elements.flatMap((element) => {
		const end = element.startTime + element.duration;
		if (element.startTime + TOLERANCE_TICKS < insertAt && insertAt + TOLERANCE_TICKS < end) {
			torn = true;
			return splitAt({ element, at: insertAt });
		}
		return [element];
	});

	// 2. The seam's two neighbours, read BEFORE anything moves.
	let left: TimelineElement | null = null;
	let right: TimelineElement | null = null;
	let hasLater = false;
	let hasEarlier = false;
	for (const element of split) {
		const end = element.startTime + element.duration;
		if (near(end, insertAt)) left = element;
		else if (end <= insertAt) hasEarlier = true;
		if (near(element.startTime, insertAt)) right = element;
		else if (element.startTime >= insertAt) hasLater = true;
	}

	// 3. Re-open the gap: everything from the seam onwards slides right, the exact
	// inverse of RemoveRangesCommand's ripple.
	const shifted = split.map((element) =>
		element.startTime + TOLERANCE_TICKS >= insertAt
			? ({ ...element, startTime: element.startTime + duration } as TimelineElement)
			: element,
	);

	const donor = torn
		? null
		: resolveDonor({ left, right, hasLater, hasEarlier, range });
	if (!donor) return { ...track, elements: shifted };

	const filler = {
		...donor.element,
		id: generateUUID(),
		startTime: insertAt,
		duration,
		trimStart: donor.sourceStart,
	} as TimelineElement;

	// 4. Merge back into whichever neighbour the slice is source-contiguous with,
	// so a full restore rebuilds the ORIGINAL clip (id included) instead of
	// leaving three fragments. Only the seam's own two neighbours are considered -
	// a restore must never re-merge clips the user split elsewhere.
	const elements: TimelineElement[] = [...shifted];
	const leftIndex = elements.findIndex((element) =>
		near(element.startTime + element.duration, insertAt),
	);
	const rawRightIndex = elements.findIndex((element) =>
		near(element.startTime, insertAt + duration),
	);
	let fillerIndex =
		leftIndex >= 0
			? leftIndex + 1
			: rawRightIndex >= 0
				? rawRightIndex
				: elements.length;
	elements.splice(fillerIndex, 0, filler);
	const rightIndex =
		rawRightIndex >= fillerIndex ? rawRightIndex + 1 : rawRightIndex;

	let standalone = true;
	if (rightIndex >= 0) {
		const combined = merged({
			a: elements[fillerIndex],
			b: elements[rightIndex],
		});
		if (combined) {
			elements[fillerIndex] = combined;
			elements.splice(rightIndex, 1);
			if (rightIndex < fillerIndex) fillerIndex -= 1;
			standalone = false;
		}
	}
	if (leftIndex >= 0) {
		const combined = merged({
			a: elements[leftIndex],
			b: elements[fillerIndex],
		});
		if (combined) {
			elements[leftIndex] = combined;
			elements.splice(fillerIndex, 1);
			fillerIndex = leftIndex;
			standalone = false;
		}
	}

	// A filler that survived on its own (an interior restore) must not keep the
	// donor's link id: three clips on one id makes A/V pairing ambiguous. Mint one
	// fresh id per link group per range, exactly as SplitElementsCommand does, so
	// the video filler and its audio filler stay ganged with each other.
	const settled = elements[fillerIndex];
	if (standalone && settled.linkId !== undefined) {
		elements[fillerIndex] = {
			...settled,
			linkId: linkIdFor(settled.linkId),
		} as TimelineElement;
	}

	return { ...track, elements };
}

/**
 * Put removed source ranges back on every track as one undoable command. Ranges
 * are applied from the LATEST seam backwards so the earlier ones' `insertAt`
 * stays valid while the timeline grows underneath them (the mirror of
 * `RemoveRangesCommand`'s descending cut order).
 */
export class RestoreRangeCommand extends Command {
	private savedState: SceneTracks | null = null;
	private restoredTicks = 0;

	constructor(private readonly options: { ranges: RestoreRange[] }) {
		super();
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;
		// Reset, not accumulate: a redo re-runs execute on the same instance.
		this.restoredTicks = 0;

		const ranges = [...this.options.ranges]
			.filter((r) => r.duration > 0)
			.sort((a, b) => b.insertAt - a.insertAt);
		if (!ranges.length) return;

		let tracks = this.savedState;
		for (const range of ranges) {
			// One fresh link id per group per RANGE: two fillers from the same seam
			// on linked tracks must gang together, and fillers from different seams
			// must not.
			const fresh = new Map<string, string>();
			const linkIdFor = (linkId: string): string => {
				let next = fresh.get(linkId);
				if (next === undefined) {
					next = generateUUID();
					fresh.set(linkId, next);
				}
				return next;
			};
			const apply = <T extends TimelineTrack>(track: T): T =>
				restoreRangeInTrack({ track, range, linkIdFor });
			tracks = {
				...tracks,
				main: apply(tracks.main),
				overlay: tracks.overlay.map(apply),
				audio: tracks.audio.map(apply),
			};
			this.restoredTicks += range.duration;
		}

		editor.timeline.updateTracks(tracks);
		// The merge-back drops absorbed element ids, so declare the reconciled
		// selection (same invariant RemoveRangesCommand / ConsolidateAdjacentClips
		// satisfy) and undo restores the pre-restore selection cleanly.
		return { selection: editor.selection.getSnapshot() };
	}

	undo(): void {
		if (this.savedState) {
			EditorCore.getInstance().timeline.updateTracks(this.savedState);
		}
	}

	/** Total timeline ticks put back (0 until `execute` runs). */
	getRestoredTicks(): number {
		return this.restoredTicks;
	}
}
