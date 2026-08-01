import { describe, expect, mock, test } from "bun:test";
import type { DirectorOp } from "@framecut/hf-bridge";
import type { LineageSeam } from "@/features/transcription/lineage-types";

/**
 * T16.2 point 5: a per-word RESTORE is an EXTERNAL edit as far as the Director
 * dock is concerned, so the dock must re-sync from the undo stack by the same
 * 2026-07-28 rule as any other foreign command - and land on the terminal
 * `applied-locked` phase CLEANLY, refusing to touch the stack, rather than
 * undoing the wrong command or wedging. This test only READS existing dock
 * behavior; nothing in applied-plan.ts or the store changed for it.
 *
 * Same stubbing discipline as applied-plan.test.ts: the wasm binary and the
 * command classes are faked, and the command sink models a real LIFO stack with
 * reactors that fire on execute/redo only.
 */
mock.module("@/wasm", () => ({
	TICKS_PER_SECOND: 120_000,
	mediaTime: ({ ticks }: { ticks: number }) => ticks,
}));

class FakeRemoveRangesCommand {
	constructor(readonly args: { ranges: { start: number; end: number }[] }) {}
	getRemovedCount(): number {
		return this.args.ranges.length;
	}
}
class FakeMoveElementCommand {
	constructor(_args: { moves: unknown[] }) {}
}
class FakeBatchCommand {
	constructor(readonly commands: unknown[]) {}
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
// RestoreRangeCommand is deliberately NOT faked: the stub sink only PUSHES the
// command onto its modelled stack, never executes it, so the real class can be
// used here and the identity assertions below mean what they say.

const {
	reviseAppliedPlan,
	toggleAbPreview,
	checkBatchControllability,
	ensureAppliedLockReactor,
} = await import("../applied-plan");
const { useDirectorPlanStore } = await import("../director-plan-store");
const { restoreSeamWords } = await import(
	"@/features/transcription/restore-seam"
);
const { RestoreRangeCommand } = await import(
	"@/commands/timeline/track/restore-range"
);

const op = (
	o: Partial<DirectorOp> & Pick<DirectorOp, "op" | "startSec" | "endSec">,
): DirectorOp => ({ id: "op_x", reason: "r", confidence: 0.8, ...o });

/** One Director cut of "um" at 1s..2s, as the transcript panel would see it. */
const SEAM: LineageSeam = {
	id: "seam-1",
	atSec: 1,
	afterWordIndex: 1,
	removedWords: [{ text: "um", start: 1, end: 2 }],
	removedSpans: [{ startSec: 1, endSec: 2 }],
	removedSec: 1,
	contributions: [
		{
			entryId: "e1",
			source: "director",
			at: 0,
			ops: [
				{
					id: "cut-1",
					category: "filler",
					reason: "Removed a filler word",
					start: 120_000,
					end: 240_000,
				},
			],
		},
	],
};

function makeStubEditor() {
	const live: unknown[] = [];
	const redo: unknown[] = [];
	const log: string[] = [];
	const reactors: Array<() => void> = [];
	const runReactors = () => {
		for (const reactor of reactors) reactor();
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
			const popped = live.pop();
			if (popped !== undefined) redo.push(popped);
		},
		redo: () => {
			log.push("redo");
			const popped = redo.pop();
			if (popped !== undefined) live.push(popped);
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
		live,
		scenes: {
			getActiveScene: () => ({
				tracks: { main: { id: "main", elements: [] }, overlay: [], audio: [] },
			}),
		},
		command,
	};
}

/** Apply a Director plan and put the dock in its normal applied phase. */
function applyAndDock() {
	useDirectorPlanStore.getState().close();
	useDirectorPlanStore.getState().openCutPanel({ plan: { operations: [] } });
	const editor = makeStubEditor();
	ensureAppliedLockReactor(editor as never);
	const applied = reviseAppliedPlan({
		editor: editor as never,
		state: { appliedBatch: null, appliedHasBatch: false, abShowing: "with" },
		ops: [op({ op: "cut", startSec: 1, endSec: 2 })],
	});
	if (applied.status !== "revised") throw new Error("expected revised");
	const batch = applied.result.appliedCommand;
	useDirectorPlanStore.getState().markApplied({ batch });
	expect(useDirectorPlanStore.getState().phase).toBe("applied");
	editor.log.length = 0;
	return { editor, batch };
}

describe("a transcript restore after a Director apply (T16.2 point 5)", () => {
	test("the restore is one command on top of the batch, and the dock locks cleanly", () => {
		const { editor, batch } = applyAndDock();

		const plan = restoreSeamWords({ editor: editor as never, seam: SEAM });
		expect(plan?.restoredWords.map((word) => word.text)).toEqual(["um"]);
		// Exactly ONE undoable command, so a single Ctrl+Z reverts the restore and
		// nothing else.
		expect(editor.log).toEqual(["execute"]);
		expect(editor.command.peekUndoCommand()).toBeInstanceOf(
			RestoreRangeCommand,
		);

		// The dock re-synced from the stack the moment the restore executed: the
		// batch is on neither top, so this is the terminal applied-locked phase.
		expect(useDirectorPlanStore.getState().phase).toBe("applied-locked");
		expect(
			checkBatchControllability(editor as never, {
				appliedBatch: batch,
				appliedHasBatch: true,
				abShowing: "with",
			}),
		).toEqual({ controllable: false });
		useDirectorPlanStore.getState().close();
	});

	test("no lock-up: the locked dock refuses without ever touching the undo stack", () => {
		const { editor, batch } = applyAndDock();
		restoreSeamWords({ editor: editor as never, seam: SEAM });
		editor.log.length = 0;
		const stackBefore = [...editor.live];

		// Both guarded interactions refuse instead of undoing the restore (or, worse,
		// the Director batch underneath it).
		expect(
			toggleAbPreview({
				editor: editor as never,
				state: { appliedBatch: batch, appliedHasBatch: true, abShowing: "with" },
			}),
		).toEqual({ status: "locked" });
		expect(
			reviseAppliedPlan({
				editor: editor as never,
				state: { appliedBatch: batch, appliedHasBatch: true, abShowing: "with" },
				ops: [op({ op: "cut", startSec: 1, endSec: 2 })],
			}).status,
		).toBe("locked");
		expect(editor.log).toEqual([]);
		expect(editor.live).toEqual(stackBefore);
		useDirectorPlanStore.getState().close();
	});

	test("one Ctrl+Z after the restore leaves the Director batch applied", () => {
		const { editor, batch } = applyAndDock();
		restoreSeamWords({ editor: editor as never, seam: SEAM });
		editor.command.undo();

		expect(editor.command.peekUndoCommand()).toBe(batch);
		expect(editor.command.peekRedoCommand()).toBeInstanceOf(
			RestoreRangeCommand,
		);
		useDirectorPlanStore.getState().close();
	});

	test("a restore with nothing selected never reaches the command stack", () => {
		const { editor } = applyAndDock();
		expect(
			restoreSeamWords({
				editor: editor as never,
				seam: SEAM,
				wordStartIndex: 1,
				wordEndIndex: 0,
			}),
		).toBeNull();
		expect(editor.log).toEqual([]);
		expect(useDirectorPlanStore.getState().phase).toBe("applied");
		useDirectorPlanStore.getState().close();
	});
});
