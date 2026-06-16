import {
	Command,
	createElementSelectionResult,
	type CommandResult,
} from "@/commands/base-command";
import { EditorCore } from "@/core";
import { SplitElementsCommand } from "@/commands/timeline/element/split-elements";
import { planClipDrop, type DropMode } from "@/timeline/overwrite/overwrite-plan";
import { buildMoveCarveInputs } from "@/timeline/overwrite/move-overwrite-plan";
import type {
	SceneTracks,
	TimelineElement,
	TimelineTrack,
} from "@/timeline";
import { addMediaTime, type MediaTime, mediaTime } from "@/wasm";

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

function findElement({
	tracks,
	elementId,
}: {
	tracks: SceneTracks;
	elementId: string;
}): TimelineElement | null {
	for (const track of [tracks.main, ...tracks.overlay, ...tracks.audio]) {
		const found = track.elements.find((element) => element.id === elementId);
		if (found) return found;
	}
	return null;
}

/**
 * Premiere-style overwrite/insert MOVE of a single existing clip onto an OCCUPIED
 * region of its target track (OQ7 edit model, U4). The move analogue of
 * `OverwriteDropCommand`: where the drop command introduces a brand-new element,
 * this RELOCATES an element already on the timeline, carving the region it lands on.
 *
 * One atomic command:
 *   1. Snapshot SceneTracks (undo restores this exactly).
 *   2. Carve geometry comes from the pure `planClipDrop`, fed the target track's
 *      clips MINUS the moved clip (via `buildMoveCarveInputs`) — the moved clip is
 *      the INCOMING element, never a carve victim, so it can never split, delete, or
 *      ripple itself.
 *   3. Split clips straddling the drop boundaries via `SplitElementsCommand` (the
 *      moved clip is excluded from the split set), then carve in one replacement —
 *      OVERWRITE deletes fragments inside `[A, B)`, INSERT ripples every OTHER clip
 *      from A rightward by the moved span.
 *   4. Remove the moved clip from its OLD position and place it, unchanged except
 *      for `startTime` (and track), into the carved hole at `[A, B)`. Trim, source
 *      window, retime, animations, masks, effects all ride along untouched — this is
 *      a move, not a trim.
 *
 * Conservative by construction: the controller only constructs this command when a
 * SINGLE clip lands on an EXISTING, type-compatible track with an ACTUAL overlap.
 * Non-overlapping moves never reach here — they take the ordinary move path.
 */
export class MoveOverwriteCommand extends Command {
	private savedState: SceneTracks | null = null;
	private readonly elementId: string;
	private readonly targetTrackId: string;
	private readonly newStartTime: MediaTime;
	private readonly mode: DropMode;

	constructor({
		elementId,
		targetTrackId,
		newStartTime,
		mode,
	}: {
		elementId: string;
		targetTrackId: string;
		newStartTime: MediaTime;
		mode: DropMode;
	}) {
		super();
		this.elementId = elementId;
		this.targetTrackId = targetTrackId;
		this.newStartTime = newStartTime;
		this.mode = mode;
	}

	getElementId(): string {
		return this.elementId;
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;

		const movedElement = findElement({
			tracks: this.savedState,
			elementId: this.elementId,
		});
		const targetTrack = findTrack({
			tracks: this.savedState,
			trackId: this.targetTrackId,
		});
		if (!movedElement || !targetTrack) return;

		const durationTicks = movedElement.duration as number;
		const inputs = buildMoveCarveInputs({
			targetTrackElements: targetTrack.elements.map((element) => ({
				id: element.id,
				startTime: element.startTime as number,
				duration: element.duration as number,
			})),
			movedElementId: this.elementId,
			newStart: this.newStartTime as number,
			newDuration: durationTicks,
		});

		const plan = planClipDrop({
			existingClips: inputs.existingClips,
			incomingStart: inputs.incomingStart,
			incomingEnd: inputs.incomingEnd,
			mode: this.mode,
		});

		// 1. Split straddling clips at the plan's boundaries. The MOVED clip is
		//    excluded from the split set so it is never cut by the carve (it is the
		//    incoming element). Re-read the live track refs before EACH split so a
		//    fragment created by an earlier split is eligible for the next boundary.
		for (const splitTime of plan.splitTimes) {
			const current = findTrack({
				tracks: editor.scenes.getActiveScene().tracks,
				trackId: this.targetTrackId,
			});
			if (!current) continue;
			new SplitElementsCommand({
				elements: current.elements
					.filter((element) => element.id !== this.elementId)
					.map((element) => ({
						trackId: this.targetTrackId,
						elementId: element.id,
					})),
				splitTime: mediaTime({ ticks: splitTime }),
				retainSide: "both",
			}).execute();
		}

		// 2. + 3. Carve the drop zone, relocate the moved clip into it, in one replace.
		const tracksAfterSplit = editor.scenes.getActiveScene().tracks;
		const delta = mediaTime({ ticks: durationTicks });
		const placedElement: TimelineElement = {
			...movedElement,
			startTime: this.newStartTime,
		};

		const transformTrack = <T extends TimelineTrack>(track: T): T => {
			// First, strip the moved clip from wherever it currently lives (its old
			// track), so it can never be double-counted as a victim or a duplicate.
			let elements: TimelineElement[] = track.elements.filter(
				(element) => element.id !== this.elementId,
			);

			if (track.id === this.targetTrackId) {
				if (plan.deleteRange) {
					const { start, end } = plan.deleteRange;
					elements = elements.filter(
						(element) =>
							!(
								(element.startTime as number) >= start &&
								(element.startTime as number) +
									(element.duration as number) <=
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
									startTime: addMediaTime({
										a: element.startTime,
										b: delta,
									}),
								}
							: element,
					);
				}

				const next = [...elements, placedElement].sort(
					(a, b) => (a.startTime as number) - (b.startTime as number),
				);
				// The moved element already matches this track's media type (it is only
				// routed here when type-compatible), so the widened array is sound.
				return { ...track, elements: next } as T;
			}

			return { ...track, elements } as T;
		};

		editor.timeline.updateTracks({
			main: transformTrack(tracksAfterSplit.main),
			overlay: tracksAfterSplit.overlay.map(transformTrack),
			audio: tracksAfterSplit.audio.map(transformTrack),
		});

		return createElementSelectionResult([
			{ trackId: this.targetTrackId, elementId: this.elementId },
		]);
	}

	undo(): void {
		if (this.savedState) {
			EditorCore.getInstance().timeline.updateTracks(this.savedState);
		}
	}
}
