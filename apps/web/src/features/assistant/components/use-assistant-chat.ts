"use client";

/**
 * React wiring for the Assistant chat (T17.3): the pure reducer
 * (assistant-reducer.ts) driven by an `AssistantService`'s event stream
 * (assistant-service.ts), persisted per project (assistant-history-store.ts).
 *
 * SERVICE SELECTION (round 17 integration). Real by default: `defaultService`
 * builds one `createRealAssistantService(editor)` per editor instance and
 * reuses it for the component's lifetime (a fresh driver per render would
 * drop the driver's held-confirmation and model-context state on every
 * re-render). The mock stays reachable behind a dev-only flag
 * (`localStorage["vibecut-assistant-mock"] === "1"`, see
 * `real-assistant-service.ts`'s docstring) for offline demos. An explicit
 * `serviceOverride` argument (tests, or a future caller with its own driver)
 * always wins over both.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEditor } from "@/editor/use-editor";
import {
	applyAssistantEvent,
	canUseQuickReply,
	consumeQuickReply,
	createInitialAssistantChatState,
	endTurnStream,
	isComposerDisabled,
	resolveConfirmation,
	shouldAutofocusComposer,
	startAssistantTurn,
	type AssistantChatState,
	type AssistantMessage,
} from "./assistant-reducer";
import {
	mockAssistantService,
	type AssistantEvent,
	type AssistantHistoryTurn,
	type AssistantProposedOp,
	type AssistantService,
} from "./assistant-service";
import { readAssistantHistory, writeAssistantHistory } from "./assistant-history-store";
import { createRealAssistantService, isAssistantMockForced } from "./real-assistant-service";

/** How much prior conversation the service sees per turn - enough for a
 * clarifying follow-up to make sense, cheap enough to always send. */
const HISTORY_TURNS_FOR_CONTEXT = 12;

let turnCounter = 0;
function nextTurnId(): string {
	turnCounter += 1;
	return `turn-${Date.now()}-${turnCounter}`;
}

function toHistoryTurns(messages: readonly AssistantMessage[]): AssistantHistoryTurn[] {
	return messages
		.filter((m) => m.role !== "system-status" && m.text)
		.slice(-HISTORY_TURNS_FOR_CONTEXT)
		.map((m) => ({ role: m.role === "user" ? "user" : "assistant", text: m.text }));
}

export interface UseAssistantChatResult {
	/** The full reducer state - pass to pure helpers like `canUseQuickReply`
	 * rather than reconstructing one from the fields below. */
	state: AssistantChatState;
	messages: AssistantMessage[];
	disabled: boolean;
	autofocus: boolean;
	send: (text: string) => void;
	clickQuickReply: (args: { messageId: string; reply: string }) => void;
	confirmOps: (args: { messageId: string; ops: AssistantProposedOp[] }) => void;
	cancelOps: (messageId: string) => void;
}

export function useAssistantChat(serviceOverride?: AssistantService): UseAssistantChatResult {
	const editor = useEditor();
	const projectId = useEditor((e) => e.project.getActiveOrNull()?.metadata.id) ?? null;

	// One real service per editor instance for the component's lifetime - see
	// the file docstring. `??` short-circuits, so `createRealAssistantService`
	// is never called at all once a `serviceOverride` (tests) is passed.
	const service = useMemo(
		() => serviceOverride ?? (isAssistantMockForced() ? mockAssistantService : createRealAssistantService(editor)),
		[editor, serviceOverride],
	);

	const [state, setState] = useState<AssistantChatState>(() => createInitialAssistantChatState());
	const loadedProjectId = useRef<string | null>(null);

	// Load this project's persisted history once per project switch.
	useEffect(() => {
		if (!projectId || loadedProjectId.current === projectId) return;
		loadedProjectId.current = projectId;
		setState(createInitialAssistantChatState(readAssistantHistory(projectId)));
	}, [projectId]);

	// Persist on every change (idle debounce is unnecessary here - writes are
	// synchronous localStorage, and turns are user-paced).
	useEffect(() => {
		if (!projectId) return;
		writeAssistantHistory({ projectId, messages: state.messages, now: Date.now() });
	}, [projectId, state.messages]);

	const runTurn = useCallback(
		async (turnId: string, assistantMessageId: string, gen: AsyncGenerator<AssistantEvent>) => {
			for await (const event of gen) {
				setState((prev) =>
					applyAssistantEvent({ state: prev, turnId, assistantMessageId, event, now: Date.now() }),
				);
			}
			// The stream ended without a terminal event (a plain reply with no
			// edit, question, or failure) - close the turn out (see
			// endTurnStream's docstring).
			setState((prev) => endTurnStream({ state: prev, turnId }));
		},
		[],
	);

	// Starts a turn from an EXPLICIT base state rather than reading the hook's
	// `state` closure - `clickQuickReply` below needs to thread a just-consumed
	// quick-reply state into the new turn atomically. Doing that as two
	// sequential `setState` calls (consume, then a plain-value `send`) would
	// have the second call's stale closure silently clobber the first: React
	// applies queued updates in order, but a plain-value `setState(next)` after
	// a functional `setState(prev => ...)` overwrites it outright rather than
	// building on it, if `next` was computed from a state that predates the
	// functional update.
	const sendFrom = useCallback(
		(text: string, baseState: AssistantChatState) => {
			const prompt = text.trim();
			if (!prompt) return;
			const turnId = nextTurnId();
			const { state: next, assistantMessageId } = startAssistantTurn({
				state: baseState,
				turnId,
				userText: prompt,
				now: Date.now(),
			});
			const historyForService = toHistoryTurns(baseState.messages);
			setState(next);
			void runTurn(
				turnId,
				assistantMessageId,
				service.sendTurn({ prompt, history: historyForService }),
			);
		},
		[runTurn, service],
	);

	const send = useCallback((text: string) => sendFrom(text, state), [sendFrom, state]);

	const clickQuickReply = useCallback(
		({ messageId, reply }: { messageId: string; reply: string }) => {
			if (!canUseQuickReply({ state, messageId })) return;
			sendFrom(reply, consumeQuickReply({ state, messageId }));
		},
		[state, sendFrom],
	);

	const confirmOps = useCallback(
		({ messageId, ops }: { messageId: string; ops: AssistantProposedOp[] }) => {
			const turnId = state.activeTurnId;
			if (!turnId) return;
			setState((prev) => resolveConfirmation({ state: prev, messageId, decision: "confirm" }));
			void runTurn(
				turnId,
				messageId,
				service.sendTurn({ prompt: "", history: toHistoryTurns(state.messages), confirmedOps: ops }),
			);
		},
		[state, runTurn, service],
	);

	const cancelOps = useCallback((messageId: string) => {
		setState((prev) => resolveConfirmation({ state: prev, messageId, decision: "cancel" }));
	}, []);

	return {
		state,
		messages: state.messages,
		disabled: isComposerDisabled(state),
		autofocus: shouldAutofocusComposer(state),
		send,
		clickQuickReply,
		confirmOps,
		cancelOps,
	};
}
