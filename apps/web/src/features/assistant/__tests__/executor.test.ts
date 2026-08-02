import { describe, expect, mock, test } from "bun:test";
import type { MediaTime } from "@/wasm";
import type {
	SnapshotClip,
	SnapshotTrack,
	TimelineSnapshot,
} from "../snapshot";
import type { ValidatedToolCall } from "../types";
import { audioClip, FPS, sec, smallSnapshot, videoClip } from "./fixtures";

/**
 * `AddTrackCommand` reads the live editor IN ITS CONSTRUCTOR (to resolve the
 * lane it would reuse at the track cap), so planning a `move_clip` with
 * `toNewTrack` needs an editor to exist. Everything else here only builds
 * commands; none of them are executed, so this stub never has to model tracks.
 */
mock.module("@/core", () => ({
	EditorCore: {
		getInstance: () => ({
			scenes: { getActiveSceneOrNull: () => null },
		}),
	},
}));

const {
	planAssistantTurn,
	canUndoAssistantApply,
	buildAssistantUndoHandle,
	isAdditiveOnlyTurn,
	earliestInsertStart,
	showInsertedElement,
} = await import("../executor");
const { deriveAccent, pickForeground } = await import("../color-utils");
const { validateTurn } = await import("../tools");
const { SelectClipsCommand } = await import("../select-clips-command");
const { RemoveRangesCommand } = await import(
	"@/commands/timeline/track/remove-ranges"
);
const { DeleteElementsCommand } = await import(
	"@/commands/timeline/element/delete-elements"
);
const { UpdateElementsCommand } = await import(
	"@/commands/timeline/element/update-elements"
);
const { SplitElementsCommand } = await import(
	"@/commands/timeline/element/split-elements"
);
const { MoveElementCommand } = await import(
	"@/commands/timeline/element/move-elements"
);
const { InsertElementCommand } = await import(
	"@/commands/timeline/element/insert-element"
);
const { RippleShiftElementsCommand } = await import(
	"@/commands/timeline/element/ripple-shift-elements"
);
const { AddTrackCommand } = await import("@/commands/timeline/track/add-track");
const { ToggleBookmarkCommand } = await import(
	"@/commands/scene/toggle-bookmark"
);
const { UpdateBookmarkCommand } = await import(
	"@/commands/scene/update-bookmark"
);

/** Read a command's constructor arguments. `private` is erased at runtime, so
 * the shape a command was built with is exactly what these fields hold. */
function peek<T>(command: unknown): T {
	return command as unknown as T;
}

function plan(calls: ValidatedToolCall[], snapshot: TimelineSnapshot) {
	return planAssistantTurn({ calls, snapshot });
}

function track({
	id,
	label,
	type,
	isMain = false,
	clips,
}: {
	id: string;
	label: string;
	type: SnapshotTrack["type"];
	isMain?: boolean;
	clips: SnapshotClip[];
}): SnapshotTrack {
	return { id, label, type, isMain, clips };
}

/**
 * Three butted main clips plus the first one's separated audio. `b` carries
 * real trim on both sides, so it has headroom on either edge.
 */
function threeClipSnapshot(
	overrides: Partial<TimelineSnapshot> = {},
): TimelineSnapshot {
	return {
		...smallSnapshot(),
		totalDuration: sec(14),
		tracks: [
			track({
				id: "track-main",
				label: "V1",
				type: "video",
				isMain: true,
				clips: [
					videoClip({
						id: "a",
						trackId: "track-main",
						startSec: 0,
						durationSec: 6,
						name: "a",
						mediaName: "a.mp4",
						sourceDurationSec: 6,
						linkId: "link-a",
					}),
					videoClip({
						id: "b",
						trackId: "track-main",
						startSec: 6,
						durationSec: 4,
						name: "b",
						mediaName: "b.mp4",
						trimStartSec: 2,
						trimEndSec: 4,
						sourceDurationSec: 10,
					}),
					videoClip({
						id: "c",
						trackId: "track-main",
						startSec: 10,
						durationSec: 4,
						name: "c",
						mediaName: "c.mp4",
						sourceDurationSec: 4,
					}),
				],
			}),
			track({
				id: "track-audio",
				label: "A1",
				type: "audio",
				clips: [
					audioClip({
						id: "a-audio",
						trackId: "track-audio",
						startSec: 0,
						durationSec: 6,
						name: "a audio",
						linkId: "link-a",
						sourceDurationSec: 6,
					}),
				],
			}),
		],
		markers: [],
		...overrides,
	};
}

describe("cut_range", () => {
	test('scope "all" is one unscoped range on RemoveRangesCommand', () => {
		const result = plan(
			[
				{
					id: "1",
					name: "cut_range",
					args: { startSec: 2, endSec: 5, scope: "all" },
				},
			],
			threeClipSnapshot(),
		);
		expect(result.commands).toHaveLength(1);
		expect(result.commands[0]).toBeInstanceOf(RemoveRangesCommand);
		expect(
			peek<{ options: { ranges: unknown[] } }>(result.commands[0]).options.ranges,
		).toEqual([{ start: sec(2), end: sec(5) }]);
	});

	test('scope "main" scopes one range per lane: main plus the linked audio', () => {
		const result = plan(
			[
				{
					id: "1",
					name: "cut_range",
					args: { startSec: 1, endSec: 3, scope: "main" },
				},
			],
			threeClipSnapshot(),
		);
		expect(
			peek<{ options: { ranges: { trackId?: string }[] } }>(result.commands[0])
				.options.ranges,
		).toEqual([
			{ start: sec(1), end: sec(3), trackId: "track-main" },
			{ start: sec(1), end: sec(3), trackId: "track-audio" },
		]);
	});

	test('scope "main" leaves untouched lanes out when no linked clip overlaps', () => {
		const result = plan(
			[
				{
					id: "1",
					name: "cut_range",
					args: { startSec: 11, endSec: 13, scope: "main" },
				},
			],
			threeClipSnapshot(),
		);
		expect(
			peek<{ options: { ranges: { trackId?: string }[] } }>(result.commands[0])
				.options.ranges,
		).toEqual([{ start: sec(11), end: sec(13), trackId: "track-main" }]);
	});
});

describe("delete_clip", () => {
	test("takes the clip and its separated audio half in one command", () => {
		const result = plan(
			[{ id: "1", name: "delete_clip", args: { clipId: "a" } }],
			threeClipSnapshot(),
		);
		expect(result.commands).toHaveLength(1);
		expect(result.commands[0]).toBeInstanceOf(DeleteElementsCommand);
		expect(
			peek<{ elements: unknown[] }>(result.commands[0]).elements,
		).toEqual([
			{ trackId: "track-main", elementId: "a" },
			{ trackId: "track-audio", elementId: "a-audio" },
		]);
	});

	test("an unlinked clip deletes alone", () => {
		const result = plan(
			[{ id: "1", name: "delete_clip", args: { clipId: "b" } }],
			threeClipSnapshot(),
		);
		expect(peek<{ elements: unknown[] }>(result.commands[0]).elements).toEqual([
			{ trackId: "track-main", elementId: "b" },
		]);
	});
});

describe("extend_clip", () => {
	test("a positive delta on the end edge grows the clip and eats its trimEnd", () => {
		const result = plan(
			[
				{
					id: "1",
					name: "extend_clip",
					args: { clipId: "b", edge: "end", deltaSec: 2 },
				},
			],
			// c moved out of the way, so the neighbour does not bind the grow.
			threeClipSnapshot({
				tracks: threeClipSnapshot().tracks.map((entry) =>
					entry.isMain
						? { ...entry, clips: entry.clips.filter((clip) => clip.id !== "c") }
						: entry,
				),
			}),
		);
		expect(result.commands).toHaveLength(1);
		expect(result.commands[0]).toBeInstanceOf(UpdateElementsCommand);
		const [update] = peek<{
			updates: { elementId: string; patch: Record<string, MediaTime> }[];
		}>(result.commands[0]).updates;
		expect(update.elementId).toBe("b");
		expect(update.patch.startTime).toBe(sec(6));
		expect(update.patch.duration).toBe(sec(6));
		expect(update.patch.trimEnd).toBe(sec(2));
	});

	test("a left-edge grow on main with the magnet on pins the start and slides the tail", () => {
		const result = plan(
			[
				{
					id: "1",
					name: "extend_clip",
					args: { clipId: "b", edge: "start", deltaSec: 1 },
				},
			],
			threeClipSnapshot(),
		);
		expect(result.commands).toHaveLength(2);
		const [update] = peek<{
			updates: { elementId: string; patch: Record<string, MediaTime> }[];
		}>(result.commands[0]).updates;
		// Pinned: the head trim changed the content, never the position.
		expect(update.patch.startTime).toBe(sec(6));
		expect(update.patch.duration).toBe(sec(5));
		expect(update.patch.trimStart).toBe(sec(1));

		expect(result.commands[1]).toBeInstanceOf(RippleShiftElementsCommand);
		expect(peek<{ shifts: unknown[] }>(result.commands[1]).shifts).toEqual([
			{ trackId: "track-main", elementId: "c", newStartTime: sec(11) },
		]);
	});

	test("a left-edge shrink on main pulls the tail back instead", () => {
		const result = plan(
			[
				{
					id: "1",
					name: "extend_clip",
					args: { clipId: "b", edge: "start", deltaSec: -1 },
				},
			],
			threeClipSnapshot(),
		);
		const [update] = peek<{
			updates: { patch: Record<string, MediaTime> }[];
		}>(result.commands[0]).updates;
		expect(update.patch.startTime).toBe(sec(6));
		expect(update.patch.duration).toBe(sec(3));
		expect(peek<{ shifts: unknown[] }>(result.commands[1]).shifts).toEqual([
			{ trackId: "track-main", elementId: "c", newStartTime: sec(9) },
		]);
	});

	test("with the magnet off a left trim moves the start and shifts nothing", () => {
		const result = plan(
			[
				{
					id: "1",
					name: "extend_clip",
					args: { clipId: "b", edge: "start", deltaSec: -1 },
				},
			],
			threeClipSnapshot({ magnetEnabled: false }),
		);
		expect(result.commands).toHaveLength(1);
		const [update] = peek<{
			updates: { patch: Record<string, MediaTime> }[];
		}>(result.commands[0]).updates;
		expect(update.patch.startTime).toBe(sec(7));
		expect(update.patch.duration).toBe(sec(3));
	});

	test("a linked pair resizes as one gesture", () => {
		const result = plan(
			[
				{
					id: "1",
					name: "extend_clip",
					args: { clipId: "a", edge: "end", deltaSec: -2 },
				},
			],
			threeClipSnapshot(),
		);
		const updates = peek<{ updates: { elementId: string }[] }>(
			result.commands[0],
		).updates;
		expect(updates.map((update) => update.elementId)).toEqual(["a", "a-audio"]);
	});
});

describe("move_clip", () => {
	test("a magnet move onto main opens the hole before the move", () => {
		const result = plan(
			[
				{
					id: "1",
					name: "move_clip",
					args: { clipId: "c", toStartSec: 6 },
				},
			],
			threeClipSnapshot(),
		);
		expect(result.commands).toHaveLength(2);
		expect(result.commands[0]).toBeInstanceOf(RippleShiftElementsCommand);
		expect(peek<{ shifts: unknown[] }>(result.commands[0]).shifts).toEqual([
			{ trackId: "track-main", elementId: "b", newStartTime: sec(10) },
		]);
		expect(result.commands[1]).toBeInstanceOf(MoveElementCommand);
		expect(peek<{ moves: unknown[] }>(result.commands[1]).moves).toEqual([
			{
				elementId: "c",
				sourceTrackId: "track-main",
				targetTrackId: "track-main",
				newStartTime: sec(6),
			},
		]);
	});

	test("with the magnet off nothing is rippled", () => {
		const result = plan(
			[{ id: "1", name: "move_clip", args: { clipId: "c", toStartSec: 6 } }],
			threeClipSnapshot({ magnetEnabled: false }),
		);
		expect(result.commands).toHaveLength(1);
		expect(result.commands[0]).toBeInstanceOf(MoveElementCommand);
	});

	test("a linked partner moves by the same delta on its own lane", () => {
		const result = plan(
			[
				{
					id: "1",
					name: "move_clip",
					args: { clipId: "a", toStartSec: 2, toTrackId: "track-main" },
				},
			],
			threeClipSnapshot({ magnetEnabled: false }),
		);
		expect(peek<{ moves: unknown[] }>(result.commands[0]).moves).toEqual([
			{
				elementId: "a",
				sourceTrackId: "track-main",
				targetTrackId: "track-main",
				newStartTime: sec(2),
			},
			{
				elementId: "a-audio",
				sourceTrackId: "track-audio",
				targetTrackId: "track-audio",
				newStartTime: sec(2),
			},
		]);
	});

	test("toNewTrack adds a lane of the clip's own kind and moves onto it", () => {
		const result = plan(
			[
				{
					id: "1",
					name: "move_clip",
					args: { clipId: "b", toStartSec: 2, toNewTrack: true },
				},
			],
			threeClipSnapshot(),
		);
		expect(result.commands).toHaveLength(2);
		expect(result.commands[0]).toBeInstanceOf(AddTrackCommand);
		const addTrack = result.commands[0] as InstanceType<typeof AddTrackCommand>;
		expect(peek<{ type: string }>(addTrack).type).toBe("video");
		expect(result.commands[1]).toBeInstanceOf(MoveElementCommand);
		expect(
			peek<{ moves: { targetTrackId: string }[] }>(result.commands[1]).moves[0]
				.targetTrackId,
		).toBe(addTrack.getTrackId());
	});
});

describe("split_at, set_speed and the insert tools", () => {
	test("split_at splits the clip and any linked partner spanning the point", () => {
		const result = plan(
			[{ id: "1", name: "split_at", args: { clipId: "a", atSec: 3 } }],
			threeClipSnapshot(),
		);
		expect(result.commands[0]).toBeInstanceOf(SplitElementsCommand);
		const command = peek<{ elements: unknown[]; splitTime: MediaTime }>(
			result.commands[0],
		);
		expect(command.splitTime).toBe(sec(3));
		expect(command.elements).toEqual([
			{ trackId: "track-main", elementId: "a" },
			{ trackId: "track-audio", elementId: "a-audio" },
		]);
	});

	test("set_speed is one retime patch; the pipeline re-derives the duration", () => {
		const result = plan(
			[
				{
					id: "1",
					name: "set_speed",
					args: { clipId: "b", rate: 2, maintainPitch: true },
				},
			],
			threeClipSnapshot(),
		);
		expect(result.commands[0]).toBeInstanceOf(UpdateElementsCommand);
		expect(peek<{ updates: unknown[] }>(result.commands[0]).updates).toEqual([
			{
				trackId: "track-main",
				elementId: "b",
				patch: { retime: { rate: 2, maintainPitch: true } },
			},
		]);
	});

	test("add_text inserts one text element with the model's words and timing", () => {
		const result = plan(
			[
				{
					id: "1",
					name: "add_text",
					args: { text: "Hello", atSec: 30, durationSec: 5 },
				},
			],
			threeClipSnapshot(),
		);
		expect(result.commands).toHaveLength(1);
		expect(result.commands[0]).toBeInstanceOf(InsertElementCommand);
		const command = peek<{
			element: {
				type: string;
				startTime: MediaTime;
				duration: MediaTime;
				params: { content: string };
			};
			placement: { mode: string };
		}>(result.commands[0]);
		expect(command.element.type).toBe("text");
		expect(command.element.params.content).toBe("Hello");
		expect(command.element.startTime).toBe(sec(30));
		expect(command.element.duration).toBe(sec(5));
		expect(command.placement).toEqual({ mode: "auto" });
	});

	test("add_motion_template inserts every piece the registry builds", () => {
		const result = plan(
			[
				{
					id: "1",
					name: "add_motion_template",
					args: {
						templateId: "lower-third",
						atSec: 30,
						durationSec: 4,
						variables: { title: "Dan" },
					},
				},
			],
			threeClipSnapshot(),
		);
		expect(result.commands.length).toBeGreaterThan(0);
		for (const command of result.commands) {
			expect(command).toBeInstanceOf(InsertElementCommand);
			const built = peek<{
				element: {
					type: string;
					startTime: MediaTime;
					motionTemplate?: { templateId: string };
				};
			}>(command);
			expect(built.element.type).toBe("text");
			expect(built.element.startTime).toBe(sec(30));
			expect(built.element.motionTemplate?.templateId).toBe("lower-third");
		}
	});

	test("add_marker toggles a bookmark, and writes the note when there is one", () => {
		const result = plan(
			[{ id: "1", name: "add_marker", args: { atSec: 5, note: "hook" } }],
			threeClipSnapshot(),
		);
		expect(result.commands).toHaveLength(2);
		expect(result.commands[0]).toBeInstanceOf(ToggleBookmarkCommand);
		expect(peek<{ time: MediaTime }>(result.commands[0]).time).toBe(sec(5));
		expect(result.commands[1]).toBeInstanceOf(UpdateBookmarkCommand);
		expect(
			peek<{ updates: { note: string } }>(result.commands[1]).updates,
		).toEqual({ note: "hook" });
	});

	test("add_marker never toggles away a marker that is already there", () => {
		const result = plan(
			[{ id: "1", name: "add_marker", args: { atSec: 5, note: "hook" } }],
			threeClipSnapshot({ markers: [{ atTime: sec(5) }] }),
		);
		expect(result.commands).toHaveLength(1);
		expect(result.commands[0]).toBeInstanceOf(UpdateBookmarkCommand);
	});

	test("select_clips resolves ids to element refs", () => {
		const result = plan(
			[{ id: "1", name: "select_clips", args: { clipIds: ["b", "a"] } }],
			threeClipSnapshot(),
		);
		expect(result.commands[0]).toBeInstanceOf(SelectClipsCommand);
		expect(
			(result.commands[0] as InstanceType<typeof SelectClipsCommand>).getRefs(),
		).toEqual([
			{ trackId: "track-main", elementId: "b" },
			{ trackId: "track-main", elementId: "a" },
		]);
	});
});

describe("ask_user and the plan shape", () => {
	test("a turn with ask_user produces no commands and surfaces the question", () => {
		const result = plan(
			[
				{
					id: "1",
					name: "ask_user",
					args: { question: "The intro or the outro?", options: ["intro", "outro"] },
				},
			],
			threeClipSnapshot(),
		);
		expect(result.commands).toEqual([]);
		expect(result.mutatingCount).toBe(0);
		expect(result.question).toEqual({
			question: "The intro or the outro?",
			options: ["intro", "outro"],
		});
	});

	test("the plan totals its ops and the seconds they remove", () => {
		const result = plan(
			[
				{
					id: "1",
					name: "cut_range",
					args: { startSec: 1, endSec: 3, scope: "all" },
				},
				{ id: "2", name: "delete_clip", args: { clipId: "c" } },
				{ id: "3", name: "add_marker", args: { atSec: 2 } },
			],
			threeClipSnapshot(),
		);
		expect(result.mutatingCount).toBe(3);
		expect(result.destructiveSeconds).toBeCloseTo(6, 5);
		expect(result.ops.map((op) => op.summary)).toEqual([
			"Cut 1.0s to 3.0s across all tracks",
			'Delete "c.mp4"',
			"Add a marker at 0:02",
		]);
	});
});

describe("atomicity: one invalid call means nothing is planned", () => {
	test("validateTurn refuses the whole turn, so the executor is never reached", () => {
		const snapshot = threeClipSnapshot();
		const verdict = validateTurn({
			calls: [
				{ id: "1", name: "cut_range", args: { startSec: 1, endSec: 3 } },
				{ id: "2", name: "delete_clip", args: { clipId: "ghost" } },
				{ id: "3", name: "add_marker", args: { atSec: 2 } },
			],
			snapshot,
		});
		expect(verdict.ok).toBe(false);
		if (verdict.ok) throw new Error("expected a refusal");
		expect(verdict.call.id).toBe("2");
		expect(verdict.failure.code).toBe("unknown_clip");
		// The contract the turn service honors: planning only ever runs on
		// `verdict.calls`, which does not exist on a refusal, so zero commands
		// reach the editor.
		expect(plan([], snapshot).commands).toEqual([]);
	});

	test("a valid turn plans every call in order", () => {
		const snapshot = threeClipSnapshot();
		const verdict = validateTurn({
			calls: [
				{ id: "1", name: "cut_range", args: { startSec: 1, endSec: 3 } },
				{ id: "2", name: "delete_clip", args: { clipId: "c" } },
			],
			snapshot,
		});
		expect(verdict.ok).toBe(true);
		if (!verdict.ok) throw new Error("expected a pass");
		const result = plan(verdict.calls, snapshot);
		expect(result.commands[0]).toBeInstanceOf(RemoveRangesCommand);
		expect(result.commands[1]).toBeInstanceOf(DeleteElementsCommand);
	});
});

describe("the undo handle", () => {
	class FakeCommand {
		execute() {
			return undefined;
		}
	}

	function stubEditor() {
		const stack: unknown[] = [];
		const log: string[] = [];
		return {
			stack,
			log,
			command: {
				execute: ({ command }: { command: unknown }) => {
					stack.push(command);
					log.push("execute");
					return command as never;
				},
				undo: () => {
					stack.pop();
					log.push("undo");
				},
				peekUndoCommand: () =>
					(stack.length ? stack[stack.length - 1] : null) as never,
			},
		};
	}

	test("the applied batch can be undone while it is the stack top", () => {
		const editor = stubEditor();
		const batch = new FakeCommand() as never;
		editor.command.execute({ command: batch });
		const handle = buildAssistantUndoHandle({ editor, batch });
		expect(handle.canUndo()).toBe(true);
		expect(handle.undo()).toBe(true);
		expect(editor.log).toEqual(["execute", "undo"]);
	});

	test("a later command on top disables the handle, and undo refuses", () => {
		const editor = stubEditor();
		const batch = new FakeCommand() as never;
		editor.command.execute({ command: batch });
		const handle = buildAssistantUndoHandle({ editor, batch });
		editor.command.execute({ command: new FakeCommand() as never });
		expect(handle.canUndo()).toBe(false);
		expect(handle.undo()).toBe(false);
		expect(editor.log).toEqual(["execute", "execute"]);
	});

	test("an empty stack and a null batch both read as not-undoable", () => {
		expect(
			canUndoAssistantApply({ batch: null, topUndoCommand: null }),
		).toBe(false);
		expect(
			canUndoAssistantApply({
				batch: new FakeCommand() as never,
				topUndoCommand: null,
			}),
		).toBe(false);
	});
});

describe("execution wraps the whole turn in one batch", () => {
	test("nothing to apply reports null instead of pushing an empty batch", async () => {
		const { executeAssistantTurn } = await import("../executor");
		const log: string[] = [];
		const editor = {
			command: {
				execute: ({ command }: { command: unknown }) => {
					log.push("execute");
					return command as never;
				},
				undo: () => log.push("undo"),
				peekUndoCommand: () => null,
			},
		};
		const result = executeAssistantTurn({
			plan: plan(
				[{ id: "1", name: "ask_user", args: { question: "which?" } }],
				threeClipSnapshot(),
			),
			editor,
		});
		expect(result).toBeNull();
		expect(log).toEqual([]);
	});

	test("a mutating turn executes exactly once and reports its op count", async () => {
		const { executeAssistantTurn } = await import("../executor");
		const { BatchCommand } = await import("@/commands/batch-command");
		const executed: unknown[] = [];
		const editor = {
			command: {
				execute: ({ command }: { command: unknown }) => {
					executed.push(command);
					return command as never;
				},
				undo: () => undefined,
				peekUndoCommand: () =>
					(executed.length
						? executed[executed.length - 1]
						: null) as never,
			},
		};
		const result = executeAssistantTurn({
			plan: plan(
				[
					{
						id: "1",
						name: "cut_range",
						args: { startSec: 1, endSec: 3, scope: "all" },
					},
					{ id: "2", name: "add_marker", args: { atSec: 5 } },
				],
				threeClipSnapshot(),
			),
			editor,
		});
		expect(executed).toHaveLength(1);
		expect(executed[0]).toBeInstanceOf(BatchCommand);
		expect(result?.appliedCount).toBe(2);
		expect(result?.undo.canUndo()).toBe(true);
	});
});

describe("frame snapping matches the validators", () => {
	test("a validated second lands on the same tick the validator cleared", () => {
		const snapshot = threeClipSnapshot({ fps: FPS });
		const verdict = validateTurn({
			calls: [
				{ id: "1", name: "cut_range", args: { startSec: 1.017, endSec: 3.004 } },
			],
			snapshot,
		});
		if (!verdict.ok) throw new Error("expected a pass");
		const result = plan(verdict.calls, snapshot);
		const [range] = peek<{ options: { ranges: { start: number; end: number }[] } }>(
			result.commands[0],
		).options.ranges;
		// 30fps: one frame is 4000 ticks, so both edges sit on a frame boundary.
		expect(range.start % 4000).toBe(0);
		expect(range.end % 4000).toBe(0);
	});
});

describe("add_motion_template: smart defaults (T17.4)", () => {
	test("a gap the model left (no accent, no color, no font) is filled from the project background", () => {
		const snapshot = threeClipSnapshot({ background: "#ffffff" });
		const result = plan(
			[
				{
					id: "1",
					name: "add_motion_template",
					args: {
						templateId: "kinetic-title",
						atSec: 30,
						durationSec: 4,
						variables: { text: "TITLE" },
					},
				},
			],
			snapshot,
		);
		const [command] = result.commands;
		const built = peek<{ element: { params: { color: string; fontFamily?: string } } }>(
			command,
		);
		expect(built.element.params.color).toBe(pickForeground("#ffffff"));
	});

	test("a variable the model DID set always wins over the default", () => {
		const snapshot = threeClipSnapshot({ background: "#ffffff" });
		const result = plan(
			[
				{
					id: "1",
					name: "add_motion_template",
					args: {
						templateId: "lower-third",
						atSec: 30,
						durationSec: 4,
						variables: { title: "Dan", accent: "#123456" },
					},
				},
			],
			snapshot,
		);
		const [command] = result.commands;
		const built = peek<{
			element: { params: { "background.color": string } };
		}>(command);
		expect(built.element.params["background.color"]).toBe("#123456");
	});

	test("an unset accent is filled from the project palette instead of the fixed look accent", () => {
		const snapshot = threeClipSnapshot({ background: "#000000" });
		const result = plan(
			[
				{
					id: "1",
					name: "add_motion_template",
					args: {
						templateId: "lower-third",
						atSec: 30,
						durationSec: 4,
						variables: { title: "Dan" },
					},
				},
			],
			snapshot,
		);
		const [command] = result.commands;
		const built = peek<{
			element: { params: { "background.color": string } };
		}>(command);
		expect(built.element.params["background.color"]).toBe(deriveAccent("#000000"));
	});
});

describe("show-me mode: the additive-only predicate (T17.4)", () => {
	test("a turn of only add_text / add_motion_template calls is additive-only", () => {
		const calls: ValidatedToolCall[] = [
			{
				id: "1",
				name: "add_text",
				args: { text: "Hi", atSec: 5, durationSec: 3 },
			},
			{
				id: "2",
				name: "add_motion_template",
				args: {
					templateId: "kinetic-title",
					atSec: 10,
					durationSec: 4,
					variables: {},
				},
			},
		];
		expect(isAdditiveOnlyTurn(calls)).toBe(true);
	});

	test("any destructive or other call disqualifies the whole turn", () => {
		const calls: ValidatedToolCall[] = [
			{ id: "1", name: "add_text", args: { text: "Hi", atSec: 5, durationSec: 3 } },
			{ id: "2", name: "delete_clip", args: { clipId: "a" } },
		];
		expect(isAdditiveOnlyTurn(calls)).toBe(false);
	});

	test("select_clips alone does not count as additive-only either", () => {
		const calls: ValidatedToolCall[] = [
			{ id: "1", name: "select_clips", args: { clipIds: ["a"] } },
		];
		expect(isAdditiveOnlyTurn(calls)).toBe(false);
	});

	test("an empty turn is not additive-only: there is nothing to show", () => {
		expect(isAdditiveOnlyTurn([])).toBe(false);
	});

	test("earliestInsertStart picks the smallest atSec among the insert calls", () => {
		const snapshot = threeClipSnapshot({ fps: FPS });
		const calls: ValidatedToolCall[] = [
			{
				id: "1",
				name: "add_motion_template",
				args: { templateId: "kinetic-title", atSec: 10, durationSec: 4, variables: {} },
			},
			{ id: "2", name: "add_text", args: { text: "Hi", atSec: 4, durationSec: 3 } },
		];
		expect(earliestInsertStart({ calls, snapshot })).toBe(sec(4));
	});

	test("earliestInsertStart is null when nothing in the turn inserts anything", () => {
		const snapshot = threeClipSnapshot({ fps: FPS });
		const calls: ValidatedToolCall[] = [{ id: "1", name: "delete_clip", args: { clipId: "a" } }];
		expect(earliestInsertStart({ calls, snapshot })).toBeNull();
	});
});

describe("show-me mode: the post-apply hook", () => {
	function playbackStub() {
		const log: string[] = [];
		const seeks: MediaTime[] = [];
		return {
			log,
			seeks,
			playback: {
				seek: ({ time }: { time: MediaTime }) => {
					log.push("seek");
					seeks.push(time);
				},
				pause: () => log.push("pause"),
			},
		};
	}

	test("seeks and pauses on an additive-only turn", () => {
		const snapshot = threeClipSnapshot({ fps: FPS });
		const stub = playbackStub();
		const editor = {
			command: {
				execute: (({ command }: { command: unknown }) => command) as never,
				undo: () => undefined,
				peekUndoCommand: () => null,
			},
			playback: stub.playback,
		};
		showInsertedElement({
			calls: [{ id: "1", name: "add_text", args: { text: "Hi", atSec: 4, durationSec: 3 } }],
			snapshot,
			editor,
		});
		expect(stub.log).toEqual(["seek", "pause"]);
		expect(stub.seeks).toEqual([sec(4)]);
	});

	test("does nothing for a destructive or mixed turn", () => {
		const snapshot = threeClipSnapshot({ fps: FPS });
		const stub = playbackStub();
		const editor = {
			command: {
				execute: (({ command }: { command: unknown }) => command) as never,
				undo: () => undefined,
				peekUndoCommand: () => null,
			},
			playback: stub.playback,
		};
		showInsertedElement({
			calls: [
				{ id: "1", name: "add_text", args: { text: "Hi", atSec: 4, durationSec: 3 } },
				{ id: "2", name: "delete_clip", args: { clipId: "a" } },
			],
			snapshot,
			editor,
		});
		expect(stub.log).toEqual([]);
	});

	test("is a no-op when the editor has no playback stub (existing tests keep working)", () => {
		const snapshot = threeClipSnapshot({ fps: FPS });
		const editor = {
			command: {
				execute: (({ command }: { command: unknown }) => command) as never,
				undo: () => undefined,
				peekUndoCommand: () => null,
			},
		};
		expect(() =>
			showInsertedElement({
				calls: [{ id: "1", name: "add_text", args: { text: "Hi", atSec: 4, durationSec: 3 } }],
				snapshot,
				editor,
			}),
		).not.toThrow();
	});
});
