import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { SceneTracks, TimelineElement, TimelineTrack } from "@/timeline";
import { findLinkedPartners } from "@/timeline/link-elements";
import { findTrackInSceneTracks } from "@/timeline/track-element-update";
import { computeRippleInsertShifts } from "@/timeline/placement/ripple-insert";
import { addMediaTime, type MediaTime } from "@/wasm";

function allTracks(tracks: SceneTracks): TimelineTrack[] {
	return [tracks.main, ...tracks.overlay, ...tracks.audio];
}

function findElementById(
	tracks: SceneTracks,
	elementId: string,
): TimelineElement | null {
	for (const track of allTracks(tracks)) {
		const element = track.elements.find((candidate) => candidate.id === elementId);
		if (element) return element;
	}
	return null;
}

/**
 * T18.1 freeze frame: shift every element on ONE track whose `startTime` is
 * at or after `atTime` right by `shiftDuration`, opening a gap-free hole.
 * Reads the track fresh at execute() time (not a precomputed id list like
 * `RippleShiftElementsCommand`), which is what lets it run in a BatchCommand
 * right after a `SplitElementsCommand` on the SAME track: the split's
 * right-side half gets a brand-new id that doesn't exist yet when the batch
 * is built, but by the time THIS command's execute() runs (later in the same
 * batch), that half is already on the track and gets picked up like any
 * other element whose start is `>= atTime`. Mirrors the ripple-insert-on-drop
 * flow in drag-drop-controller.ts, minus the straddle-split case (the caller
 * already split via SplitElementsCommand).
 *
 * G6 fix (round 18 reopen): freeze frame was rippling ONLY this track, so a
 * clip's separated linked audio (own track, own `linkId`) never moved and
 * desynced from the still it now plays under. Every shifted element's LINKED
 * partners - wherever they live - now shift by the SAME delta, matching the
 * rule the magnet gap-close/trim paths already use for linked propagation
 * (see `timeline/magnet.ts` `collectMagnetTrimTargets` and `buildGapShifts`:
 * shift the primary scope, then follow each shifted element's `linkId`
 * partners onto their own tracks). An element with no linked partner - an
 * overlay title, an unlinked music bed - is untouched even when its own
 * `startTime` is `>= atTime`, because it is never reached by that walk
 * unless it lives on THIS track.
 */
export class RippleShiftAtCommand extends Command {
	private savedState: SceneTracks | null = null;
	private readonly trackId: string;
	private readonly atTime: MediaTime;
	private readonly shiftDuration: MediaTime;

	constructor({
		trackId,
		atTime,
		shiftDuration,
	}: {
		trackId: string;
		atTime: MediaTime;
		shiftDuration: MediaTime;
	}) {
		super();
		this.trackId = trackId;
		this.atTime = atTime;
		this.shiftDuration = shiftDuration;
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;

		const track = findTrackInSceneTracks({
			tracks: this.savedState,
			trackId: this.trackId,
		});
		if (!track) {
			return undefined;
		}

		const shifts = computeRippleInsertShifts({
			elements: track.elements,
			insertStart: this.atTime,
			shiftDuration: this.shiftDuration,
		});
		if (shifts.length === 0) {
			return undefined;
		}

		const newStartById = new Map<string, MediaTime>(
			shifts.map((shift) => [shift.id, shift.startTime]),
		);
		const claimed = new Set<string>(shifts.map((shift) => shift.id));

		for (const shift of shifts) {
			for (const partner of findLinkedPartners({
				ref: { trackId: this.trackId, elementId: shift.id },
				tracks: this.savedState,
				mode: "timeline",
			})) {
				if (claimed.has(partner.elementId)) continue;
				const partnerElement = findElementById(this.savedState, partner.elementId);
				if (!partnerElement) continue;
				claimed.add(partner.elementId);
				newStartById.set(
					partner.elementId,
					addMediaTime({ a: partnerElement.startTime, b: this.shiftDuration }),
				);
			}
		}

		const shiftTrack = <TTrack extends TimelineTrack>(candidate: TTrack): TTrack => ({
			...candidate,
			elements: candidate.elements.map((element) => {
				const newStartTime = newStartById.get(element.id);
				return newStartTime === undefined
					? element
					: { ...element, startTime: newStartTime };
			}),
		});

		editor.timeline.updateTracks({
			overlay: this.savedState.overlay.map((track) => shiftTrack(track)),
			main: shiftTrack(this.savedState.main),
			audio: this.savedState.audio.map((track) => shiftTrack(track)),
		});
		return undefined;
	}

	undo(): void {
		if (this.savedState) {
			EditorCore.getInstance().timeline.updateTracks(this.savedState);
		}
	}
}
