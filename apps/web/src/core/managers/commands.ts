import type { EditorCore } from "@/core";
import type { Command, CommandResult } from "@/commands";
import type { EditorSelectionSnapshot } from "@/selection/editor-selection";
import { applyRippleAdjustments, computeRippleAdjustments } from "@/ripple";
import { applyMagnetShifts, computeMagnetGapShifts } from "@/timeline/magnet";
import { Command as BaseCommand } from "@/commands/base-command";
import type { SceneTracks } from "@/timeline/types";

/**
 * The magnetic main track's gap close, as an undoable step bound to the SAME
 * editor instance the manager drives (never the singleton), so it can ride on
 * its command's history entry. Writes tracks directly: the shift positions are
 * already resolved, and routing them through the update pipeline would let
 * head gravity re-place them.
 */
class MagnetGapCloseCommand extends BaseCommand {
	constructor(
		private readonly deps: {
			editor: EditorCore;
			before: SceneTracks;
			after: SceneTracks;
		},
	) {
		super();
	}

	execute(): CommandResult | undefined {
		this.deps.editor.timeline.updateTracks(this.deps.after);
		return undefined;
	}

	undo(): void {
		this.deps.editor.timeline.updateTracks(this.deps.before);
	}
}

interface CommandHistoryEntry {
	command: Command;
	previousSelection: EditorSelectionSnapshot;
	selectionOverride?: EditorSelectionSnapshot;
	/** See `execute`; carried on the entry so redo honors it too. */
	suppressRipple?: boolean;
	/**
	 * The magnetic-main-track gap close this command triggered, if any. It is
	 * NOT a separate history entry: it runs and unwinds with its command, so a
	 * single undo puts both the edit and the magnet's shift back (see
	 * `applyMagnetIfEnabled`). Kept off `command` itself so `peekUndoCommand`
	 * still returns the caller's own command identity.
	 */
	magnetCommand?: Command;
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
	/**
	 * Magnetic main track (CapCut), Dan's 2026-08-01 default-ON decision. Wired
	 * from the timeline store in `editor-provider.tsx`. PRECEDENCE: ripple
	 * editing is the cross-track superset, so whenever `isRippleEnabled` is also
	 * true the ripple path runs and the magnet path is skipped entirely - that
	 * single rule is what guarantees nothing is ever shifted twice.
	 */
	public isMagnetEnabled = false;
	private history: CommandHistoryEntry[] = [];
	private redoStack: CommandHistoryEntry[] = [];
	private reactors: Array<() => void> = [];
	/**
	 * Total entries ever dropped from the FRONT of `history` by the MAX_HISTORY
	 * cap below. `getMark`/`rollbackTo` use an absolute, ever-increasing
	 * sequence number (`trimmedCount + history.length`) instead of a raw array
	 * index, so a mark taken before a long run stays meaningful even if the cap
	 * trims the array in between. A raw index would silently go stale and
	 * `rollbackTo` could under-undo (or no-op) without any signal that it had.
	 */
	private trimmedCount = 0;

	constructor(private editor: EditorCore) {}

	/**
	 * `suppressRipple`: skip the post-execute ripple diff heuristic for THIS
	 * command (and its redo). A command that already contains its own explicit
	 * downstream shifts (the cross-track ripple-trim BatchCommand) must opt out,
	 * or the heuristic re-shifts gapped clips a second time. Deletes and every
	 * other command keep the heuristic.
	 */
	execute({
		command,
		suppressRipple = false,
	}: {
		command: Command;
		suppressRipple?: boolean;
	}): Command {
		const beforeTracks =
			(this.isRippleEnabled || this.isMagnetEnabled) && !suppressRipple
				? (this.editor.scenes.getActiveSceneOrNull()?.tracks ?? null)
				: null;
		const previousSelection = this.getSelectionSnapshot();
		const result = command.execute();
		this.applyRippleIfEnabled({ beforeTracks });
		const magnetCommand = this.applyMagnetIfEnabled({ beforeTracks });
		const selectionOverride = this.applySelectionOverride(result);
		this.runReactors();
		this.pushHistory({
			command,
			previousSelection,
			selectionOverride,
			...(suppressRipple ? { suppressRipple } : {}),
			...(magnetCommand ? { magnetCommand } : {}),
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
		// The magnet's gap close ran AFTER the command, so it unwinds first.
		entry?.magnetCommand?.undo();
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

		const beforeTracks =
			this.isRippleEnabled && !entry.suppressRipple
				? (this.editor.scenes.getActiveSceneOrNull()?.tracks ?? null)
				: null;
		const previousSelection = this.getSelectionSnapshot();
		const result = entry.command.redo();
		this.applyRippleIfEnabled({ beforeTracks });
		// Replay the SAME magnet shift the original execute produced (its target
		// positions are absolute), rather than re-deriving one: redoing must land
		// exactly where the user last saw the timeline.
		entry.magnetCommand?.redo();
		const selectionOverride = this.applySelectionOverride(result);
		this.runReactors();

		this.pushHistory({
			command: entry.command,
			previousSelection,
			selectionOverride,
			...(entry.suppressRipple ? { suppressRipple: entry.suppressRipple } : {}),
			...(entry.magnetCommand ? { magnetCommand: entry.magnetCommand } : {}),
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
		this.trimmedCount = 0;
	}

	/**
	 * A snapshot of the current undo-stack height (Director-cancel U8 fix), as an
	 * absolute sequence number immune to MAX_HISTORY trimming (see
	 * `trimmedCount`). Pass it to `rollbackTo` later to undo everything pushed
	 * since, and only that.
	 */
	getMark(): number {
		return this.trimmedCount + this.history.length;
	}

	/**
	 * Undo every command pushed after `mark`, in reverse order, and DISCARD them
	 * (unlike `undo()`, none of them go on the redo stack). For a multi-step
	 * operation that mutates the timeline before the user gets a chance to
	 * decide whether to keep it (e.g. the Director's pre-review assemble/reorder
	 * pre-pass): if the user cancels, this restores EXACTLY the pre-mark state in
	 * one call and leaves no trace in the history, matching a "cancel means
	 * nothing happened" model. A no-op once nothing was pushed since the mark
	 * (the common case when the user cancels before any mutation happened at
	 * all). If MAX_HISTORY trimmed away entries between the mark and now, this
	 * rolls back everything still available rather than going stale (see
	 * `trimmedCount`). Those specific trimmed entries are gone regardless, the
	 * cap's existing memory-bounding tradeoff, not something this method changes.
	 */
	rollbackTo(mark: number): void {
		const target = Math.max(0, mark - this.trimmedCount);
		while (this.history.length > target) {
			const entry = this.history.pop();
			if (!entry) break;
			entry.magnetCommand?.undo();
			entry.command.undo();
			if (entry.selectionOverride !== undefined) {
				this.editor.selection.restoreSnapshot({
					snapshot: entry.previousSelection,
				});
			}
		}
	}

	private pushHistory(entry: CommandHistoryEntry): void {
		this.history.push(entry);
		if (this.history.length > MAX_HISTORY) {
			// Drop the oldest steps — they become non-undoable, which bounds the
			// retained command/undo state so a long session can't leak unbounded.
			const overflow = this.history.length - MAX_HISTORY;
			this.history.splice(0, overflow);
			this.trimmedCount += overflow;
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

	/**
	 * Magnetic main track: after a command has run, close the space it freed on
	 * the MAIN track and slide the survivors (plus their linked audio) left. The
	 * shift is executed as a `RippleShiftElementsCommand` that is stored on the
	 * SAME history entry as the command, so one undo reverts both.
	 *
	 * Skipped whenever ripple editing is on: that path already moved everything
	 * on every track, and running the magnet on top would shift twice.
	 */
	private applyMagnetIfEnabled({
		beforeTracks,
	}: {
		beforeTracks: SceneTracks | null;
	}): Command | null {
		if (this.isRippleEnabled || !this.isMagnetEnabled || !beforeTracks) {
			return null;
		}

		const afterTracks = this.editor.scenes.getActiveSceneOrNull()?.tracks;
		if (!afterTracks) {
			return null;
		}
		const shifts = computeMagnetGapShifts({ beforeTracks, afterTracks });
		if (shifts.length === 0) {
			return null;
		}

		const command = new MagnetGapCloseCommand({
			editor: this.editor,
			before: afterTracks,
			after: applyMagnetShifts({ tracks: afterTracks, shifts }),
		});
		command.execute();
		return command;
	}
}
