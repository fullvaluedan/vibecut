import { EditorCore } from "@/core";
import { Command, type CommandResult } from "@/commands/base-command";
import { updateElementInSceneTracks } from "@/timeline/track-element-update";
import type { SceneTracks } from "@/timeline/types";

/**
 * Strip a shared `linkId` from every element that carries it (a video and its
 * separated-audio partner), so they can be selected, trimmed, and moved
 * INDEPENDENTLY — while keeping both clips on the timeline. Undo restores the
 * link. Distinct from ToggleSourceAudioSeparation's "Recover audio", which
 * re-enables the video's source audio and leaves the link in place.
 */
export class UnlinkElementsCommand extends Command {
	private savedState: SceneTracks | null = null;

	constructor(private readonly params: { linkId: string }) {
		super();
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;

		const refs: { trackId: string; elementId: string }[] = [];
		for (const track of [
			this.savedState.main,
			...this.savedState.overlay,
			...this.savedState.audio,
		]) {
			for (const element of track.elements) {
				if (element.linkId === this.params.linkId) {
					refs.push({ trackId: track.id, elementId: element.id });
				}
			}
		}
		if (refs.length === 0) {
			return;
		}

		let tracks: SceneTracks = this.savedState;
		for (const ref of refs) {
			tracks = updateElementInSceneTracks({
				tracks,
				trackId: ref.trackId,
				elementId: ref.elementId,
				update: (element) => ({ ...element, linkId: undefined }),
			});
		}
		editor.timeline.updateTracks(tracks);
	}

	undo(): void {
		if (!this.savedState) {
			return;
		}
		EditorCore.getInstance().timeline.updateTracks(this.savedState);
	}
}
