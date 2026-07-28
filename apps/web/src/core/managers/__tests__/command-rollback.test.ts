import { describe, expect, test } from "bun:test";
import type { EditorCore } from "@/core";
import { CommandManager } from "@/core/managers/commands";
import { Command, type CommandResult } from "@/commands";

/** A no-op selection snapshot: the manager only reads/writes shape, not content. */
function emptySnapshot() {
	return {
		selectedElements: [],
		selectedKeyframes: [],
		keyframeSelectionAnchor: null,
		selectedMaskPoints: null,
	};
}

/** A stub EditorCore: the manager only needs `scenes`/`selection` when the ripple
 * heuristic or a selection-changing command result is involved, neither of which
 * these tests exercise. */
function newManager(): { manager: CommandManager; log: string[] } {
	const log: string[] = [];
	const stubEditor = {
		scenes: { getActiveSceneOrNull: () => null },
		selection: {
			getSnapshot: () => emptySnapshot(),
			applySelectionPatch: () => emptySnapshot(),
			restoreSnapshot: () => {},
		},
	} as unknown as EditorCore;
	const manager = new CommandManager(stubEditor);
	return { manager, log };
}

/** Records "execute:<id>" / "undo:<id>" into a shared log, so tests can assert
 * both WHICH commands ran and in what ORDER. */
class RecordingCommand extends Command {
	constructor(
		private readonly id: string,
		private readonly log: string[],
	) {
		super();
	}
	execute(): CommandResult | undefined {
		this.log.push(`execute:${this.id}`);
		return undefined;
	}
	undo(): void {
		this.log.push(`undo:${this.id}`);
	}
}

describe("CommandManager.getMark / rollbackTo (Director-cancel U8 fix)", () => {
	test("a mark taken with an empty history rolls back to a no-op", () => {
		const { manager } = newManager();
		const mark = manager.getMark();
		manager.rollbackTo(mark);
		expect(manager.canUndo()).toBe(false);
		expect(manager.canRedo()).toBe(false);
	});

	test("a no-op when nothing was pushed since the mark (cancel before any mutation)", () => {
		const { manager, log } = newManager();
		manager.execute({ command: new RecordingCommand("pre-1", log) });
		const mark = manager.getMark();

		manager.rollbackTo(mark);

		expect(log).toEqual(["execute:pre-1"]);
		expect(manager.canUndo()).toBe(true);
	});

	test("undoes every command pushed after the mark, in reverse order, and discards them (no redo)", () => {
		const { manager, log } = newManager();
		manager.execute({ command: new RecordingCommand("pre-1", log) });
		const mark = manager.getMark();
		manager.execute({ command: new RecordingCommand("run-1", log) });
		manager.execute({ command: new RecordingCommand("run-2", log) });

		manager.rollbackTo(mark);

		expect(log).toEqual([
			"execute:pre-1",
			"execute:run-1",
			"execute:run-2",
			"undo:run-2",
			"undo:run-1",
		]);
		// The pre-existing command survives; the rolled-back ones are gone for
		// good (Cancel means nothing happened, not "undo me later").
		expect(manager.canUndo()).toBe(true);
		expect(manager.canRedo()).toBe(false);
	});

	test("a later, unrelated command after rollback doesn't resurrect the discarded ones", () => {
		const { manager, log } = newManager();
		const mark = manager.getMark();
		manager.execute({ command: new RecordingCommand("run-1", log) });
		manager.rollbackTo(mark);
		log.length = 0;

		manager.execute({ command: new RecordingCommand("later", log) });
		manager.undo();

		expect(log).toEqual(["execute:later", "undo:later"]);
		expect(manager.canUndo()).toBe(false);
	});

	test("stays correct across MAX_HISTORY trimming (mark is an absolute sequence, not a raw index)", () => {
		const { manager, log } = newManager();
		// Fill exactly to the 200-entry cap so the very next pushes force trimming.
		for (let i = 0; i < 200; i++) {
			manager.execute({ command: new RecordingCommand(`fill-${i}`, log) });
		}
		log.length = 0;
		const mark = manager.getMark();
		manager.execute({ command: new RecordingCommand("run-1", log) });
		manager.execute({ command: new RecordingCommand("run-2", log) });
		manager.execute({ command: new RecordingCommand("run-3", log) });

		manager.rollbackTo(mark);

		expect(log).toEqual([
			"execute:run-1",
			"execute:run-2",
			"execute:run-3",
			"undo:run-3",
			"undo:run-2",
			"undo:run-1",
		]);
	});

	// The Director-cancel callers (ai-cut-actions.ts, director-cut-panel.tsx)
	// guard every rollback: they only call rollbackTo(mark) when getMark() still
	// equals a "guardMark" snapshot taken right after their own pre-pass finished
	// - so a rollback never also undoes something else the user did in the
	// meantime (the review panel is docked/non-modal). These tests exercise that
	// exact calling pattern against the real getMark()/rollbackTo() pair.
	test("guard pattern: rollback proceeds when nothing else was pushed since the guard mark", () => {
		const { manager, log } = newManager();
		const mark = manager.getMark();
		manager.execute({ command: new RecordingCommand("pre-pass", log) });
		const guardMark = manager.getMark();

		// Cancel arrives with nothing else having happened in between.
		if (manager.getMark() === guardMark) manager.rollbackTo(mark);

		expect(log).toEqual(["execute:pre-pass", "undo:pre-pass"]);
		expect(manager.canUndo()).toBe(false);
	});

	test("guard pattern: rollback is skipped when the user pushed something else after the guard mark", () => {
		const { manager, log } = newManager();
		const mark = manager.getMark();
		manager.execute({ command: new RecordingCommand("pre-pass", log) });
		const guardMark = manager.getMark();
		// The user edits the timeline while the run is still working / the review
		// panel is open, pushing their OWN command on top.
		manager.execute({ command: new RecordingCommand("user-edit", log) });

		// Cancel arrives; the guard fails (getMark() has moved past guardMark), so
		// the rollback must NOT run - it would otherwise also undo the user's edit.
		if (manager.getMark() === guardMark) manager.rollbackTo(mark);

		expect(log).toEqual(["execute:pre-pass", "execute:user-edit"]);
		expect(manager.canUndo()).toBe(true);
	});
});
