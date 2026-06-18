import { EditorCore } from "@/core";
import { Command, type CommandResult } from "@/commands/base-command";
import type { ElementRef, SceneTracks } from "@/timeline";
import { unlinkElementsInSceneTracks } from "@/timeline/unlink-elements";

/**
 * Unlinks the link group(s) the given refs belong to by clearing `linkId` on
 * every member, then applying via `updateTracks` (there is no clear-field API).
 * Undoable: restores the pre-unlink tracks snapshot.
 */
export class UnlinkElementsCommand extends Command {
	private savedState: SceneTracks | null = null;
	private readonly refs: ElementRef[];

	constructor({ refs }: { refs: ElementRef[] }) {
		super();
		this.refs = refs;
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;
		const { tracks } = unlinkElementsInSceneTracks({
			tracks: this.savedState,
			refs: this.refs,
		});
		editor.timeline.updateTracks(tracks);
		return undefined;
	}

	undo(): void {
		if (this.savedState) {
			EditorCore.getInstance().timeline.updateTracks(this.savedState);
		}
	}
}
