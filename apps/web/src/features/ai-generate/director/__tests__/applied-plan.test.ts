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

const {
	reviseAppliedPlan,
	reviseAppliedHighlightPlan,
	toggleAbPreview,
	isBatchControllable,
	checkBatchControllability,
	ensureAppliedLockReactor,
} = await import("../applied-plan");
const { useDirectorPlanStore } = await import("../director-plan-store");

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
	// Reactors fire on execute/redo (never undo), mirroring the real CommandManager,
	// and is what `ensureAppliedLockReactor` relies on to catch an external edit.
	const reactors: Array<() => void> = [];
	const runReactors = () => {
		for (const r of reactors) r();
	};
	const command = {
		execute: ({ command }: { command: unknown }) => {
			log.push("execute");
			live.push(command);
			redo.length = 0;
			runReactors();
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
			runReactors();
		},
		peekUndoCommand: () => (live.length ? live[live.length - 1] : null),
		peekRedoCommand: () => (redo.length ? redo[redo.length - 1] : null),
		registerReactor: (fn: () => void) => {
			reactors.push(fn);
		},
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

describe("checkBatchControllability (dock-undo-resync fix)", () => {
	test("no resync needed: passes the belief through unchanged when already controllable", () => {
		const { editor, batch } = applyOnce();
		expect(
			checkBatchControllability(editor as never, {
				appliedBatch: batch,
				appliedHasBatch: true,
				abShowing: "with",
			}),
		).toEqual({ controllable: true, abShowing: "with" });
	});

	test("resyncs with -> without after an EXTERNAL undo (Dan's live-test repro)", () => {
		const { editor, batch } = applyOnce();
		editor.command.undo(); // an external Ctrl+Z; the store still believes "with"
		expect(
			checkBatchControllability(editor as never, {
				appliedBatch: batch,
				appliedHasBatch: true,
				abShowing: "with",
			}),
		).toEqual({ controllable: true, abShowing: "without" });
	});

	test("resyncs without -> with after an EXTERNAL redo", () => {
		const { editor, batch } = applyOnce();
		editor.command.undo();
		editor.log.length = 0;
		editor.command.redo(); // an external Ctrl+Shift+Z; the store still believes "without"
		expect(
			checkBatchControllability(editor as never, {
				appliedBatch: batch,
				appliedHasBatch: true,
				abShowing: "without",
			}),
		).toEqual({ controllable: true, abShowing: "with" });
	});

	test("stays locked when a foreign command sits on top of the batch", () => {
		const { editor, batch } = applyOnce();
		editor.command.execute({ command: "user-edit" });
		expect(
			checkBatchControllability(editor as never, {
				appliedBatch: batch,
				appliedHasBatch: true,
				abShowing: "with",
			}),
		).toEqual({ controllable: false });
	});

	test("stays locked when the batch is on neither stack top", () => {
		const { editor, batch } = applyOnce();
		editor.command.undo(); // batch -> redo top
		editor.command.execute({ command: "some-other-edit" }); // clears the redo stack
		expect(
			checkBatchControllability(editor as never, {
				appliedBatch: batch,
				appliedHasBatch: true,
				abShowing: "with",
			}),
		).toEqual({ controllable: false });
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

	test("a manual Ctrl+Z THEN a further foreign edit still locks (batch is on neither stack top)", () => {
		const { editor, batch } = applyOnce();
		editor.command.undo(); // batch -> redo top
		editor.command.execute({ command: "user-edit" }); // clears the redo stack
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

// A manual Ctrl+Z ALONE (nothing else intervening) used to land here too and lock
// (see the U8 fix test above, superseded). It no longer does: see
// "reviseAppliedPlan: resyncs from an external undo/redo instead of locking" below,
// the dock-undo-resync fix this file pins.

describe("reviseAppliedPlan: resyncs from an external undo/redo instead of locking (dock-undo-resync fix)", () => {
	test("revise after an EXTERNAL Ctrl+Z re-applies fresh, without a second (wrong) undo", () => {
		const { editor, batch } = applyOnce();
		editor.command.undo(); // external Ctrl+Z; the store still believes abShowing "with"
		editor.log.length = 0;
		const outcome = reviseAppliedPlan({
			editor: editor as never,
			state: { appliedBatch: batch, appliedHasBatch: true, abShowing: "with" },
			ops: [op({ op: "cut", startSec: 1, endSec: 2 })],
		});
		expect(outcome.status).toBe("revised");
		// The batch is already undone (on the redo stack): revise must NOT undo
		// again, it just executes fresh, which clears the stale redo entry.
		expect(editor.log).toEqual(["execute"]);
		expect(editor.timeline()).toHaveLength(1);
	});

	test("revise after an EXTERNAL redo undoes the resynced batch before re-applying", () => {
		const { editor, batch } = applyOnce();
		editor.command.undo();
		editor.log.length = 0;
		editor.command.redo(); // external Ctrl+Shift+Z; the store still believes "without"
		editor.log.length = 0;
		const outcome = reviseAppliedPlan({
			editor: editor as never,
			state: { appliedBatch: batch, appliedHasBatch: true, abShowing: "without" },
			ops: [op({ op: "cut", startSec: 1, endSec: 2 })],
		});
		expect(outcome.status).toBe("revised");
		expect(editor.log).toEqual(["undo", "execute"]);
		expect(editor.timeline()).toHaveLength(1);
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

describe("toggleAbPreview: resyncs from an external undo/redo instead of locking (dock-undo-resync fix)", () => {
	test("an EXTERNAL Ctrl+Z resyncs to without, so the toggle click redoes the cuts back (Dan's repro)", () => {
		const { editor, batch } = applyOnce();
		editor.command.undo(); // external Ctrl+Z; the store still believes abShowing "with"
		editor.log.length = 0;
		const outcome = toggleAbPreview({
			editor: editor as never,
			state: { appliedBatch: batch, appliedHasBatch: true, abShowing: "with" },
		});
		// Resynced belief is "without" (already undone), so THIS toggle click is the
		// redo that puts the cuts back: one click, no separate unlock step first.
		expect(outcome).toEqual({ status: "toggled", showing: "with" });
		expect(editor.log).toEqual(["redo"]);
	});

	test("an EXTERNAL redo resyncs to with, so the toggle click undoes to preview the original", () => {
		const { editor, batch } = applyOnce();
		editor.command.undo();
		editor.log.length = 0;
		editor.command.redo(); // external Ctrl+Shift+Z; the store still believes "without"
		editor.log.length = 0;
		const outcome = toggleAbPreview({
			editor: editor as never,
			state: { appliedBatch: batch, appliedHasBatch: true, abShowing: "without" },
		});
		expect(outcome).toEqual({ status: "toggled", showing: "without" });
		expect(editor.log).toEqual(["undo"]);
	});
});

describe("reviseAppliedHighlightPlan (R1: the Highlight sibling of reviseAppliedPlan)", () => {
	/** Apply once through the highlight revise path (state = nothing applied yet). */
	function applyHighlightOnce() {
		const editor = makeStubEditor();
		const first = reviseAppliedHighlightPlan({
			editor: editor as never,
			state: { appliedBatch: null, appliedHasBatch: false, abShowing: "with" },
			keeps: [{ startSec: 2, endSec: 5 }],
			totalSec: 10,
		});
		if (first.status !== "revised") throw new Error("expected revised");
		editor.log.length = 0;
		return { editor, batch: first.result.appliedCommand };
	}

	test("a revise is exactly (undo batch, new batch) when the batch is the controllable top", () => {
		const { editor, batch } = applyHighlightOnce();
		const outcome = reviseAppliedHighlightPlan({
			editor: editor as never,
			state: { appliedBatch: batch, appliedHasBatch: true, abShowing: "with" },
			keeps: [{ startSec: 0, endSec: 4 }],
			totalSec: 10,
		});
		expect(outcome.status).toBe("revised");
		expect(editor.log).toEqual(["undo", "execute"]);
		expect(editor.timeline()).toHaveLength(1); // still one batch over the original
	});

	test("does NOT undo when no batch is applied (never pops the prior step)", () => {
		const editor = makeStubEditor();
		const outcome = reviseAppliedHighlightPlan({
			editor: editor as never,
			state: { appliedBatch: null, appliedHasBatch: false, abShowing: "with" },
			keeps: [{ startSec: 2, endSec: 5 }],
			totalSec: 10,
		});
		expect(outcome.status).toBe("revised");
		expect(editor.log).toEqual(["execute"]);
	});

	test("guarded: an intervening manual command makes revise a no-op lock", () => {
		const { editor, batch } = applyHighlightOnce();
		editor.command.execute({ command: "user-edit" });
		editor.log.length = 0;
		const outcome = reviseAppliedHighlightPlan({
			editor: editor as never,
			state: { appliedBatch: batch, appliedHasBatch: true, abShowing: "with" },
			keeps: [{ startSec: 0, endSec: 4 }],
			totalSec: 10,
		});
		expect(outcome.status).toBe("locked");
		expect(editor.log).toEqual([]); // did not touch the stack
	});
});

describe("ensureAppliedLockReactor (shared applied-lock reactor, R1)", () => {
	const plan = { operations: [] };

	test("locks the applied phase when an external edit moves the batch off the controllable top", () => {
		useDirectorPlanStore.getState().close();
		useDirectorPlanStore.getState().openCutPanel({ plan });
		const editor = makeStubEditor();
		ensureAppliedLockReactor(editor as never);
		// Registering twice for the same editor must not double-register (WeakSet dedup).
		ensureAppliedLockReactor(editor as never);

		const first = reviseAppliedPlan({
			editor: editor as never,
			state: { appliedBatch: null, appliedHasBatch: false, abShowing: "with" },
			ops: [op({ op: "cut", startSec: 1, endSec: 2 })],
		});
		if (first.status !== "revised") throw new Error("expected revised");
		useDirectorPlanStore.getState().markApplied({ batch: first.result.appliedCommand });
		expect(useDirectorPlanStore.getState().phase).toBe("applied");

		// An external (non-suppressed) command moves the batch off the undo-top.
		editor.command.execute({ command: "user-edit" });

		expect(useDirectorPlanStore.getState().phase).toBe("applied-locked");
		useDirectorPlanStore.getState().close();
	});

	test("does not self-lock while our own revise runs (reactor suppressed)", () => {
		useDirectorPlanStore.getState().close();
		useDirectorPlanStore.getState().openCutPanel({ plan });
		const editor = makeStubEditor();
		ensureAppliedLockReactor(editor as never);

		const first = reviseAppliedPlan({
			editor: editor as never,
			state: { appliedBatch: null, appliedHasBatch: false, abShowing: "with" },
			ops: [op({ op: "cut", startSec: 1, endSec: 2 })],
		});
		if (first.status !== "revised") throw new Error("expected revised");
		useDirectorPlanStore.getState().markApplied({ batch: first.result.appliedCommand });

		// A revise undoes + re-executes under withReactorSuppressed; must not self-lock.
		const outcome = reviseAppliedPlan({
			editor: editor as never,
			state: {
				appliedBatch: first.result.appliedCommand,
				appliedHasBatch: true,
				abShowing: "with",
			},
			ops: [op({ op: "cut", startSec: 1, endSec: 2 })],
		});
		expect(outcome.status).toBe("revised");
		expect(useDirectorPlanStore.getState().phase).toBe("applied"); // not locked
		useDirectorPlanStore.getState().close();
	});

	test("resyncs abShowing when an EXTERNAL redo restores the batch, instead of locking (dock-undo-resync fix)", () => {
		useDirectorPlanStore.getState().close();
		useDirectorPlanStore.getState().openCutPanel({ plan });
		const editor = makeStubEditor();
		ensureAppliedLockReactor(editor as never);

		const first = reviseAppliedPlan({
			editor: editor as never,
			state: { appliedBatch: null, appliedHasBatch: false, abShowing: "with" },
			ops: [op({ op: "cut", startSec: 1, endSec: 2 })],
		});
		if (first.status !== "revised") throw new Error("expected revised");
		const batch = first.result.appliedCommand;
		useDirectorPlanStore.getState().markApplied({ batch });

		// The dock's own A/B toggle previews the original (a legitimate "without").
		editor.command.undo();
		useDirectorPlanStore.getState().setAbShowing("without");

		// An EXTERNAL redo (Ctrl+Shift+Z fired from outside the dock) brings the
		// cuts back. Redo fires reactors: the reactor must resync the belief to
		// "with" and stay live, not lock it.
		editor.command.redo();

		expect(useDirectorPlanStore.getState().phase).toBe("applied");
		expect(useDirectorPlanStore.getState().abShowing).toBe("with");
		useDirectorPlanStore.getState().close();
	});

	test("an EXTERNAL undo does not lock immediately (undo fires no reactors); the NEXT guarded interaction resyncs it live", () => {
		useDirectorPlanStore.getState().close();
		useDirectorPlanStore.getState().openCutPanel({ plan });
		const editor = makeStubEditor();
		ensureAppliedLockReactor(editor as never);

		const first = reviseAppliedPlan({
			editor: editor as never,
			state: { appliedBatch: null, appliedHasBatch: false, abShowing: "with" },
			ops: [op({ op: "cut", startSec: 1, endSec: 2 })],
		});
		if (first.status !== "revised") throw new Error("expected revised");
		useDirectorPlanStore.getState().markApplied({ batch: first.result.appliedCommand });

		// Dan's repro: an external Ctrl+Z. Nothing observes this yet (same as
		// before the fix), so the store's belief is stale until the next
		// interaction.
		editor.command.undo();
		expect(useDirectorPlanStore.getState().phase).toBe("applied");
		expect(useDirectorPlanStore.getState().abShowing).toBe("with"); // stale

		// The next interaction the dock offers (its own A/B button) is what
		// resyncs: it must NOT lock, and it must act on the true stack state.
		const s = useDirectorPlanStore.getState();
		const outcome = toggleAbPreview({
			editor: editor as never,
			state: {
				appliedBatch: s.appliedBatch,
				appliedHasBatch: s.appliedHasBatch,
				abShowing: s.abShowing,
			},
		});
		expect(outcome.status).toBe("toggled");
		if (outcome.status === "toggled") {
			useDirectorPlanStore.getState().setAbShowing(outcome.showing);
		}
		expect(useDirectorPlanStore.getState().phase).toBe("applied"); // never locked
		expect(useDirectorPlanStore.getState().abShowing).toBe("with"); // cuts re-applied
		useDirectorPlanStore.getState().close();
	});
});
