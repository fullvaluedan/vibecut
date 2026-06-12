import { Command, type CommandResult } from "@/commands/base-command";
import type { SceneTracks } from "@/timeline";
import { EditorCore } from "@/core";

/**
 * Premiere-style track reordering: moves a track one slot up or down
 * within its own section (overlay or audio). The main track is fixed.
 */
export class MoveTrackCommand extends Command {
	private savedState: SceneTracks | null = null;

	constructor(
		private args: { trackId: string; direction: "up" | "down" },
	) {
		super();
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		const tracks = editor.scenes.getActiveScene().tracks;
		this.savedState = tracks;

		const moveWithin = <T extends { id: string }>(
			list: T[],
			towardStart: boolean,
		): T[] | null => {
			const index = list.findIndex((t) => t.id === this.args.trackId);
			if (index < 0) return null;
			const target = towardStart ? index - 1 : index + 1;
			if (target < 0 || target >= list.length) return list;
			const next = [...list];
			[next[index], next[target]] = [next[target], next[index]];
			return next;
		};

		// Overlay tracks render top-down: "up" = toward the start of the array.
		const overlay = moveWithin(tracks.overlay, this.args.direction === "up");
		if (overlay) {
			editor.timeline.updateTracks({ ...tracks, overlay });
			return undefined;
		}
		// Audio tracks render below main: "up" = toward the start as well.
		const audio = moveWithin(tracks.audio, this.args.direction === "up");
		if (audio) {
			editor.timeline.updateTracks({ ...tracks, audio });
		}
		return undefined;
	}

	undo(): void {
		if (this.savedState) {
			EditorCore.getInstance().timeline.updateTracks(this.savedState);
		}
	}
}
