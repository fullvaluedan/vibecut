import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { SceneTracks, TimelineTrack } from "@/timeline";
import { findTrackInSceneTracks } from "@/timeline/track-element-update";
import { computeRippleInsertShifts } from "@/timeline/placement/ripple-insert";
import type { MediaTime } from "@/wasm";

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

		const newStartById = new Map(shifts.map((shift) => [shift.id, shift.startTime]));
		const shiftTrack = <TTrack extends TimelineTrack>(candidate: TTrack): TTrack => {
			if (candidate.id !== this.trackId) return candidate;
			return {
				...candidate,
				elements: candidate.elements.map((element) => {
					const newStartTime = newStartById.get(element.id);
					return newStartTime === undefined
						? element
						: { ...element, startTime: newStartTime };
				}),
			};
		};

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
