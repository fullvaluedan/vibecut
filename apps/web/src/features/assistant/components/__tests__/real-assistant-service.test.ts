import { describe, expect, test } from "bun:test";
import type { AssistantTurnDriver, AssistantTurnEvent } from "../../turn-service";
import {
	createAssistantServiceFromDriver,
	isMockFlagValue,
	isAssistantMockForced,
} from "../real-assistant-service";
import type { AssistantEvent } from "../assistant-service";

/**
 * Adapter tests only (round 17 integration): everything here drives
 * `createAssistantServiceFromDriver` against a hand-built stub
 * `AssistantTurnDriver`, never the real `turn-service.ts` executor - that
 * module already has its own suite (`../__tests__/turn-service.test.ts`).
 * This file is purely about the bridge: event field mapping, the
 * subscribe -> async-generator plumbing, and confirm/cancel routing.
 */

interface StubDriver {
	driver: AssistantTurnDriver;
	calls: string[];
	setNextEmits: (events: AssistantTurnEvent[]) => void;
	setThrows: (message: string | null) => void;
}

function makeStubDriver(): StubDriver {
	const listeners = new Set<(event: AssistantTurnEvent) => void>();
	const calls: string[] = [];
	let nextEmits: AssistantTurnEvent[] = [];
	let throwMessage: string | null = null;

	const emitAll = () => {
		for (const event of nextEmits) {
			for (const listener of listeners) listener(event);
		}
	};

	const driver: AssistantTurnDriver = {
		async start(prompt) {
			calls.push(`start:${prompt}`);
			emitAll();
			if (throwMessage) throw new Error(throwMessage);
		},
		async confirm() {
			calls.push("confirm");
			emitAll();
			if (throwMessage) throw new Error(throwMessage);
		},
		cancel() {
			calls.push("cancel");
		},
		async reply(text) {
			calls.push(`reply:${text}`);
			emitAll();
		},
		events: {
			subscribe(listener) {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			},
		},
		isBusy: () => false,
		isAwaitingConfirmation: () => false,
		getMessages: () => [],
		getPromptVersion: () => null,
	};

	return {
		driver,
		calls,
		setNextEmits: (events) => {
			nextEmits = events;
		},
		setThrows: (message) => {
			throwMessage = message;
		},
	};
}

async function collect(gen: AsyncGenerator<AssistantEvent>): Promise<AssistantEvent[]> {
	const out: AssistantEvent[] = [];
	for await (const event of gen) out.push(event);
	return out;
}

describe("createAssistantServiceFromDriver - event mapping", () => {
	test("text: non-empty text becomes one text-delta, not fake token streaming", async () => {
		const stub = makeStubDriver();
		stub.setNextEmits([{ type: "text", text: "Hello there", promptVersion: 1 }]);
		const events = await collect(
			createAssistantServiceFromDriver(stub.driver).sendTurn({ prompt: "hi", history: [] }),
		);
		expect(events).toEqual([{ type: "text-delta", delta: "Hello there" }]);
	});

	test("text: empty text is dropped rather than landing a blank bubble", async () => {
		const stub = makeStubDriver();
		stub.setNextEmits([{ type: "text", text: "", promptVersion: 1 }]);
		const events = await collect(
			createAssistantServiceFromDriver(stub.driver).sendTurn({ prompt: "hi", history: [] }),
		);
		expect(events).toEqual([]);
	});

	test("clarifying-question: options become quickReplies", async () => {
		const stub = makeStubDriver();
		stub.setNextEmits([
			{ type: "clarifying-question", question: "Which one?", options: ["A", "B"], promptVersion: 1 },
		]);
		const events = await collect(
			createAssistantServiceFromDriver(stub.driver).sendTurn({ prompt: "hi", history: [] }),
		);
		expect(events).toEqual([
			{ type: "clarifying-question", question: "Which one?", quickReplies: ["A", "B"] },
		]);
	});

	test("clarifying-question: no options omits quickReplies entirely", async () => {
		const stub = makeStubDriver();
		stub.setNextEmits([{ type: "clarifying-question", question: "Which one?", promptVersion: 1 }]);
		const [event] = await collect(
			createAssistantServiceFromDriver(stub.driver).sendTurn({ prompt: "hi", history: [] }),
		);
		expect(event).toEqual({ type: "clarifying-question", question: "Which one?" });
	});

	test("proposed-ops: summaries become ops with a derived id, icon, and timecode", async () => {
		const stub = makeStubDriver();
		stub.setNextEmits([
			{
				type: "proposed-ops",
				summaries: [
					'Cut 2.0s to 5.0s on the main track',
					'Delete "B-roll 2"',
					'Move "clip" to 0:12 on a new lane',
					'Set "clip" to 2x speed',
					'Add the text "Welcome" at 0:05',
					'Add a marker at 1:00',
					"Select 2 clips",
				],
			},
		]);
		const [event] = await collect(
			createAssistantServiceFromDriver(stub.driver).sendTurn({ prompt: "hi", history: [] }),
		);
		if (event?.type !== "proposed-ops") throw new Error("expected a proposed-ops event");
		expect(event.ops).toHaveLength(7);
		expect(event.ops[0]).toMatchObject({
			icon: "cut",
			summary: "Cut 2.0s to 5.0s on the main track",
			timecode: "2.0s - 5.0s",
		});
		expect(event.ops[1]).toMatchObject({ icon: "delete", timecode: "" });
		expect(event.ops[2]).toMatchObject({ icon: "move", timecode: "0:12" });
		expect(event.ops[3]).toMatchObject({ icon: "speed" });
		expect(event.ops[4]).toMatchObject({ icon: "text", timecode: "0:05" });
		expect(event.ops[5]).toMatchObject({ icon: "marker", timecode: "1:00" });
		expect(event.ops[6]).toMatchObject({ icon: "marker" });
		// Every op in the list gets a distinct id, even across ops with the same icon.
		expect(new Set(event.ops.map((op) => op.id)).size).toBe(7);
	});

	test("applied: the undo handle becomes a plain () => void", async () => {
		const stub = makeStubDriver();
		let undoCalled = false;
		stub.setNextEmits([
			{
				type: "applied",
				count: 2,
				summaries: ["a", "b"],
				undo: {
					canUndo: () => true,
					undo: () => {
						undoCalled = true;
						return true;
					},
				},
			},
		]);
		const [event] = await collect(
			createAssistantServiceFromDriver(stub.driver).sendTurn({ prompt: "hi", history: [] }),
		);
		if (event?.type !== "applied") throw new Error("expected an applied event");
		expect(event.count).toBe(2);
		expect(typeof event.undo).toBe("function");
		expect(event.undo()).toBeUndefined();
		expect(undoCalled).toBe(true);
	});

	test("error: an ordinary reason passes through unchanged", async () => {
		const stub = makeStubDriver();
		stub.setNextEmits([
			{ type: "error", reason: "The timeline changed, so nothing was applied." },
		]);
		const events = await collect(
			createAssistantServiceFromDriver(stub.driver).sendTurn({ prompt: "hi", history: [] }),
		);
		expect(events).toEqual([
			{ type: "error", message: "The timeline changed, so nothing was applied." },
		]);
	});

	test("error: the missing-Anthropic-key reason becomes the friendly Settings pointer", async () => {
		const stub = makeStubDriver();
		stub.setNextEmits([
			{
				type: "error",
				reason:
					"Prompt-to-edit needs an Anthropic API key. Add one in Settings → AI (the editing tools use Anthropic's tool calling, which the other connection modes do not offer yet).",
			},
		]);
		const events = await collect(
			createAssistantServiceFromDriver(stub.driver).sendTurn({ prompt: "hi", history: [] }),
		);
		expect(events).toEqual([
			{
				type: "error",
				message: "The assistant needs an Anthropic key - add one in Settings > AI.",
			},
		]);
	});

	test("error: a thrown driver rejection is mapped and surfaced too", async () => {
		const stub = makeStubDriver();
		stub.setNextEmits([]);
		stub.setThrows("Prompt-to-edit needs an Anthropic API key. Add one in Settings.");
		const events = await collect(
			createAssistantServiceFromDriver(stub.driver).sendTurn({ prompt: "hi", history: [] }),
		);
		expect(events).toEqual([
			{
				type: "error",
				message: "The assistant needs an Anthropic key - add one in Settings > AI.",
			},
		]);
	});
});

describe("createAssistantServiceFromDriver - confirm/cancel routing", () => {
	test("a plain prompt calls driver.start with the prompt text", async () => {
		const stub = makeStubDriver();
		await collect(
			createAssistantServiceFromDriver(stub.driver).sendTurn({ prompt: "cut the intro", history: [] }),
		);
		expect(stub.calls).toEqual(["start:cut the intro"]);
	});

	test("confirmedOps calls driver.confirm(), never driver.start()", async () => {
		const stub = makeStubDriver();
		await collect(
			createAssistantServiceFromDriver(stub.driver).sendTurn({
				prompt: "",
				history: [],
				confirmedOps: [{ id: "op-1", icon: "cut", summary: "Cut 1s to 2s", timecode: "1s - 2s" }],
			}),
		);
		expect(stub.calls).toEqual(["confirm"]);
	});
});

describe("mock-flag selection", () => {
	test("isMockFlagValue: only the literal \"1\" forces the mock", () => {
		expect(isMockFlagValue("1")).toBe(true);
		expect(isMockFlagValue("true")).toBe(false);
		expect(isMockFlagValue("0")).toBe(false);
		expect(isMockFlagValue(null)).toBe(false);
		expect(isMockFlagValue("")).toBe(false);
	});

	test("isAssistantMockForced: never throws even with no localStorage at all (bun's test runtime)", () => {
		expect(() => isAssistantMockForced()).not.toThrow();
		expect(isAssistantMockForced()).toBe(false);
	});
});
