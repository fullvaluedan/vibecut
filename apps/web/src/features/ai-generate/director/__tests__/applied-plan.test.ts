import { describe, expect, mock, test } from "bun:test";
import type { DirectorOp } from "@framecut/hf-bridge";

// applied-plan -> apply-plan imports `@/wasm` + command classes at module top; stub
// them so the orchestration imports under bun. A modeled command stack lets the
// A/B test assert a byte-identical timeline after undo/redo round trips.
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

const { reviseAppliedPlan, toggleAbPreview } = await import("../applied-plan");

const op = (
	o: Partial<DirectorOp> & Pick<DirectorOp, "op" | "startSec" | "endSec">,
): DirectorOp => ({ id: "op_x", reason: "r", confidence: 0.8, ...o });

/**
 * A stub editor whose command sink models a real undo/redo stack: `execute` pushes
 * a command onto the timeline (clearing redo), `undo` moves the top to the redo
 * stack, `redo` moves it back. `timeline()` is the ordered list of live commands,
 * so two callers can compare it byte-for-byte.
 */
function makeStubEditor() {
	const live: unknown[] = [];
	const redo: unknown[] = [];
	const log: string[] = [];
	return {
		log,
		timeline: () => live.map(() => "cmd"),
		scenes: {
			getActiveScene: () => ({
				tracks: { main: { id: "main", elements: [] }, overlay: [], audio: [] },
			}),
		},
		command: {
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
		},
	};
}

describe("reviseAppliedPlan", () => {
	test("a revise is exactly (undo batch, new batch) when a batch is applied", () => {
		const editor = makeStubEditor();
		editor.command.execute({ command: "initial-apply" }); // stand in for first apply
		editor.log.length = 0;

		const result = reviseAppliedPlan({
			editor: editor as never,
			undoFirst: true,
			ops: [op({ op: "cut", startSec: 1, endSec: 2 })],
		});

		expect(editor.log).toEqual(["undo", "execute"]);
		expect(result.cuts).toBe(1);
		// Still one live command over the pre-Director timeline.
		expect(editor.timeline()).toHaveLength(1);
	});

	test("does NOT undo first when no batch is applied (never pops the prior step)", () => {
		const editor = makeStubEditor();
		reviseAppliedPlan({
			editor: editor as never,
			undoFirst: false,
			ops: [op({ op: "cut", startSec: 1, endSec: 2 })],
		});
		expect(editor.log).toEqual(["execute"]);
	});

	test("revising to accept-nothing undoes the batch and applies no new one", () => {
		const editor = makeStubEditor();
		editor.command.execute({ command: "initial-apply" });
		editor.log.length = 0;

		const result = reviseAppliedPlan({
			editor: editor as never,
			undoFirst: true,
			ops: [], // everything rejected
		});
		expect(editor.log).toEqual(["undo"]); // no execute
		expect(result.cuts).toBe(0);
		expect(editor.timeline()).toHaveLength(0); // back to pre-Director
	});
});

describe("toggleAbPreview", () => {
	test("with -> without undoes; without -> with redoes", () => {
		const editor = makeStubEditor();
		expect(toggleAbPreview({ editor: editor as never, showing: "with" })).toBe(
			"without",
		);
		expect(editor.log).toEqual(["undo"]);
		expect(toggleAbPreview({ editor: editor as never, showing: "without" })).toBe(
			"with",
		);
		expect(editor.log).toEqual(["undo", "redo"]);
	});

	test("A/B twice returns a byte-identical timeline", () => {
		const editor = makeStubEditor();
		editor.command.execute({ command: "applied-batch" });
		const before = editor.timeline();

		let showing: "with" | "without" = "with";
		showing = toggleAbPreview({ editor: editor as never, showing }); // without
		showing = toggleAbPreview({ editor: editor as never, showing }); // with

		expect(showing).toBe("with");
		expect(editor.timeline()).toEqual(before);
	});
});
