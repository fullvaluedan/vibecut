import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { SceneTracks, TimelineTrack } from "@/timeline";
import type { RippleTrimShift } from "@/timeline/ripple-trim";

/**
 * Apply precomputed cross-track ripple shifts (see `timeline/ripple-trim.ts`)
 * as one undoable step. Writes the shifted starts DIRECTLY (updateTracks, no
 * update-pipeline): a system shift is not a user placement, so it must not
 * re-trigger the main-track head-gravity rule and snap a downstream clip to 0
 * (mirrors how `applyRippleAdjustments` writes its shifts). Runs inside the
 * same BatchCommand as the trim's UpdateElementsCommand, so one undo reverts
 * the whole ripple trim.
 *
 * FrameCut-owned command (new file, not upstream).
 */
export class RippleShiftElementsCommand extends Command {
	private savedState: SceneTracks | null = null;
	private readonly shifts: RippleTrimShift[];

	constructor({ shifts }: { shifts: RippleTrimShift[] }) {
		super();
		this.shifts = shifts;
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;
		if (this.shifts.length === 0) {
			return undefined;
		}

		const newStartById = new Map(
			this.shifts.map((shift) => [shift.elementId, shift.newStartTime]),
		);
		const shiftTrack = <TTrack extends TimelineTrack>(
			track: TTrack,
		): TTrack => ({
			...track,
			elements: track.elements.map((element) => {
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
