/**
 * T16.3 restore-window SHELL (see docs/plans/2026-08-01-001, T16.2 point 3):
 * a manual delete can only be restored by a plain `editor.command.undo()`
 * while it is STILL the top of the undo stack - anything below the top would
 * undo a LATER edit instead of this one. This never claims a restore it
 * cannot perform; once another command lands on top, the popover must say so
 * instead of silently undoing the wrong thing. Per-word partial restore
 * (re-inserting a subset via a new RestoreRangeCommand) is T16.2's lineage
 * work; this gate only answers "would a plain undo still hit this delete".
 *
 * Generic over the command identity type so this stays decoupled from the
 * concrete `Command` class and is trivially unit-testable with plain values.
 */
export function canRestoreDeletion<T>({
	deletionCommand,
	topUndoCommand,
}: {
	/** The command this deletion pushed onto the undo stack, captured right
	 * after `editor.command.execute(...)` returned. */
	deletionCommand: T | null;
	/** `editor.command.peekUndoCommand()`, read fresh when the popover opens. */
	topUndoCommand: T | null;
}): boolean {
	return deletionCommand != null && deletionCommand === topUndoCommand;
}
