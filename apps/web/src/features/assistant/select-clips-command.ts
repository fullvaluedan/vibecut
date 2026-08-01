/**
 * `select_clips` as an undoable command (T17.2).
 *
 * The editor has no selection COMMAND: selection normally rides on another
 * command's `CommandResult`, and `CommandManager` restores the previous
 * selection on undo whenever an entry declared a selection override. That is
 * exactly the machinery this needs, so the command changes no tracks at all and
 * only declares the selection it wants. Undo is a no-op for the same reason:
 * the manager puts the prior selection back from its own snapshot.
 *
 * FrameCut-owned command (new file, not upstream). It lives in the assistant
 * feature rather than `commands/timeline/` because nothing else needs it: the
 * UI selects by clicking, and the Director selects through the batches it
 * already emits.
 */

import {
	Command,
	createElementSelectionResult,
	type CommandResult,
} from "@/commands/base-command";
import type { ElementRef } from "@/timeline";

export class SelectClipsCommand extends Command {
	private readonly refs: ElementRef[];

	constructor({ refs }: { refs: ElementRef[] }) {
		super();
		this.refs = refs;
	}

	execute(): CommandResult | undefined {
		return createElementSelectionResult(this.refs);
	}

	undo(): void {
		// Nothing to restore here: the command touched no tracks, and the command
		// manager restores the pre-command selection snapshot because `execute`
		// declared a selection override.
	}

	getRefs(): ElementRef[] {
		return this.refs;
	}
}
