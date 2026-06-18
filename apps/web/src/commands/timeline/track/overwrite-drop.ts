import {
	Command,
	createElementSelectionResult,
	type CommandResult,
} from "@/commands/base-command";
import { EditorCore } from "@/core";
import { SplitElementsCommand } from "@/commands/timeline/element/split-elements";
import {
	planClipDrop,
	type DropMode,
} from "@/timeline/overwrite/overwrite-plan";
import { buildMultiDropSpan } from "@/timeline/overwrite/multi-drop-span";
import { DEFAULT_NEW_ELEMENT_DURATION } from "@/timeline/creation";
import type {
	CreateTimelineElement,
	SceneTracks,
	TimelineElement,
	TimelineTrack,
} from "@/timeline";
import { generateUUID } from "@/utils/id";
import { addMediaTime, mediaTime, ZERO_MEDIA_TIME } from "@/wasm";

function findTrack({
	tracks,
	trackId,
}: {
	tracks: SceneTracks;
	trackId: string;
}): TimelineTrack | null {
	if (tracks.main.id === trackId) return tracks.main;
	return (
		tracks.overlay.find((track) => track.id === trackId) ??
		tracks.audio.find((track) => track.id === trackId) ??
		null
	);
}

function durationTicks(element: CreateTimelineElement): number {
	return (element.duration ?? DEFAULT_NEW_ELEMENT_DURATION) as number;
}

/**
 * Premiere-style overwrite/insert drop of ONE OR MORE clips onto an occupied region
 * of an existing track (OQ7 edit model). A single atomic command:
 *
 *   1. Computes the COMBINED back-to-back span of the incoming clips
 *      `[A, A + sum(durations))` (a single clip is the N=1 case) and splits clips
 *      straddling its boundaries via `SplitElementsCommand`, which keeps each
 *      fragment's source window / retime / animations correct.
 *   2. Carves the drop zone in one state replacement — OVERWRITE deletes the
 *      fragments inside the combined span (leaving a hole); INSERT ripples every clip
 *      from A rightward by the combined span (opening the gap, deleting nothing).
 *   3. Drops the incoming clips into the opened zone, laid out back-to-back from A in
 *      the order supplied (U5: multi-selection drops place the whole set in one carve).
 *
 * The geometry comes from the pure, exhaustively-tested `planClipDrop` (fed the
 * combined span via `buildMultiDropSpan`); this command only applies it to real
 * elements. Undo restores the pre-drop snapshot in one step. Inserting via a direct
 * track transform (rather than InsertElementCommand) guarantees each clip lands
 * exactly in the carved hole, bypassing the normal overlap-avoidance placement.
 */
export class OverwriteDropCommand extends Command {
	private savedState: SceneTracks | null = null;
	private readonly trackId: string;
	/** Incoming clips in placement order; a single drop is a one-element array. */
	private readonly incoming: CreateTimelineElement[];
	/** One fresh id per incoming clip, index-aligned with `incoming`. */
	private readonly elementIds: string[];
	private readonly mode: DropMode;

	constructor({
		trackId,
		incoming,
		mode,
	}: {
		trackId: string;
		/** A single clip, or an ordered multi-selection placed back-to-back. */
		incoming: CreateTimelineElement | CreateTimelineElement[];
		mode: DropMode;
	}) {
		super();
		this.trackId = trackId;
		this.incoming = Array.isArray(incoming) ? incoming : [incoming];
		this.elementIds = this.incoming.map(() => generateUUID());
		this.mode = mode;
	}

	/** The first incoming clip's id — the single-clip case's stable id. */
	getElementId(): string {
		return this.elementIds[0];
	}

	/** All incoming clip ids, index-aligned with the supplied order. */
	getElementIds(): string[] {
		return [...this.elementIds];
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;

		if (this.incoming.length === 0) return;

		const startTicks = this.incoming[0].startTime as number;
		// Combined back-to-back span: a single clip is the N=1 case (end == its end).
		const span = buildMultiDropSpan({
			clips: this.incoming.map((element) => ({
				duration: durationTicks(element),
			})),
			start: startTicks,
		});

		const targetTrack = findTrack({
			tracks: this.savedState,
			trackId: this.trackId,
		});
		if (!targetTrack) return;

		const plan = planClipDrop({
			existingClips: targetTrack.elements.map((element) => ({
				startTime: element.startTime as number,
				duration: element.duration as number,
			})),
			incomingStart: span.start,
			incomingEnd: span.end,
			mode: this.mode,
		});

		// 1. Split straddling clips at the plan's boundaries. Pass the live track
		//    refs before EACH split so a clip created by an earlier split (e.g. the
		//    right half of an enclosing clip) is eligible for the next boundary.
		for (const splitTime of plan.splitTimes) {
			const current = findTrack({
				tracks: editor.scenes.getActiveScene().tracks,
				trackId: this.trackId,
			});
			if (!current) continue;
			new SplitElementsCommand({
				elements: current.elements.map((element) => ({
					trackId: this.trackId,
					elementId: element.id,
				})),
				splitTime: mediaTime({ ticks: splitTime }),
				retainSide: "both",
			}).execute();
		}

		// 2. + 3. Carve the drop zone and drop the incoming clips, in one replace.
		const tracksAfterSplit = editor.scenes.getActiveScene().tracks;
		const incomingElements = this.buildIncoming({ offsets: span.offsets });
		// Ripple opens a gap the size of the WHOLE combined span (overwrite never
		// ripples; the delta is only consumed on insert).
		const delta = mediaTime({ ticks: span.end - span.start });

		const carveTrack = <T extends TimelineTrack>(track: T): T => {
			if (track.id !== this.trackId) return track;

			let elements: TimelineElement[] = track.elements;
			if (plan.deleteRange) {
				const { start, end } = plan.deleteRange;
				elements = elements.filter(
					(element) =>
						!(
							(element.startTime as number) >= start &&
							(element.startTime as number) + (element.duration as number) <=
								end
						),
				);
			}
			if (plan.rippleShift) {
				const { fromTime } = plan.rippleShift;
				elements = elements.map((element) =>
					(element.startTime as number) >= fromTime
						? {
								...element,
								startTime: addMediaTime({ a: element.startTime, b: delta }),
							}
						: element,
				);
			}

			const next = [...elements, ...incomingElements].sort(
				(a, b) => (a.startTime as number) - (b.startTime as number),
			);
			// Each incoming element matches the target track's media type (gated by
			// canElementGoOnTrack at the drop site); the widened array is sound here.
			return { ...track, elements: next } as T;
		};

		editor.timeline.updateTracks({
			main: carveTrack(tracksAfterSplit.main),
			overlay: tracksAfterSplit.overlay.map(carveTrack),
			audio: tracksAfterSplit.audio.map(carveTrack),
		});

		return createElementSelectionResult(
			this.elementIds.map((elementId) => ({
				trackId: this.trackId,
				elementId,
			})),
		);
	}

	undo(): void {
		if (this.savedState) {
			EditorCore.getInstance().timeline.updateTracks(this.savedState);
		}
	}

	/**
	 * Materialize the incoming clips at their back-to-back offsets. Each gets a fresh
	 * id and its absolute `startTime` from the combined span; trims default to zero.
	 */
	private buildIncoming({
		offsets,
	}: {
		offsets: number[];
	}): TimelineElement[] {
		return this.incoming.map((element, index) => {
			return {
				...element,
				id: this.elementIds[index],
				startTime: mediaTime({ ticks: offsets[index] }),
				trimStart: element.trimStart ?? ZERO_MEDIA_TIME,
				trimEnd: element.trimEnd ?? ZERO_MEDIA_TIME,
				duration: element.duration ?? DEFAULT_NEW_ELEMENT_DURATION,
			} as TimelineElement;
		});
	}
}
