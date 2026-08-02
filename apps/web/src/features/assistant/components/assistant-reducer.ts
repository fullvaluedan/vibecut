/**
 * Pure state machine for the Assistant chat (T17.3): turns an `AssistantEvent`
 * stream (assistant-service.ts) into message-list + turn-status transitions.
 * No DOM, no React, no editor access - bun-testable in isolation, same
 * discipline as the rest of the codebase's reducer/store split (see e.g.
 * `director-plan-store.ts`'s pure helpers).
 */

import type { AssistantEvent, AssistantProposedOp } from "./assistant-service";

export type AssistantRole = "user" | "assistant" | "system-status";
export type AssistantMessageKind =
	| "text"
	| "clarifying"
	| "confirmation"
	| "applied"
	| "error";

export interface AssistantMessage {
	id: string;
	role: AssistantRole;
	kind: AssistantMessageKind;
	/** Display text: the streamed reply, the clarifying question, the error
	 * message, or the "Applied: N changes" summary. */
	text: string;
	createdAt: number;
	/** `kind: "clarifying"` only - cleared once one is picked (see `consumeQuickReply`). */
	quickReplies?: string[];
	/** `kind: "confirmation"` only. */
	ops?: AssistantProposedOp[];
	/** `kind: "applied"` only. */
	appliedCount?: number;
	/**
	 * `kind: "applied"` only, session-live. Not persisted (functions cannot
	 * round-trip through JSON - `JSON.stringify` drops them silently, which is
	 * exactly the desired behavior: a reloaded history shows the same "Applied:
	 * N changes" chip, just without a working Undo button).
	 */
	undo?: () => void;
}

export type AssistantTurnStatus =
	| "idle"
	| "streaming"
	| "awaiting-clarification"
	| "awaiting-confirmation";

export interface AssistantChatState {
	messages: AssistantMessage[];
	turnStatus: AssistantTurnStatus;
	/** The turn an in-flight event stream belongs to, or one awaiting a user
	 * decision (clarify / confirm). Null once a turn resolves. */
	activeTurnId: string | null;
}

export function createInitialAssistantChatState(
	messages: readonly AssistantMessage[] = [],
): AssistantChatState {
	return { messages: [...messages], turnStatus: "idle", activeTurnId: null };
}

/** Whether the composer should be disabled (a turn is actively streaming, or a
 * confirmation is pending and must be resolved via Confirm/Cancel first). */
export function isComposerDisabled(state: AssistantChatState): boolean {
	return state.turnStatus === "streaming" || state.turnStatus === "awaiting-confirmation";
}

/** Whether the composer should autofocus right now (idle, or a clarifying
 * question just landed and is waiting on the user). */
export function shouldAutofocusComposer(state: AssistantChatState): boolean {
	return state.turnStatus === "idle" || state.turnStatus === "awaiting-clarification";
}

/**
 * Begin a new turn: append the user's message and an empty streaming
 * assistant placeholder. Returns the new state and the placeholder's id,
 * which every subsequent `applyAssistantEvent` call for this turn targets.
 */
export function startAssistantTurn({
	state,
	turnId,
	userText,
	now,
}: {
	state: AssistantChatState;
	turnId: string;
	userText: string;
	now: number;
}): { state: AssistantChatState; assistantMessageId: string } {
	const assistantMessageId = `${turnId}-assistant`;
	const userMessage: AssistantMessage = {
		id: `${turnId}-user`,
		role: "user",
		kind: "text",
		text: userText,
		createdAt: now,
	};
	const placeholder: AssistantMessage = {
		id: assistantMessageId,
		role: "assistant",
		kind: "text",
		text: "",
		createdAt: now,
	};
	return {
		state: {
			messages: [...state.messages, userMessage, placeholder],
			turnStatus: "streaming",
			activeTurnId: turnId,
		},
		assistantMessageId,
	};
}

/**
 * Apply one service event to chat state. Every `AssistantEvent` variant has a
 * case. Guard: an event whose `turnId` is not the currently active turn is
 * IGNORED (state returned unchanged) - this covers both a stray event from an
 * abandoned turn and a late/out-of-order arrival after the turn already
 * resolved (e.g. an `error` landing after `applied` already closed it out),
 * so a late event can never corrupt an already-resolved turn's UI.
 */
export function applyAssistantEvent({
	state,
	turnId,
	assistantMessageId,
	event,
	now,
}: {
	state: AssistantChatState;
	turnId: string;
	assistantMessageId: string;
	event: AssistantEvent;
	now: number;
}): AssistantChatState {
	if (state.activeTurnId !== turnId) return state;

	const placeholder = state.messages.find((m) => m.id === assistantMessageId);

	if (event.type === "text-delta") {
		const currentText = placeholder?.text ?? "";
		return {
			...state,
			messages: state.messages.map((m) =>
				m.id === assistantMessageId
					? { ...m, role: "assistant", kind: "text", text: currentText + event.delta }
					: m,
			),
		};
	}

	// Every other event type lands a "status" (clarifying / confirmation /
	// applied / error) on top of the placeholder. If nothing has streamed onto
	// it yet, morph it in place (also how a confirmation card resolves into its
	// `applied` chip - `confirmOps` in use-assistant-chat.ts targets the
	// confirmation message's own id, which carries no `text`). If real prose
	// already streamed there (the assistant explained itself before landing on
	// a question/ops/failure), that text is conversational content worth
	// keeping - append a NEW message instead of overwriting it.
	const landsOn = (patch: Omit<AssistantMessage, "id" | "createdAt">): { messages: AssistantMessage[]; targetId: string } => {
		if (!placeholder || !placeholder.text) {
			return {
				messages: state.messages.map((m) =>
					m.id === assistantMessageId ? { ...m, ...patch, createdAt: m.createdAt || now } : m,
				),
				targetId: assistantMessageId,
			};
		}
		const targetId = `${assistantMessageId}-status-${state.messages.length}`;
		return {
			messages: [...state.messages, { id: targetId, createdAt: now, ...patch }],
			targetId,
		};
	};

	switch (event.type) {
		case "clarifying-question": {
			const { messages } = landsOn({
				role: "assistant",
				kind: "clarifying",
				text: event.question,
				quickReplies: event.quickReplies ? [...event.quickReplies] : [],
			});
			return { ...state, messages, turnStatus: "awaiting-clarification" };
		}

		case "proposed-ops": {
			const { messages } = landsOn({
				role: "system-status",
				kind: "confirmation",
				text: "",
				ops: [...event.ops],
			});
			return { ...state, messages, turnStatus: "awaiting-confirmation" };
		}

		case "applied": {
			const { messages } = landsOn({
				role: "system-status",
				kind: "applied",
				text: `Applied: ${event.count} change${event.count === 1 ? "" : "s"}`,
				appliedCount: event.count,
				undo: event.undo,
			});
			return { ...state, messages, turnStatus: "idle", activeTurnId: null };
		}

		case "error": {
			const { messages } = landsOn({
				role: "assistant",
				kind: "error",
				text: event.message,
			});
			return { ...state, messages, turnStatus: "idle", activeTurnId: null };
		}

		default:
			return state;
	}
}

/**
 * Call once a turn's event stream has fully ended (the service's async
 * generator returned). A turn that was ONLY a plain reply - text-delta
 * chunks with no `clarifying-question` / `proposed-ops` / `applied` /
 * `error` - never receives one of the terminal events above that would
 * otherwise flip `turnStatus` back to idle, so without this the composer
 * would stay disabled forever after a plain answer. A no-op for any turn
 * that already resolved (via a terminal event, or because a NEWER turn
 * started in the meantime) or was ignored (an out-of-order stream for a
 * turn that is no longer active).
 */
export function endTurnStream({
	state,
	turnId,
}: {
	state: AssistantChatState;
	turnId: string;
}): AssistantChatState {
	if (state.activeTurnId !== turnId || state.turnStatus !== "streaming") return state;
	return { ...state, turnStatus: "idle", activeTurnId: null };
}

/** Whether `messageId` is the live clarifying-question turn's quick replies
 * are still clickable (the turn hasn't moved on). */
export function canUseQuickReply({
	state,
	messageId,
}: {
	state: AssistantChatState;
	messageId: string;
}): boolean {
	if (state.turnStatus !== "awaiting-clarification") return false;
	const message = state.messages.find((m) => m.id === messageId);
	return !!message && message.kind === "clarifying" && (message.quickReplies?.length ?? 0) > 0;
}

/** Clicking a quick reply clears that message's chips (so they can't be
 * double-clicked while the next turn starts) and hands back the reply text
 * for the caller to send as the next turn's prompt. */
export function consumeQuickReply({
	state,
	messageId,
}: {
	state: AssistantChatState;
	messageId: string;
}): AssistantChatState {
	return {
		...state,
		messages: state.messages.map((m) =>
			m.id === messageId ? { ...m, quickReplies: [] } : m,
		),
	};
}

/**
 * Resolve a pending confirmation-list message. Cancel is a pure client-side
 * transition back to idle (never reaches the service, see
 * `AssistantServiceInput.confirmedOps`'s doc). Confirm hands the turn back to
 * "streaming" - the caller follows up with a `sendTurn({ confirmedOps })`
 * call targeting the SAME message id, so the eventual `applied` event lands
 * on this message.
 */
export function resolveConfirmation({
	state,
	messageId,
	decision,
}: {
	state: AssistantChatState;
	messageId: string;
	decision: "confirm" | "cancel";
}): AssistantChatState {
	if (decision === "cancel") {
		return {
			...state,
			messages: state.messages.map((m) =>
				m.id === messageId
					? { ...m, kind: "text" as const, role: "assistant" as const, text: "Cancelled - nothing changed.", ops: undefined }
					: m,
			),
			turnStatus: "idle",
			activeTurnId: null,
		};
	}
	return { ...state, turnStatus: "streaming" };
}

/** Cap a message list to the last `max` entries (oldest dropped first). */
export function capMessages(
	messages: readonly AssistantMessage[],
	max: number,
): AssistantMessage[] {
	return messages.length > max ? messages.slice(messages.length - max) : [...messages];
}
