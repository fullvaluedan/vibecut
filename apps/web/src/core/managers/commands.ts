import type { EditorCore } from "@/core";
import type { Command, CommandResult } from "@/commands";
import type { EditorSelectionSnapshot } from "@/selection/editor-selection";
import { applyRippleAdjustments, computeRippleAdjustments } from "@/ripple";
import type { SceneTracks } from "@/timeline/types";

interface CommandHistoryEntry {
	command: Command;
	previousSelection: EditorSelectionSnapshot;
	selectionOverride?: EditorSelectionSnapshot;
}

/**
 * Cap undo depth. Each entry can retain cloned timeline state (e.g.
 * TracksSnapshotCommand), so an unbounded history grows memory across a long
 * editing session — surfacing as GC-driven playback stutter that a reload
 * clears. 200 steps is well beyond normal reach-back.
 */
const MAX_HISTORY = 200;

export class CommandManager {
	public isRippleEnabled = false;
	private history: CommandHistoryEntry[] = [];
	private redoStack: CommandHistoryEntry[] = [];
	private reactors: Array<() => void> = [];

	constructor(private editor: EditorCore) {}

	execute({ command }: { command: Command }): Command {
		const beforeTracks = this.isRippleEnabled
			? (this.editor.scenes.getActiveSceneOrNull()?.tracks ?? null)
			: null;
		const previousSelection = this.getSelectionSnapshot();
		const result = command.execute();
		this.applyRippleIfEnabled({ beforeTracks });
		const selectionOverride = this.applySelectionOverride(result);
		this.runReactors();
		this.pushHistory({
			command,
			previousSelection,
			selectionOverride,
		});
		this.redoStack = [];
		return command;
	}

	push({ command }: { command: Command }): void {
		this.pushHistory({
			command,
			previousSelection: this.getSelectionSnapshot(),
		});
		this.redoStack = [];
	}

	registerReactor(reactor: () => void): void {
		this.reactors.push(reactor);
	}

	undo(): void {
		if (this.history.length === 0) return;
		const entry = this.history.pop();
		entry?.command.undo();
		if (entry) {
			// Only restore selection for commands that explicitly changed it.
			// Commands without selection intent leave selection untouched,
			// preserving any UI-driven selection changes (clicks, box select)
			// that happened between commands. Commands that remove editor-owned
			// selection targets must declare a selection override to clear stale refs.
			if (entry.selectionOverride !== undefined) {
				this.editor.selection.restoreSnapshot({
					snapshot: entry.previousSelection,
				});
			}
			this.redoStack.push(entry);
		}
	}

	redo(): void {
		if (this.redoStack.length === 0) return;
		const entry = this.redoStack.pop();
		if (!entry) {
			return;
		}

		const beforeTracks = this.isRippleEnabled
			? (this.editor.scenes.getActiveSceneOrNull()?.tracks ?? null)
			: null;
		const previousSelection = this.getSelectionSnapshot();
		const result = entry.command.redo();
		this.applyRippleIfEnabled({ beforeTracks });
		const selectionOverride = this.applySelectionOverride(result);
		this.runReactors();

		this.pushHistory({
			command: entry.command,
			previousSelection,
			selectionOverride,
		});
	}

	canUndo(): boolean {
		return this.history.length > 0;
	}

	canRedo(): boolean {
		return this.redoStack.length > 0;
	}

	/** The command a call to `undo()` would act on (top of the undo stack), or null.
	 * Read-only peek: the revisable-apply flow (U8 fix) checks its captured Director
	 * batch is still the stack top before undoing, so a manual Ctrl+Z or an external
	 * edit that moved it can never make it undo the wrong command. */
	peekUndoCommand(): Command | null {
		return this.history.length > 0
			? this.history[this.history.length - 1].command
			: null;
	}

	/** The command a call to `redo()` would act on (top of the redo stack), or null.
	 * Same read-only peek as `peekUndoCommand`, for the A/B "without" state where the
	 * captured batch has been temporarily undone onto the redo stack. */
	peekRedoCommand(): Command | null {
		return this.redoStack.length > 0
			? this.redoStack[this.redoStack.length - 1].command
			: null;
	}

	clear(): void {
		this.history = [];
		this.redoStack = [];
	}

	private pushHistory(entry: CommandHistoryEntry): void {
		this.history.push(entry);
		if (this.history.length > MAX_HISTORY) {
			// Drop the oldest steps — they become non-undoable, which bounds the
			// retained command/undo state so a long session can't leak unbounded.
			this.history.splice(0, this.history.length - MAX_HISTORY);
		}
	}

	private getSelectionSnapshot(): EditorSelectionSnapshot {
		return this.editor.selection.getSnapshot();
	}

	private applySelectionOverride(
		result: CommandResult | undefined,
	): EditorSelectionSnapshot | undefined {
		if (!result?.selection) {
			return undefined;
		}
		return this.editor.selection.applySelectionPatch({
			patch: result.selection,
		});
	}

	private runReactors(): void {
		for (const reactor of this.reactors) {
			reactor();
		}
	}

	private applyRippleIfEnabled({
		beforeTracks,
	}: {
		beforeTracks: SceneTracks | null;
	}): void {
		if (!this.isRippleEnabled || !beforeTracks) {
			return;
		}

		const afterTracks = this.editor.scenes.getActiveSceneOrNull()?.tracks;
		if (!afterTracks) {
			return;
		}
		const adjustments = computeRippleAdjustments({
			beforeTracks,
			afterTracks,
		});
		if (adjustments.length === 0) {
			return;
		}

		const tracksWithRipple = applyRippleAdjustments({
			tracks: afterTracks,
			adjustments,
		});
		this.editor.timeline.updateTracks(tracksWithRipple);
	}
}
