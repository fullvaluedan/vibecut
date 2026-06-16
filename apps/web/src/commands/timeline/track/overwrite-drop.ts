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

/**
 * Premiere-style overwrite/insert drop of a single clip onto an occupied region
 * of an existing track (OQ7 edit model). A single atomic command:
 *
 *   1. Splits clips straddling the drop boundaries via `SplitElementsCommand`,
 *      which keeps each fragment's source window / retime / animations correct.
 *   2. Carves the drop zone in one state replacement — OVERWRITE deletes the
 *      fragments inside `[A, B)` (leaving a hole); INSERT ripples every clip from
 *      A rightward by the incoming span (opening the gap, deleting nothing).
 *   3. Drops the incoming clip into the opened zone at `[A, B)`.
 *
 * The geometry comes from the pure, exhaustively-tested `planClipDrop`; this
 * command only applies it to real elements. Undo restores the pre-drop snapshot
 * in one step. Inserting via a direct track transform (rather than
 * InsertElementCommand) guarantees the clip lands exactly in the carved hole,
 * bypassing the normal overlap-avoidance placement.
 */
export class OverwriteDropCommand extends Command {
	private savedState: SceneTracks | null = null;
	private readonly elementId = generateUUID();
	private readonly trackId: string;
	private readonly incoming: CreateTimelineElement;
	private readonly mode: DropMode;

	constructor({
		trackId,
		incoming,
		mode,
	}: {
		trackId: string;
		incoming: CreateTimelineElement;
		mode: DropMode;
	}) {
		super();
		this.trackId = trackId;
		this.incoming = incoming;
		this.mode = mode;
	}

	getElementId(): string {
		return this.elementId;
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;

		const startTicks = this.incoming.startTime as number;
		const durationTicks = (this.incoming.duration ??
			DEFAULT_NEW_ELEMENT_DURATION) as number;
		const endTicks = startTicks + durationTicks;

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
			incomingStart: startTicks,
			incomingEnd: endTicks,
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

		// 2. + 3. Carve the drop zone and drop the incoming clip, in one replace.
		const tracksAfterSplit = editor.scenes.getActiveScene().tracks;
		const incomingElement = this.buildIncoming();
		const delta = mediaTime({ ticks: durationTicks });

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

			const next = [...elements, incomingElement].sort(
				(a, b) => (a.startTime as number) - (b.startTime as number),
			);
			// The incoming element matches the target track's media type (gated by
			// canElementGoOnTrack at the drop site); the widened array is sound here.
			return { ...track, elements: next } as T;
		};

		editor.timeline.updateTracks({
			main: carveTrack(tracksAfterSplit.main),
			overlay: tracksAfterSplit.overlay.map(carveTrack),
			audio: tracksAfterSplit.audio.map(carveTrack),
		});

		return createElementSelectionResult([
			{ trackId: this.trackId, elementId: this.elementId },
		]);
	}

	undo(): void {
		if (this.savedState) {
			EditorCore.getInstance().timeline.updateTracks(this.savedState);
		}
	}

	private buildIncoming(): TimelineElement {
		return {
			...this.incoming,
			id: this.elementId,
			startTime: this.incoming.startTime,
			trimStart: this.incoming.trimStart ?? ZERO_MEDIA_TIME,
			trimEnd: this.incoming.trimEnd ?? ZERO_MEDIA_TIME,
			duration: this.incoming.duration ?? DEFAULT_NEW_ELEMENT_DURATION,
		} as TimelineElement;
	}
}
