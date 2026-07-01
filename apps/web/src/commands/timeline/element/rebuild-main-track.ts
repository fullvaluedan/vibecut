import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { SceneTracks, VideoElement } from "@/timeline";
import {
	buildDefaultParamValues,
	getBuiltInElementParams,
} from "@/params/registry";
import { generateUUID } from "@/utils/id";
import { mediaTime } from "@/wasm";
import type { MainTrackElementSpec } from "@/features/ai-generate/director/assembly-placement";

/**
 * Replace the main track's elements with a fresh ordered set of video clips (the
 * AI-assembled rough cut). Snapshots the scene tracks and swaps only the main
 * track's `elements`, so it is self-consistent to RE-EXECUTE on every draft edit
 * (drop / re-include / swap-take) during review and reverts in ONE undo. Overlay
 * and audio tracks are untouched.
 */
export class RebuildMainTrackCommand extends Command {
	private savedState: SceneTracks | null = null;
	private readonly specs: readonly MainTrackElementSpec[];

	constructor({ specs }: { specs: readonly MainTrackElementSpec[] }) {
		super();
		this.specs = specs;
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;

		const elements: VideoElement[] = this.specs.map((spec) => ({
			id: generateUUID(),
			type: "video",
			mediaId: spec.mediaId,
			name: spec.name,
			startTime: mediaTime({ ticks: spec.startTimeTicks }),
			duration: mediaTime({ ticks: spec.durationTicks }),
			trimStart: mediaTime({ ticks: spec.trimStartTicks }),
			trimEnd: mediaTime({ ticks: spec.trimEndTicks }),
			sourceDuration: mediaTime({ ticks: spec.sourceDurationTicks }),
			isSourceAudioEnabled: spec.isSourceAudioEnabled,
			hidden: false,
			params: buildDefaultParamValues(getBuiltInElementParams({ type: "video" })),
		}));

		const updatedTracks: SceneTracks = {
			...this.savedState,
			main: { ...this.savedState.main, elements },
		};
		editor.timeline.updateTracks(updatedTracks);
		// Re-minting every main clip orphans any prior main-track selection.
		// updateTracks already pruned it live; declaring the reconciled selection
		// as an override satisfies the documented invariant (commands that remove
		// editor-owned selection targets must declare one) so undo restores the
		// pre-rebuild selection cleanly.
		return { selection: editor.selection.getSnapshot() };
	}

	undo(): void {
		if (this.savedState) {
			EditorCore.getInstance().timeline.updateTracks(this.savedState);
		}
	}
}
