import { describe, expect, mock, test } from "bun:test";
import type { AssistantContext } from "../context";
import type { TimelineSnapshot } from "../snapshot";
import type {
	AssistantTurnRequest,
	AssistantTurnResponse,
	ToolCall,
} from "../types";
import { sec, smallSnapshot } from "./fixtures";

/** Same reason as executor.test.ts: `AddTrackCommand` reads the editor in its
 * constructor. Nothing here executes a command; the editor is a stub stack. */
mock.module("@/core", () => ({
	EditorCore: {
		getInstance: () => ({ scenes: { getActiveSceneOrNull: () => null } }),
	},
}));

const {
	createAssistantTurnDriver,
	MAX_UNCONFIRMED_DESTRUCTIVE_SEC,
	MAX_UNCONFIRMED_OPS,
	needsConfirmation,
} = await import("../turn-service");
const { planAssistantTurn } = await import("../executor");

const PROMPT_VERSION = 1;

function response(
	overrides: Partial<AssistantTurnResponse> = {},
): AssistantTurnResponse {
	return {
		text: "",
		toolCalls: [],
		question: null,
		stopReason: "end_turn",
		usage: null,
		promptVersion: PROMPT_VERSION,
		model: "test-model",
		...overrides,
	};
}

function call(name: string, args: Record<string, unknown>, id = name): ToolCall {
	return { id, name, args };
}

/** A stub stack that only records identities, exactly like the Director dock's
 * test harness. Commands are never executed. */
function stubEditor() {
	const stack: unknown[] = [];
	const log: string[] = [];
	return {
		stack,
		log,
		command: {
			execute: ({ command }: { command: unknown }) => {
				log.push("execute");
				stack.push(command);
				return command as never;
			},
			undo: () => {
				log.push("undo");
				stack.pop();
			},
			peekUndoCommand: () =>
				(stack.length ? stack[stack.length - 1] : null) as never,
		},
	};
}

interface Harness {
	driver: ReturnType<typeof createAssistantTurnDriver>;
	events: Array<Record<string, unknown>>;
	requests: AssistantTurnRequest[];
	editor: ReturnType<typeof stubEditor>;
	snapshots: TimelineSnapshot[];
}

/**
 * `responses` are handed out in order, one per round-trip. `snapshotFor` lets a
 * test change the timeline between the reasoning read and the execute read.
 */
function harness({
	responses,
	snapshotFor = () => smallSnapshot(),
}: {
	responses: AssistantTurnResponse[];
	snapshotFor?: (readIndex: number) => TimelineSnapshot;
}): Harness {
	const events: Array<Record<string, unknown>> = [];
	const requests: AssistantTurnRequest[] = [];
	const snapshots: TimelineSnapshot[] = [];
	const editor = stubEditor();
	let readIndex = 0;
	let responseIndex = 0;
	const driver = createAssistantTurnDriver({
		collect: () => {
			const snapshot = snapshotFor(readIndex);
			readIndex += 1;
			snapshots.push(snapshot);
			return { snapshot, context: {} as AssistantContext };
		},
		request: async (request) => {
			requests.push(request);
			const next = responses[responseIndex];
			responseIndex += 1;
			if (!next) throw new Error("the driver asked for one round-trip too many");
			return next;
		},
		editor,
	});
	driver.events.subscribe((event) =>
		events.push(event as unknown as Record<string, unknown>),
	);
	return { driver, events, requests, editor, snapshots };
}

const CUT = call("cut_range", { startSec: 1, endSec: 2 });

describe("happy path", () => {
	test("one tool round-trip, one batch, then the closing summary", async () => {
		const h = harness({
			responses: [
				response({ text: "Cutting that now.", toolCalls: [CUT] }),
				response({ text: "Done: removed one second." }),
			],
		});
		await h.driver.start("cut one second at 1s");

		expect(h.requests).toHaveLength(2);
		expect(h.editor.log).toEqual(["execute"]);
		expect(h.events).toEqual([
			{ type: "text", text: "Cutting that now.", promptVersion: 1 },
			{
				type: "applied",
				count: 1,
				summaries: ["Cut 1.0s to 2.0s across all tracks"],
				undo: expect.anything(),
			},
			{ type: "text", text: "Done: removed one second.", promptVersion: 1 },
		]);
	});

	test("the second round-trip carries the successful tool results", async () => {
		const h = harness({
			responses: [response({ toolCalls: [CUT] }), response({ text: "Done." })],
		});
		await h.driver.start("cut it");
		expect(h.requests[1].toolResults).toEqual([
			{
				toolCallId: "cut_range",
				ok: true,
				summary: "Cut 1.0s to 2.0s across all tracks",
			},
		]);
	});

	test("the applied event carries a working undo handle", async () => {
		const h = harness({
			responses: [response({ toolCalls: [CUT] }), response({ text: "Done." })],
		});
		await h.driver.start("cut it");
		const applied = h.events.find((event) => event.type === "applied") as {
			undo: { canUndo: () => boolean; undo: () => boolean };
		};
		expect(applied.undo.canUndo()).toBe(true);
		expect(applied.undo.undo()).toBe(true);
		expect(h.editor.log).toEqual(["execute", "undo"]);
	});

	test("a pure text turn emits the text and never calls back", async () => {
		const h = harness({ responses: [response({ text: "Nothing to change." })] });
		await h.driver.start("what is on the timeline?");
		expect(h.requests).toHaveLength(1);
		expect(h.editor.log).toEqual([]);
		expect(h.events).toEqual([
			{ type: "text", text: "Nothing to change.", promptVersion: 1 },
		]);
	});

	test("the conversation keeps both sides of every turn", async () => {
		const h = harness({
			responses: [response({ toolCalls: [CUT] }), response({ text: "Done." })],
		});
		await h.driver.start("cut it");
		expect(h.driver.getMessages()).toEqual([
			{ role: "user", content: "cut it" },
			{ role: "assistant", content: "", toolCalls: [CUT] },
			{ role: "assistant", content: "Done." },
		]);
		expect(h.driver.getPromptVersion()).toBe(PROMPT_VERSION);
	});
});

describe("clarifying question", () => {
	test("ask_user produces no batch and waits for a reply", async () => {
		const h = harness({
			responses: [
				response({
					toolCalls: [call("ask_user", { question: "The intro or the outro?" })],
					question: "The intro or the outro?",
					questionOptions: ["intro", "outro"],
				}),
			],
		});
		await h.driver.start("cut the boring part");

		expect(h.requests).toHaveLength(1);
		expect(h.editor.log).toEqual([]);
		expect(h.events).toEqual([
			{
				type: "clarifying-question",
				question: "The intro or the outro?",
				options: ["intro", "outro"],
				promptVersion: 1,
			},
		]);
	});

	test("reply continues the same conversation", async () => {
		const h = harness({
			responses: [
				response({ question: "Which one?", toolCalls: [call("ask_user", {})] }),
				response({ toolCalls: [CUT] }),
				response({ text: "Done." }),
			],
		});
		await h.driver.start("cut the boring part");
		await h.driver.reply("the intro");
		expect(h.driver.getMessages()[2]).toEqual({
			role: "user",
			content: "the intro",
		});
		expect(h.editor.log).toEqual(["execute"]);
	});
});

describe("validation failure", () => {
	test("nothing is applied, the reason is surfaced verbatim, and it feeds back", async () => {
		const h = harness({
			responses: [
				response({
					toolCalls: [call("delete_clip", { clipId: "ghost" })],
				}),
				response({ text: "Sorry, I could not find that clip." }),
			],
		});
		await h.driver.start("delete the ghost clip");

		expect(h.editor.log).toEqual([]);
		const error = h.events.find((event) => event.type === "error");
		expect(error?.reason).toBe(
			"There is no clip with id ghost on this timeline.",
		);
		expect(h.requests[1].toolResults).toEqual([
			{
				toolCallId: "delete_clip",
				ok: false,
				summary: "There is no clip with id ghost on this timeline.",
			},
		]);
	});

	test("the model gets exactly one retry, and a good retry applies", async () => {
		const h = harness({
			responses: [
				response({ toolCalls: [call("delete_clip", { clipId: "ghost" })] }),
				response({ toolCalls: [CUT] }),
				response({ text: "Done on the second try." }),
			],
		});
		await h.driver.start("delete the ghost clip");
		expect(h.editor.log).toEqual(["execute"]);
		expect(h.events.map((event) => event.type)).toEqual([
			"error",
			"applied",
			"text",
		]);
	});

	test("a second failure closes the turn instead of looping", async () => {
		const h = harness({
			responses: [
				response({ toolCalls: [call("delete_clip", { clipId: "ghost" })] }),
				response({ toolCalls: [call("delete_clip", { clipId: "ghost2" })] }),
				response({ text: "I give up." }),
			],
		});
		await h.driver.start("delete the ghost clip");
		// Three round-trips total: the original, the one retry, and the close.
		expect(h.requests).toHaveLength(3);
		expect(h.editor.log).toEqual([]);
		expect(h.events.map((event) => event.type)).toEqual([
			"error",
			"error",
			"text",
		]);
	});

	test("other calls in a refused turn report as not applied", async () => {
		const h = harness({
			responses: [
				response({
					toolCalls: [CUT, call("delete_clip", { clipId: "ghost" })],
				}),
				response({ text: "ok" }),
				response({ text: "ok" }),
			],
		});
		await h.driver.start("cut and delete");
		expect(h.editor.log).toEqual([]);
		expect(h.requests[1].toolResults).toEqual([
			{
				toolCallId: "cut_range",
				ok: false,
				summary: "Not applied: another change in the same turn was refused.",
			},
			{
				toolCallId: "delete_clip",
				ok: false,
				summary: "There is no clip with id ghost on this timeline.",
			},
		]);
	});
});

describe("the confirmation thresholds", () => {
	const marker = (index: number) =>
		call("add_marker", { atSec: index + 1 }, `m${index}`);

	test("needsConfirmation is a strict > on both thresholds", () => {
		const snapshot = smallSnapshot();
		const under = planAssistantTurn({
			calls: [
				{ id: "1", name: "add_marker", args: { atSec: 1 } },
				{ id: "2", name: "add_marker", args: { atSec: 2 } },
				{ id: "3", name: "add_marker", args: { atSec: 3 } },
			],
			snapshot,
		});
		expect(under.mutatingCount).toBe(MAX_UNCONFIRMED_OPS);
		expect(needsConfirmation(under)).toBe(false);

		const over = planAssistantTurn({
			calls: [
				{ id: "1", name: "add_marker", args: { atSec: 1 } },
				{ id: "2", name: "add_marker", args: { atSec: 2 } },
				{ id: "3", name: "add_marker", args: { atSec: 3 } },
				{ id: "4", name: "add_marker", args: { atSec: 4 } },
			],
			snapshot,
		});
		expect(over.mutatingCount).toBe(MAX_UNCONFIRMED_OPS + 1);
		expect(needsConfirmation(over)).toBe(true);
	});

	test("exactly ten removed seconds still applies immediately", () => {
		const plan = planAssistantTurn({
			calls: [
				{
					id: "1",
					name: "cut_range",
					args: { startSec: 0, endSec: MAX_UNCONFIRMED_DESTRUCTIVE_SEC, scope: "all" },
				},
			],
			snapshot: smallSnapshot(),
		});
		expect(plan.destructiveSeconds).toBeCloseTo(
			MAX_UNCONFIRMED_DESTRUCTIVE_SEC,
			5,
		);
		expect(needsConfirmation(plan)).toBe(false);
	});

	test("one frame past ten seconds needs a confirm", () => {
		const plan = planAssistantTurn({
			calls: [
				{
					id: "1",
					name: "cut_range",
					args: { startSec: 0, endSec: 10.5, scope: "all" },
				},
			],
			snapshot: smallSnapshot(),
		});
		expect(needsConfirmation(plan)).toBe(true);
	});

	test("a small turn applies without asking", async () => {
		const h = harness({
			responses: [
				response({ toolCalls: [marker(0), marker(1), marker(2)] }),
				response({ text: "Done." }),
			],
		});
		await h.driver.start("add three markers");
		expect(h.events.map((event) => event.type)).toEqual(["applied", "text"]);
		expect(h.driver.isAwaitingConfirmation()).toBe(false);
	});

	test("a four-op turn is held, then confirm applies it as one batch", async () => {
		const h = harness({
			responses: [
				response({ toolCalls: [marker(0), marker(1), marker(2), marker(3)] }),
				response({ text: "Done." }),
			],
		});
		await h.driver.start("add four markers");
		expect(h.editor.log).toEqual([]);
		expect(h.requests).toHaveLength(1);
		expect(h.driver.isAwaitingConfirmation()).toBe(true);
		expect(h.events).toEqual([
			{
				type: "proposed-ops",
				summaries: [
					"Add a marker at 0:01",
					"Add a marker at 0:02",
					"Add a marker at 0:03",
					"Add a marker at 0:04",
				],
			},
		]);

		await h.driver.confirm();
		expect(h.editor.log).toEqual(["execute"]);
		expect(h.driver.isAwaitingConfirmation()).toBe(false);
		expect(h.events.map((event) => event.type)).toEqual([
			"proposed-ops",
			"applied",
			"text",
		]);
	});

	test("a long cut is held even though it is a single op", async () => {
		const h = harness({
			responses: [
				response({ toolCalls: [call("cut_range", { startSec: 0, endSec: 14 })] }),
				response({ text: "Done." }),
			],
		});
		await h.driver.start("cut the first fourteen seconds");
		expect(h.events.map((event) => event.type)).toEqual(["proposed-ops"]);
	});

	test("cancel discards the turn: nothing applies, and confirm is a no-op after", async () => {
		const h = harness({
			responses: [
				response({ toolCalls: [marker(0), marker(1), marker(2), marker(3)] }),
			],
		});
		await h.driver.start("add four markers");
		h.driver.cancel();
		expect(h.driver.isAwaitingConfirmation()).toBe(false);
		await h.driver.confirm();
		expect(h.editor.log).toEqual([]);
		expect(h.requests).toHaveLength(1);
	});

	test("a new prompt clears a held turn", async () => {
		const h = harness({
			responses: [
				response({ toolCalls: [marker(0), marker(1), marker(2), marker(3)] }),
				response({ text: "Never mind then." }),
			],
		});
		await h.driver.start("add four markers");
		expect(h.driver.isAwaitingConfirmation()).toBe(true);
		await h.driver.start("actually, forget it");
		expect(h.driver.isAwaitingConfirmation()).toBe(false);
		expect(h.editor.log).toEqual([]);
	});
});

describe("the execute-time snapshot", () => {
	test("a timeline that changed between reasoning and applying blocks the batch", async () => {
		const h = harness({
			responses: [
				response({ toolCalls: [call("delete_clip", { clipId: "clip-body" })] }),
				response({ text: "I could not do that." }),
			],
			// Reads 0 and 1 see the clip; the execute-time read (2) does not.
			snapshotFor: (readIndex) =>
				readIndex < 2
					? smallSnapshot()
					: smallSnapshot({
							tracks: smallSnapshot().tracks.map((entry) =>
								entry.isMain
									? {
											...entry,
											clips: entry.clips.filter(
												(clip) => clip.id !== "clip-body",
											),
										}
									: entry,
							),
						}),
		});
		await h.driver.start("delete the body clip");

		expect(h.editor.log).toEqual([]);
		expect(h.events.map((event) => event.type)).toEqual(["error", "text"]);
		expect(h.requests[1].toolResults).toEqual([
			{
				toolCallId: "delete_clip",
				ok: false,
				summary: "The timeline changed, so nothing was applied.",
			},
		]);
	});

	test("every read is a fresh snapshot, never a cached one", async () => {
		const h = harness({
			responses: [response({ toolCalls: [CUT] }), response({ text: "Done." })],
		});
		await h.driver.start("cut it");
		// Context read, reasoning read, execute read, closing context read.
		expect(h.snapshots).toHaveLength(4);
		expect(h.snapshots[0]).not.toBe(h.snapshots[1]);
	});
});

describe("transport failures", () => {
	test("a throwing transport becomes one error event and applies nothing", async () => {
		const events: Array<Record<string, unknown>> = [];
		const editor = stubEditor();
		const driver = createAssistantTurnDriver({
			collect: () => ({
				snapshot: smallSnapshot(),
				context: {} as AssistantContext,
			}),
			request: async () => {
				throw new Error("Groq key rejected - check your key.");
			},
			editor,
		});
		driver.events.subscribe((event) =>
			events.push(event as unknown as Record<string, unknown>),
		);
		await driver.start("cut it");
		expect(events).toEqual([
			{ type: "error", reason: "Groq key rejected - check your key." },
		]);
		expect(editor.log).toEqual([]);
		expect(driver.isBusy()).toBe(false);
	});
});

describe("the snapshot fixture is what these tests think it is", () => {
	test("the small project runs sixteen seconds", () => {
		expect(smallSnapshot().totalDuration).toBe(sec(16));
	});
});
