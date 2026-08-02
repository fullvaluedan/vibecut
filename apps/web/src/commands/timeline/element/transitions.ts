import { EditorCore } from "@/core";
import { Command, type CommandResult } from "@/commands/base-command";
import type { SceneTracks } from "@/timeline";
import { updateElementInSceneTracks } from "@/timeline";
import {
	isTransitionCapableElement,
	type TransitionField,
	type TransitionSpec,
} from "@/timeline/transitions";

/**
 * T19.3: the ONE undoable command behind apply / change-duration / remove.
 *
 * It writes a single element field and then hands the tracks to
 * `TimelineManager.updateTracks`, whose reconciler applies the survive/die
 * rules - so an apply that is somehow invalid (wrong kind for the boundary,
 * duration past what the neighbours allow) is normalised inside the SAME undo
 * scope rather than landing as bad state.
 *
 * Removal is `spec: null`. Changing the duration is another set with the same
 * `id`, so the transition keeps its identity across edits.
 */
export class SetElementTransitionCommand extends Command {
	private savedState: SceneTracks | null = null;
	private readonly trackId: string;
	private readonly elementId: string;
	private readonly field: TransitionField;
	private readonly spec: TransitionSpec | null;

	constructor({
		trackId,
		elementId,
		field,
		spec,
	}: {
		trackId: string;
		elementId: string;
		field: TransitionField;
		spec: TransitionSpec | null;
	}) {
		super();
		this.trackId = trackId;
		this.elementId = elementId;
		this.field = field;
		this.spec = spec;
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;

		const field = this.field;
		const spec = this.spec;
		const updatedTracks = updateElementInSceneTracks({
			tracks: this.savedState,
			trackId: this.trackId,
			elementId: this.elementId,
			elementPredicate: isTransitionCapableElement,
			update: (element) => {
				if (!isTransitionCapableElement(element)) return element;
				if (spec) {
					return { ...element, [field]: spec };
				}
				const next = { ...element };
				delete next[field];
				return next;
			},
		});

		editor.timeline.updateTracks(updatedTracks);
		return undefined;
	}

	undo(): void {
		if (this.savedState) {
			EditorCore.getInstance().timeline.updateTracks(this.savedState);
		}
	}
}
