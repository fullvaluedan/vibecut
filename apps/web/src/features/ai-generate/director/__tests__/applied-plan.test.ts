import { describe, expect, mock, test } from "bun:test";
import type { DirectorOp } from "@framecut/hf-bridge";

// applied-plan -> apply-plan imports `@/wasm` + command classes at module top; stub
// them so the orchestration imports under bun. A modeled command stack (with peeks)
// lets the guard tests assert the exact undo/redo behavior against a real LIFO stack.
mock.module("@/wasm", () => ({
	TICKS_PER_SECOND: 120_000,
	mediaTime: ({ ticks }: { ticks: number }) => ticks,
}));

class FakeRemoveRangesCommand {
	readonly ranges: { start: number; end: number }[];
	constructor(args: { ranges: { start: number; end: number }[] }) {
		this.ranges = args.ranges;
	}
	getRemovedCount(): number {
		return this.ranges.length;
	}
}
class FakeMoveElementCommand {
	constructor(_args: { moves: unknown[] }) {}
}
class FakeBatchCommand {
	readonly commands: unknown[];
	constructor(commands: unknown[]) {
		this.commands = commands;
	}
}
class FakeConsolidateAdjacentClipsCommand {}

mock.module("@/commands/timeline/track/remove-ranges", () => ({
	RemoveRangesCommand: FakeRemoveRangesCommand,
}));
mock.module("@/commands/timeline/element/move-elements", () => ({
	MoveElementCommand: FakeMoveElementCommand,
}));
mock.module("@/commands/timeline/track/consolidate-adjacent-clips", () => ({
	ConsolidateAdjacentClipsCommand: FakeConsolidateAdjacentClipsCommand,
}));
mock.module("@/commands/batch-command", () => ({ BatchCommand: FakeBatchCommand }));

const { reviseAppliedPlan, toggleAbPreview, isBatchControllable } = await import(
	"../applied-plan"
);

const op = (
	o: Partial<DirectorOp> & Pick<DirectorOp, "op" | "startSec" | "endSec">,
): DirectorOp => ({ id: "op_x", reason: "r", confidence: 0.8, ...o });

/**
 * A stub editor whose command sink models a real LIFO undo/redo stack: `execute`
 * pushes a command (clearing redo), `undo` moves the top to the redo stack, `redo`
 * moves it back, and `peekUndoCommand`/`peekRedoCommand` read the tops. `timeline()`
 * is the ordered list of live commands so callers can compare it byte-for-byte.
 */
function makeStubEditor() {
	const live: unknown[] = [];
	const redo: unknown[] = [];
	const log: string[] = [];
	const command = {
		execute: ({ command }: { command: unknown }) => {
			log.push("execute");
			live.push(command);
			redo.length = 0;
		},
		undo: () => {
			log.push("undo");
			const c = live.pop();
			if (c !== undefined) redo.push(c);
		},
		redo: () => {
			log.push("redo");
			const c = redo.pop();
			if (c !== undefined) live.push(c);
		},
		peekUndoCommand: () => (live.length ? live[live.length - 1] : null),
		peekRedoCommand: () => (redo.length ? redo[redo.length - 1] : null),
	};
	return {
		log,
		timeline: () => live.map(() => "cmd"),
		scenes: {
			getActiveScene: () => ({
				tracks: { main: { id: "main", elements: [] }, overlay: [], audio: [] },
			}),
		},
		command,
	};
}

/** Apply once through the revise path (state = nothing applied yet) and return the
 * batch handle + editor, the shared setup for the guard tests. */
function applyOnce() {
	const editor = makeStubEditor();
	const first = reviseAppliedPlan({
		editor: editor as never,
		state: { appliedBatch: null, appliedHasBatch: false, abShowing: "with" },
		ops: [op({ op: "cut", startSec: 1, endSec: 2 })],
	});
	if (first.status !== "revised") throw new Error("expected revised");
	editor.log.length = 0;
	return { editor, batch: first.result.appliedCommand };
}

describe("reviseAppliedPlan: happy path (U8, unchanged behavior)", () => {
	test("a revise is exactly (undo batch, new batch) when the batch is the controllable top", () => {
		const { editor, batch } = applyOnce();
		const outcome = reviseAppliedPlan({
			editor: editor as never,
			state: { appliedBatch: batch, appliedHasBatch: true, abShowing: "with" },
			ops: [op({ op: "cut", startSec: 1, endSec: 2 })],
		});
		expect(outcome.status).toBe("revised");
		expect(editor.log).toEqual(["undo", "execute"]);
		expect(editor.timeline()).toHaveLength(1); // still one batch over the original
	});

	test("does NOT undo when no batch is applied (never pops the prior step)", () => {
		const editor = makeStubEditor();
		const outcome = reviseAppliedPlan({
			editor: editor as never,
			state: { appliedBatch: null, appliedHasBatch: false, abShowing: "with" },
			ops: [op({ op: "cut", startSec: 1, endSec: 2 })],
		});
		expect(outcome.status).toBe("revised");
		expect(editor.log).toEqual(["execute"]);
	});

	test("revising to accept-nothing undoes the batch and applies no new one", () => {
		const { editor, batch } = applyOnce();
		const outcome = reviseAppliedPlan({
			editor: editor as never,
			state: { appliedBatch: batch, appliedHasBatch: true, abShowing: "with" },
			ops: [],
		});
		expect(outcome.status).toBe("revised");
		expect(editor.log).toEqual(["undo"]); // no execute
		expect(editor.timeline()).toHaveLength(0); // back to pre-Director
	});
});

describe("isBatchControllable", () => {
	test("true when the batch is the undo-top (showing with)", () => {
		const { editor, batch } = applyOnce();
		expect(
			isBatchControllable(editor as never, {
				appliedBatch: batch,
				appliedHasBatch: true,
				abShowing: "with",
			}),
		).toBe(true);
	});

	test("true when nothing is applied", () => {
		const editor = makeStubEditor();
		expect(
			isBatchControllable(editor as never, {
				appliedBatch: null,
				appliedHasBatch: false,
				abShowing: "with",
			}),
		).toBe(true);
	});

	test("false after an external edit pushes a command on top of the batch", () => {
		const { editor, batch } = applyOnce();
		editor.command.execute({ command: "user-edit" }); // intervening manual command
		expect(
			isBatchControllable(editor as never, {
				appliedBatch: batch,
				appliedHasBatch: true,
				abShowing: "with",
			}),
		).toBe(false);
	});

	test("false after a manual Ctrl+Z pops the batch off the undo-top", () => {
		const { editor, batch } = applyOnce();
		editor.command.undo(); // manual Ctrl+Z, store flags not synced
		expect(
			isBatchControllable(editor as never, {
				appliedBatch: batch,
				appliedHasBatch: true,
				abShowing: "with",
			}),
		).toBe(false);
	});
});

describe("reviseAppliedPlan: guarded against a moved batch (U8 fix)", () => {
	test("an intervening manual command makes revise a no-op lock, not a double-apply", () => {
		const { editor, batch } = applyOnce();
		editor.command.execute({ command: "user-edit" });
		editor.log.length = 0;
		const timelineBefore = editor.timeline();

		const outcome = reviseAppliedPlan({
			editor: editor as never,
			state: { appliedBatch: batch, appliedHasBatch: true, abShowing: "with" },
			ops: [op({ op: "cut", startSec: 1, endSec: 2 })],
		});

		expect(outcome.status).toBe("locked");
		expect(editor.log).toEqual([]); // did not touch the stack
		expect(editor.timeline()).toEqual(timelineBefore); // user's edit intact, no double batch
	});

	test("a manual Ctrl+Z before revise locks instead of undoing the pre-Director step", () => {
		const { editor, batch } = applyOnce();
		editor.command.undo();
		editor.log.length = 0;
		const outcome = reviseAppliedPlan({
			editor: editor as never,
			state: { appliedBatch: batch, appliedHasBatch: true, abShowing: "with" },
			ops: [op({ op: "cut", startSec: 1, endSec: 2 })],
		});
		expect(outcome.status).toBe("locked");
		expect(editor.log).toEqual([]);
	});
});

describe("toggleAbPreview", () => {
	test("with -> without undoes; without -> with redoes (byte-identical round trip)", () => {
		const { editor, batch } = applyOnce();
		const before = editor.timeline();

		const off = toggleAbPreview({
			editor: editor as never,
			state: { appliedBatch: batch, appliedHasBatch: true, abShowing: "with" },
		});
		expect(off).toEqual({ status: "toggled", showing: "without" });
		expect(editor.log).toEqual(["undo"]);

		const on = toggleAbPreview({
			editor: editor as never,
			state: { appliedBatch: batch, appliedHasBatch: true, abShowing: "without" },
		});
		expect(on).toEqual({ status: "toggled", showing: "with" });
		expect(editor.log).toEqual(["undo", "redo"]);
		expect(editor.timeline()).toEqual(before); // A/B twice restores the timeline
	});

	test("an intervening command makes A/B a no-op lock (never undo/redo the wrong command)", () => {
		const { editor, batch } = applyOnce();
		editor.command.execute({ command: "user-edit" });
		editor.log.length = 0;
		const outcome = toggleAbPreview({
			editor: editor as never,
			state: { appliedBatch: batch, appliedHasBatch: true, abShowing: "with" },
		});
		expect(outcome.status).toBe("locked");
		expect(editor.log).toEqual([]); // did not undo the user's edit
	});
});
