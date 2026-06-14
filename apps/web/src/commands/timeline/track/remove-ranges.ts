import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { SceneTracks, TimelineElement, TimelineTrack } from "@/timeline";
import { generateUUID } from "@/utils/id";

export interface TimeRange {
	/** ticks */
	start: number;
	/** ticks */
	end: number;
	/**
	 * When set, the range is cut from ONLY this track (a per-track ripple, like
	 * Premiere's ripple-delete on a selected clip). When omitted, the range is
	 * cut from every track (the all-track extract used by Remove Silences /
	 * Repeats / Autocut and gap ripple).
	 */
	trackId?: string;
}

function cutElement({
	element,
	range,
}: {
	element: TimelineElement;
	range: TimeRange;
}): TimelineElement[] {
	const start = element.startTime;
	const end = element.startTime + element.duration;
	const cutLen = range.end - range.start;

	// Entirely before the cut — untouched.
	if (end <= range.start) return [element];
	// Entirely after — shift left.
	if (start >= range.end) {
		return [{ ...element, startTime: start - cutLen } as TimelineElement];
	}
	// Entirely inside — removed.
	if (start >= range.start && end <= range.end) return [];

	const pieces: TimelineElement[] = [];
	// Left remainder.
	if (start < range.start) {
		pieces.push({
			...element,
			duration: range.start - start,
		} as TimelineElement);
	}
	// Right remainder: keeps source continuity via trimStart, lands at the cut point.
	if (end > range.end) {
		const consumedFromSource = range.end - start;
		pieces.push({
			...element,
			id: start < range.start ? generateUUID() : element.id,
			startTime: range.start,
			duration: end - range.end,
			trimStart: element.trimStart + consumedFromSource,
		} as TimelineElement);
	}
	return pieces;
}

function cutTrack<T extends TimelineTrack>({
	track,
	range,
}: {
	track: T;
	range: TimeRange;
}): T {
	return {
		...track,
		elements: track.elements.flatMap((element) =>
			cutElement({ element, range }),
		),
	};
}

/**
 * Removes time ranges from the timeline: content inside each range is deleted
 * (elements split where they straddle a boundary) and everything after slides
 * left. A range with no `trackId` cuts every track (the all-track extract that
 * powers Remove Silences / Remove Repeats / Autocut and gap ripple); a range
 * scoped to a `trackId` ripples only that track (ripple-deleting a selected
 * clip, which must never disturb footage on tracks the user didn't act on).
 */
export class RemoveRangesCommand extends Command {
	private savedState: SceneTracks | null = null;
	private removedCount = 0;

	constructor(private readonly options: { ranges: TimeRange[] }) {
		super();
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;

		// Sort descending so earlier ranges stay valid while we cut.
		const ranges = [...this.options.ranges]
			.filter((r) => r.end > r.start)
			.sort((a, b) => b.start - a.start);
		if (!ranges.length) return;

		let tracks = this.savedState;
		for (const range of ranges) {
			// A range scoped to one track ripples only that track; otherwise the
			// cut applies to every track (all-track extract).
			const apply = <T extends TimelineTrack>(track: T): T =>
				range.trackId && track.id !== range.trackId
					? track
					: cutTrack({ track, range });
			tracks = {
				...tracks,
				main: apply(tracks.main),
				overlay: tracks.overlay.map(apply),
				audio: tracks.audio.map(apply),
			};
			this.removedCount += 1;
		}

		editor.timeline.updateTracks(tracks);
		return undefined;
	}

	undo(): void {
		if (this.savedState) {
			const editor = EditorCore.getInstance();
			editor.timeline.updateTracks(this.savedState);
		}
	}

	getRemovedCount(): number {
		return this.removedCount;
	}
}
