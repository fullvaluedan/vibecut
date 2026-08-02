import { describe, expect, test } from "bun:test";
import {
	applyAssistantEvent,
	canUseQuickReply,
	capMessages,
	consumeQuickReply,
	createInitialAssistantChatState,
	endTurnStream,
	isComposerDisabled,
	resolveConfirmation,
	shouldAutofocusComposer,
	startAssistantTurn,
	type AssistantChatState,
	type AssistantMessage,
} from "../assistant-reducer";

const NOW = 1_700_000_000_000;

function begin(userText = "cut the silence") {
	return startAssistantTurn({
		state: createInitialAssistantChatState(),
		turnId: "t1",
		userText,
		now: NOW,
	});
}

describe("startAssistantTurn", () => {
	test("appends a user message and a streaming placeholder", () => {
		const { state, assistantMessageId } = begin("hello");
		expect(state.messages).toHaveLength(2);
		expect(state.messages[0]).toMatchObject({ role: "user", text: "hello" });
		expect(state.messages[1]).toMatchObject({
			id: assistantMessageId,
			role: "assistant",
			kind: "text",
			text: "",
		});
		expect(state.turnStatus).toBe("streaming");
		expect(state.activeTurnId).toBe("t1");
	});
});

describe("applyAssistantEvent - every event type", () => {
	test("text-delta accumulates onto the placeholder", () => {
		const { state: s0, assistantMessageId } = begin();
		const s1 = applyAssistantEvent({
			state: s0,
			turnId: "t1",
			assistantMessageId,
			event: { type: "text-delta", delta: "Hello" },
			now: NOW,
		});
		const s2 = applyAssistantEvent({
			state: s1,
			turnId: "t1",
			assistantMessageId,
			event: { type: "text-delta", delta: " world" },
			now: NOW,
		});
		const msg = s2.messages.find((m) => m.id === assistantMessageId);
		expect(msg?.text).toBe("Hello world");
		expect(s2.turnStatus).toBe("streaming");
	});

	test("clarifying-question sets awaiting-clarification with quick replies", () => {
		const { state: s0, assistantMessageId } = begin();
		const s1 = applyAssistantEvent({
			state: s0,
			turnId: "t1",
			assistantMessageId,
			event: {
				type: "clarifying-question",
				question: "Which part?",
				quickReplies: ["A", "B"],
			},
			now: NOW,
		});
		const msg = s1.messages.find((m) => m.id === assistantMessageId);
		expect(msg).toMatchObject({ kind: "clarifying", text: "Which part?", quickReplies: ["A", "B"] });
		expect(s1.turnStatus).toBe("awaiting-clarification");
		expect(s1.activeTurnId).toBe("t1");
	});

	test("clarifying-question with no quick replies defaults to an empty array", () => {
		const { state: s0, assistantMessageId } = begin();
		const s1 = applyAssistantEvent({
			state: s0,
			turnId: "t1",
			assistantMessageId,
			event: { type: "clarifying-question", question: "Which part?" },
			now: NOW,
		});
		expect(s1.messages.find((m) => m.id === assistantMessageId)?.quickReplies).toEqual([]);
	});

	test("proposed-ops sets awaiting-confirmation and system-status role", () => {
		const { state: s0, assistantMessageId } = begin();
		const ops = [{ id: "op-1", icon: "cut" as const, summary: "Cut it", timecode: "00:00-00:05" }];
		const s1 = applyAssistantEvent({
			state: s0,
			turnId: "t1",
			assistantMessageId,
			event: { type: "proposed-ops", ops },
			now: NOW,
		});
		const msg = s1.messages.find((m) => m.id === assistantMessageId);
		expect(msg).toMatchObject({ role: "system-status", kind: "confirmation" });
		expect(msg?.ops).toEqual(ops);
		expect(s1.turnStatus).toBe("awaiting-confirmation");
	});

	test("applied sets idle, system-status role, and carries the undo callback", () => {
		const { state: s0, assistantMessageId } = begin();
		let undone = false;
		const s1 = applyAssistantEvent({
			state: s0,
			turnId: "t1",
			assistantMessageId,
			event: { type: "applied", count: 2, undo: () => (undone = true) },
			now: NOW,
		});
		const msg = s1.messages.find((m) => m.id === assistantMessageId);
		expect(msg).toMatchObject({ role: "system-status", kind: "applied", text: "Applied: 2 changes", appliedCount: 2 });
		msg?.undo?.();
		expect(undone).toBe(true);
		expect(s1.turnStatus).toBe("idle");
		expect(s1.activeTurnId).toBeNull();
	});

	test("applied singular count reads 'Applied: 1 change'", () => {
		const { state: s0, assistantMessageId } = begin();
		const s1 = applyAssistantEvent({
			state: s0,
			turnId: "t1",
			assistantMessageId,
			event: { type: "applied", count: 1, undo: () => {} },
			now: NOW,
		});
		expect(s1.messages.find((m) => m.id === assistantMessageId)?.text).toBe("Applied: 1 change");
	});

	test("error sets idle and renders plain text on the assistant message", () => {
		const { state: s0, assistantMessageId } = begin();
		const s1 = applyAssistantEvent({
			state: s0,
			turnId: "t1",
			assistantMessageId,
			event: { type: "error", message: "I can't do that here." },
			now: NOW,
		});
		const msg = s1.messages.find((m) => m.id === assistantMessageId);
		expect(msg).toMatchObject({ role: "assistant", kind: "error", text: "I can't do that here." });
		expect(s1.turnStatus).toBe("idle");
		expect(s1.activeTurnId).toBeNull();
	});
});

describe("applyAssistantEvent - streamed prose survives a terminal event", () => {
	test("applied appends a NEW message when the placeholder already has streamed text, preserving it", () => {
		const { state: s0, assistantMessageId } = begin();
		const streamed = applyAssistantEvent({
			state: s0,
			turnId: "t1",
			assistantMessageId,
			event: { type: "text-delta", delta: "Removing dead air." },
			now: NOW,
		});
		const landed = applyAssistantEvent({
			state: streamed,
			turnId: "t1",
			assistantMessageId,
			event: { type: "applied", count: 3, undo: () => {} },
			now: NOW,
		});
		expect(landed.messages).toHaveLength(3); // user + text + applied
		const textMsg = landed.messages.find((m) => m.id === assistantMessageId);
		expect(textMsg).toMatchObject({ kind: "text", text: "Removing dead air." });
		const appliedMsg = landed.messages[landed.messages.length - 1];
		expect(appliedMsg).toMatchObject({ kind: "applied", appliedCount: 3 });
		expect(appliedMsg.id).not.toBe(assistantMessageId);
	});

	test("applied morphs the SAME empty placeholder in place when nothing streamed first", () => {
		const { state: s0, assistantMessageId } = begin();
		const landed = applyAssistantEvent({
			state: s0,
			turnId: "t1",
			assistantMessageId,
			event: { type: "applied", count: 1, undo: () => {} },
			now: NOW,
		});
		expect(landed.messages).toHaveLength(2); // user + applied (no separate empty bubble)
		expect(landed.messages[1]).toMatchObject({ id: assistantMessageId, kind: "applied" });
	});

	test("a confirmed proposed-ops card (no text of its own) morphs into applied in place, not appended", () => {
		const { state: s0, assistantMessageId } = begin("speed up the second clip");
		const streamed = applyAssistantEvent({
			state: s0,
			turnId: "t1",
			assistantMessageId,
			event: { type: "text-delta", delta: "Here's the plan:" },
			now: NOW,
		});
		const ops = [{ id: "op-1", icon: "speed" as const, summary: "2x", timecode: "00:10-00:15" }];
		const proposed = applyAssistantEvent({
			state: streamed,
			turnId: "t1",
			assistantMessageId,
			event: { type: "proposed-ops", ops },
			now: NOW,
		});
		expect(proposed.messages).toHaveLength(3); // user + intro text + confirmation card
		const card = proposed.messages[proposed.messages.length - 1];
		expect(card.kind).toBe("confirmation");
		expect(card.id).not.toBe(assistantMessageId);

		// Confirming targets the CARD's own id (as the UI does via message.id).
		const applied = applyAssistantEvent({
			state: proposed,
			turnId: "t1",
			assistantMessageId: card.id,
			event: { type: "applied", count: 2, undo: () => {} },
			now: NOW,
		});
		expect(applied.messages).toHaveLength(3); // no new bubble added
		expect(applied.messages[applied.messages.length - 1]).toMatchObject({
			id: card.id,
			kind: "applied",
			appliedCount: 2,
		});
	});
});

describe("applyAssistantEvent - out-of-order guard", () => {
	test("an event for a turn id that never started is ignored", () => {
		const { state } = begin();
		const next = applyAssistantEvent({
			state,
			turnId: "some-other-turn",
			assistantMessageId: "some-other-turn-assistant",
			event: { type: "text-delta", delta: "nope" },
			now: NOW,
		});
		expect(next).toEqual(state);
	});

	test("a late error arriving after the turn already resolved via applied is ignored", () => {
		const { state: s0, assistantMessageId } = begin();
		const applied = applyAssistantEvent({
			state: s0,
			turnId: "t1",
			assistantMessageId,
			event: { type: "applied", count: 1, undo: () => {} },
			now: NOW,
		});
		expect(applied.activeTurnId).toBeNull();

		// The same turn id's error event arrives late (e.g. a race in the
		// mock/real stream) - the resolved "applied" message must survive intact.
		const late = applyAssistantEvent({
			state: applied,
			turnId: "t1",
			assistantMessageId,
			event: { type: "error", message: "should never land" },
			now: NOW,
		});
		expect(late).toEqual(applied);
		const msg = late.messages.find((m) => m.id === assistantMessageId);
		expect(msg?.kind).toBe("applied");
	});

	test("an event from a stale turn does not clobber the NEW active turn", () => {
		const { state: s0, assistantMessageId: a1 } = begin("first");
		const s1 = applyAssistantEvent({
			state: s0,
			turnId: "t1",
			assistantMessageId: a1,
			event: { type: "applied", count: 1, undo: () => {} },
			now: NOW,
		});
		const { state: s2, assistantMessageId: a2 } = startAssistantTurn({
			state: s1,
			turnId: "t2",
			userText: "second",
			now: NOW,
		});
		// A stray late event tagged with the OLD turn id must not touch turn 2.
		const s3 = applyAssistantEvent({
			state: s2,
			turnId: "t1",
			assistantMessageId: a1,
			event: { type: "text-delta", delta: "stale" },
			now: NOW,
		});
		expect(s3).toEqual(s2);
		expect(s3.messages.find((m) => m.id === a2)?.text).toBe("");
	});
});

describe("quick-reply flow", () => {
	test("canUseQuickReply is true only for the live clarifying message", () => {
		const { state: s0, assistantMessageId } = begin();
		const s1 = applyAssistantEvent({
			state: s0,
			turnId: "t1",
			assistantMessageId,
			event: { type: "clarifying-question", question: "Which?", quickReplies: ["A"] },
			now: NOW,
		});
		expect(canUseQuickReply({ state: s1, messageId: assistantMessageId })).toBe(true);
		expect(canUseQuickReply({ state: s1, messageId: "not-a-real-id" })).toBe(false);
	});

	test("canUseQuickReply is false once the turn has moved on", () => {
		const { state: s0, assistantMessageId } = begin();
		const clarifying = applyAssistantEvent({
			state: s0,
			turnId: "t1",
			assistantMessageId,
			event: { type: "clarifying-question", question: "Which?", quickReplies: ["A"] },
			now: NOW,
		});
		const applied = applyAssistantEvent({
			state: clarifying,
			turnId: "t1",
			assistantMessageId,
			event: { type: "applied", count: 1, undo: () => {} },
			now: NOW,
		});
		expect(canUseQuickReply({ state: applied, messageId: assistantMessageId })).toBe(false);
	});

	test("consumeQuickReply clears the chips on that message only", () => {
		const { state: s0, assistantMessageId } = begin();
		const clarifying = applyAssistantEvent({
			state: s0,
			turnId: "t1",
			assistantMessageId,
			event: { type: "clarifying-question", question: "Which?", quickReplies: ["A", "B"] },
			now: NOW,
		});
		const consumed = consumeQuickReply({ state: clarifying, messageId: assistantMessageId });
		expect(consumed.messages.find((m) => m.id === assistantMessageId)?.quickReplies).toEqual([]);
		// Unrelated messages are untouched.
		expect(consumed.messages[0].id).toBe(clarifying.messages[0].id);
	});
});

describe("resolveConfirmation", () => {
	function confirming() {
		const { state: s0, assistantMessageId } = begin("speed up the second clip");
		const ops = [{ id: "op-1", icon: "speed" as const, summary: "2x speed", timecode: "00:10-00:15" }];
		const state = applyAssistantEvent({
			state: s0,
			turnId: "t1",
			assistantMessageId,
			event: { type: "proposed-ops", ops },
			now: NOW,
		});
		return { state, assistantMessageId };
	}

	test("cancel reverts to a plain text message and idle, without contacting the service", () => {
		const { state, assistantMessageId } = confirming();
		const next = resolveConfirmation({ state, messageId: assistantMessageId, decision: "cancel" });
		const msg = next.messages.find((m) => m.id === assistantMessageId);
		expect(msg).toMatchObject({ kind: "text", role: "assistant", text: "Cancelled - nothing changed." });
		expect(msg?.ops).toBeUndefined();
		expect(next.turnStatus).toBe("idle");
		expect(next.activeTurnId).toBeNull();
	});

	test("confirm hands the turn back to streaming, leaving the message as-is for the follow-up applied event", () => {
		const { state, assistantMessageId } = confirming();
		const next = resolveConfirmation({ state, messageId: assistantMessageId, decision: "confirm" });
		expect(next.turnStatus).toBe("streaming");
		expect(next.activeTurnId).toBe("t1");
		expect(next.messages.find((m) => m.id === assistantMessageId)?.kind).toBe("confirmation");
	});
});

describe("endTurnStream", () => {
	test("a plain reply (text-delta only, no terminal event) is closed out when the stream ends", () => {
		const { state: s0, assistantMessageId } = begin();
		const streamed = applyAssistantEvent({
			state: s0,
			turnId: "t1",
			assistantMessageId,
			event: { type: "text-delta", delta: "Just an answer, no edit." },
			now: NOW,
		});
		expect(streamed.turnStatus).toBe("streaming");
		const ended = endTurnStream({ state: streamed, turnId: "t1" });
		expect(ended.turnStatus).toBe("idle");
		expect(ended.activeTurnId).toBeNull();
		// The streamed text itself is untouched.
		expect(ended.messages.find((m) => m.id === assistantMessageId)?.text).toBe(
			"Just an answer, no edit.",
		);
	});

	test("is a no-op once a terminal event already resolved the turn", () => {
		const { state: s0, assistantMessageId } = begin();
		const applied = applyAssistantEvent({
			state: s0,
			turnId: "t1",
			assistantMessageId,
			event: { type: "applied", count: 1, undo: () => {} },
			now: NOW,
		});
		const ended = endTurnStream({ state: applied, turnId: "t1" });
		expect(ended).toEqual(applied);
	});

	test("is a no-op for a turn id that is no longer active (a newer turn started)", () => {
		const { state: s0 } = begin("first");
		const { state: s1 } = startAssistantTurn({ state: s0, turnId: "t2", userText: "second", now: NOW });
		const ended = endTurnStream({ state: s1, turnId: "t1" });
		expect(ended).toEqual(s1);
	});
});

describe("composer disabled / autofocus", () => {
	const base: AssistantChatState = createInitialAssistantChatState();
	test.each([
		["idle", false, true],
		["streaming", true, false],
		["awaiting-clarification", false, true],
		["awaiting-confirmation", true, false],
	] as const)("%s -> disabled=%s autofocus=%s", (status, disabled, autofocus) => {
		const state = { ...base, turnStatus: status };
		expect(isComposerDisabled(state)).toBe(disabled);
		expect(shouldAutofocusComposer(state)).toBe(autofocus);
	});
});

describe("capMessages", () => {
	function makeMessages(n: number): AssistantMessage[] {
		return Array.from({ length: n }, (_, i) => ({
			id: `m${i}`,
			role: "user",
			kind: "text",
			text: String(i),
			createdAt: NOW + i,
		}));
	}

	test("passes a list under the cap through unchanged", () => {
		const messages = makeMessages(5);
		expect(capMessages(messages, 100)).toEqual(messages);
	});

	test("keeps only the LAST max entries, dropping the oldest", () => {
		const messages = makeMessages(120);
		const capped = capMessages(messages, 100);
		expect(capped).toHaveLength(100);
		expect(capped[0].id).toBe("m20");
		expect(capped[capped.length - 1].id).toBe("m119");
	});
});
