import { describe, expect, mock, test } from "bun:test";
import type { DirectorOp } from "@framecut/hf-bridge";
import type { AssistantContext } from "../context";
import type { AssistantTurnResponse } from "../types";
import { smallSnapshot } from "./fixtures";

/**
 * T17.2 point 5 (roadmap section 6): an assistant apply is an EXTERNAL edit as
 * far as the Director dock is concerned, exactly like a transcript restore
 * (T16.2 point 5). It must re-sync from the undo stack by the same 2026-07-28
 * rule and land on the terminal `applied-locked` phase CLEANLY - refusing to
 * touch the stack rather than undoing the wrong command or wedging - and one
 * Ctrl+Z must put the Director batch back on top.
 *
 * Stubbing discipline, and where it deliberately differs from
 * `restore-dock-resync.test.ts`: that test fakes the Director's command classes
 * and `BatchCommand`, but `mock.module` is process-wide in bun, and this file
 * sorts before `executor.test.ts`, which asserts on those REAL classes. So
 * nothing command-shaped is faked here. It does not need to be: the stub sink
 * below only PUSHES a command onto its modelled stack and never executes it, so
 * the real classes are merely constructed and every identity assertion means
 * what it says. Only `@/core` is stubbed, because `AddTrackCommand` reads the
 * live editor in its constructor.
 */
mock.module("@/core", () => ({
	EditorCore: {
		getInstance: () => ({ scenes: { getActiveSceneOrNull: () => null } }),
	},
}));

const {
	reviseAppliedPlan,
	toggleAbPreview,
	checkBatchControllability,
	ensureAppliedLockReactor,
} = await import("@/features/ai-generate/director/applied-plan");
const { useDirectorPlanStore } = await import(
	"@/features/ai-generate/director/director-plan-store"
);
const { createAssistantTurnDriver } = await import("../turn-service");
const { BatchCommand } = await import("@/commands/batch-command");

const op = (
	o: Partial<DirectorOp> & Pick<DirectorOp, "op" | "startSec" | "endSec">,
): DirectorOp => ({ id: "op_x", reason: "r", confidence: 0.8, ...o });

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
			return command as never;
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
		peekUndoCommand: () => (live.length ? live[live.length - 1] : null) as never,
		peekRedoCommand: () => (redo.length ? redo[redo.length - 1] : null) as never,
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

function turnResponse(
	overrides: Partial<AssistantTurnResponse> = {},
): AssistantTurnResponse {
	return {
		text: "",
		toolCalls: [],
		question: null,
		stopReason: "end_turn",
		usage: null,
		promptVersion: 1,
		model: "test-model",
		...overrides,
	};
}

/** Run one small assistant turn against the dock's own stub stack. */
async function runAssistantTurn(editor: ReturnType<typeof makeStubEditor>) {
	const responses: AssistantTurnResponse[] = [
		turnResponse({
			toolCalls: [
				{ id: "t1", name: "add_marker", args: { atSec: 3, note: "here" } },
			],
		}),
		turnResponse({ text: "Marker added." }),
	];
	let index = 0;
	const driver = createAssistantTurnDriver({
		collect: () => ({
			snapshot: smallSnapshot(),
			context: {} as AssistantContext,
		}),
		request: async () => {
			const next = responses[index];
			index += 1;
			if (!next) throw new Error("too many round-trips");
			return next;
		},
		editor: editor as never,
	});
	await driver.start("add a marker at three seconds");
	return driver;
}

describe("an assistant apply next to an applied Director plan", () => {
	test("it is exactly ONE command on top of the batch, and the dock locks cleanly", async () => {
		const { editor, batch } = applyAndDock();
		await runAssistantTurn(editor);

		// One undoable command, so a single Ctrl+Z reverts the whole prompt turn
		// and nothing else.
		expect(editor.log).toEqual(["execute"]);
		expect(editor.command.peekUndoCommand()).toBeInstanceOf(BatchCommand);
		expect(editor.command.peekUndoCommand()).not.toBe(batch);

		// The dock re-synced from the stack the moment the assistant batch
		// executed: the Director batch is on neither top, so this is the terminal
		// applied-locked phase, not a wedge.
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

	test("no lock-up: the locked dock refuses without ever touching the undo stack", async () => {
		const { editor, batch } = applyAndDock();
		await runAssistantTurn(editor);
		editor.log.length = 0;
		const stackBefore = [...editor.live];

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

	test("one Ctrl+Z after the assistant apply leaves the Director batch applied", async () => {
		const { editor, batch } = applyAndDock();
		await runAssistantTurn(editor);
		editor.command.undo();

		expect(editor.command.peekUndoCommand()).toBe(batch);
		expect(editor.command.peekRedoCommand()).toBeInstanceOf(BatchCommand);
		expect(editor.command.peekRedoCommand()).not.toBe(batch);
		// With the assistant's batch off the stack the dock is controllable again
		// by the same peek rule; nothing had to be repaired by hand.
		expect(
			checkBatchControllability(editor as never, {
				appliedBatch: batch,
				appliedHasBatch: true,
				abShowing: "with",
			}),
		).toEqual({ controllable: true, abShowing: "with" });
		useDirectorPlanStore.getState().close();
	});

	test("the assistant's own Undo chip refuses once the dock has moved the stack", async () => {
		const { editor } = applyAndDock();
		const driver = await runAssistantTurn(editor);
		expect(driver.isBusy()).toBe(false);

		// A later command lands on top: the chip's handle must stop claiming an
		// undo it can no longer perform, the same rule as the T16.3 restore gate.
		editor.command.execute({ command: {} });
		expect(editor.command.peekUndoCommand()).not.toBeInstanceOf(
			BatchCommand,
		);
		useDirectorPlanStore.getState().close();
	});

	test("a turn the assistant never applies leaves the dock untouched", async () => {
		const { editor } = applyAndDock();
		const driver = createAssistantTurnDriver({
			collect: () => ({
				snapshot: smallSnapshot(),
				context: {} as AssistantContext,
			}),
			request: async () =>
				turnResponse({
					toolCalls: [{ id: "q", name: "ask_user", args: { question: "Which?" } }],
					question: "Which?",
				}),
			editor: editor as never,
		});
		await driver.start("cut the boring part");

		expect(editor.log).toEqual([]);
		expect(useDirectorPlanStore.getState().phase).toBe("applied");
		useDirectorPlanStore.getState().close();
	});
});
