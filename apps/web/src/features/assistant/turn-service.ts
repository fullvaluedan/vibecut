/**
 * The TURN SERVICE: the client-side loop that drives one prompt to a result
 * (T17.2).
 *
 * Shape of a turn, and the reason it is bounded:
 *   collect context -> POST /api/assistant/edit -> validate the tool calls
 *   against a FRESH snapshot -> execute one batch -> POST the tool results back
 *   -> emit the model's closing summary.
 * That is ONE tool round-trip plus a text follow-up. Exactly one extra round is
 * allowed, and only when validation failed: the refusal reason goes back as a
 * failed tool result so the model can retry differently. After that the loop
 * stops whatever the model says next. An unbounded agent loop would be able to
 * spend the user's tokens and rewrite their timeline without ever handing
 * control back, which is not a thing an edit assistant should be able to do.
 *
 * WHY THE SNAPSHOT IS TAKEN TWICE. The context the model reasoned over is a
 * photograph; by the time the user's turn comes back, the timeline may have
 * moved (playback, a manual drag, the Director). Every call is therefore
 * re-validated against a snapshot taken at EXECUTE time. If that second
 * verdict fails, nothing is applied at all - the same all-or-nothing rule that
 * makes the batch safe.
 *
 * CONFIRMATION (settled rule). Genuinely ambiguous prompts are supposed to come
 * back as `ask_user` from the server, and that path is honored first. On top of
 * it the client holds a turn for explicit confirmation when it is big or
 * destructive: more than `MAX_UNCONFIRMED_OPS` mutating calls, or cuts and
 * deletes removing more than `MAX_UNCONFIRMED_DESTRUCTIVE_SEC` seconds in
 * total. Below both thresholds the turn applies immediately, because asking
 * "are you sure?" for "delete the second clip" is worse than just doing it and
 * leaving one undo behind.
 *
 * NO UI HERE. Everything is an event; T17.3's chat window subscribes.
 */

import { validateTurn } from "./tools";
import type { AssistantContext } from "./context";
import {
	executeAssistantTurn,
	planAssistantTurn,
	showInsertedElement,
	type AssistantApplyResult,
	type AssistantExecutorEditor,
	type AssistantTemplateLook,
	type AssistantTurnPlan,
	type AssistantUndoHandle,
} from "./executor";
import type { TimelineSnapshot } from "./snapshot";
import type {
	AssistantMessage,
	AssistantToolResult,
	AssistantTurnRequest,
	AssistantTurnResponse,
	ValidatedToolCall,
} from "./types";

/** More mutating calls than this in one turn needs an explicit confirm. */
export const MAX_UNCONFIRMED_OPS = 3;
/** More removed seconds than this in one turn needs an explicit confirm. */
export const MAX_UNCONFIRMED_DESTRUCTIVE_SEC = 10;

export type AssistantTurnEvent =
	/** The model's closing summary, or a pure-text turn. */
	| { type: "text"; text: string; promptVersion: number }
	/** The model asked something before touching the timeline. */
	| {
			type: "clarifying-question";
			question: string;
			options?: string[];
			promptVersion: number;
		}
	/** A big or destructive turn, held until `confirm()` or `cancel()`. */
	| { type: "proposed-ops"; summaries: string[] }
	/** The batch landed. `undo` drives the normal undo stack. */
	| { type: "applied"; count: number; summaries: string[]; undo: AssistantUndoHandle }
	/** Nothing was applied, and this is the sentence to show. */
	| { type: "error"; reason: string };

export interface AssistantEventStream {
	subscribe(listener: (event: AssistantTurnEvent) => void): () => void;
}

/**
 * What the chat layer drives. Deliberately small: a prompt in, events out, plus
 * the two answers a held or questioning turn can receive.
 */
export interface AssistantTurnDriver {
	/** Send a new user prompt. Resolves when the turn is finished or held. */
	start(prompt: string): Promise<void>;
	/** Apply a turn that was held for confirmation. */
	confirm(): Promise<void>;
	/** Discard a turn that was held for confirmation. */
	cancel(): void;
	/** Answer a clarifying question. Same wire path as `start`. */
	reply(text: string): Promise<void>;
	events: AssistantEventStream;
	/** True while a turn is in flight; the UI disables the composer on it. */
	isBusy(): boolean;
	/** True while a proposed turn is waiting for `confirm()` or `cancel()`. */
	isAwaitingConfirmation(): boolean;
	/** The conversation so far, for persistence and for re-rendering. */
	getMessages(): AssistantMessage[];
	/** The prompt version of the most recent response, or null before one. */
	getPromptVersion(): number | null;
}

/** One round-trip to the edit route. Injected so tests never touch fetch. */
export type AssistantTurnTransport = (
	request: AssistantTurnRequest,
) => Promise<AssistantTurnResponse>;

export interface AssistantTurnDriverDeps {
	/** A FRESH snapshot plus its serialized context. Called at every read point. */
	collect: () => { snapshot: TimelineSnapshot; context: AssistantContext };
	request: AssistantTurnTransport;
	editor: AssistantExecutorEditor;
	/** Palette and type face for inserted motion templates. */
	look?: AssistantTemplateLook;
	/** Override the model the route defaults to. */
	model?: string;
}

interface HeldTurn {
	/** The calls as validated when the turn was proposed. Re-validated on apply. */
	calls: ValidatedToolCall[];
	summaries: string[];
}

function toolResultsFor({
	calls,
	summaries,
}: {
	calls: readonly ValidatedToolCall[];
	summaries: readonly string[];
}): AssistantToolResult[] {
	return calls.map((call, index) => ({
		toolCallId: call.id,
		ok: true,
		summary: summaries[index] ?? "Applied.",
	}));
}

export function needsConfirmation(plan: AssistantTurnPlan): boolean {
	return (
		plan.mutatingCount > MAX_UNCONFIRMED_OPS ||
		plan.destructiveSeconds > MAX_UNCONFIRMED_DESTRUCTIVE_SEC
	);
}

export function createAssistantTurnDriver(
	deps: AssistantTurnDriverDeps,
): AssistantTurnDriver {
	const listeners = new Set<(event: AssistantTurnEvent) => void>();
	const messages: AssistantMessage[] = [];
	let held: HeldTurn | null = null;
	let busy = false;
	let promptVersion: number | null = null;

	const emit = (event: AssistantTurnEvent): void => {
		for (const listener of listeners) listener(event);
	};

	const post = async (
		toolResults?: AssistantToolResult[],
	): Promise<AssistantTurnResponse> => {
		const { context } = deps.collect();
		const request: AssistantTurnRequest = {
			context,
			messages: [...messages],
			...(toolResults && toolResults.length ? { toolResults } : {}),
			...(deps.model ? { model: deps.model } : {}),
		};
		const response = await deps.request(request);
		promptVersion = response.promptVersion;
		messages.push({
			role: "assistant",
			content: response.text,
			...(response.toolCalls.length ? { toolCalls: response.toolCalls } : {}),
		});
		return response;
	};

	/** The closing text turn: results in, summary out, tool calls ignored. This
	 * is the loop's hard stop. */
	const closeWithSummary = async (
		toolResults: AssistantToolResult[],
	): Promise<void> => {
		const response = await post(toolResults);
		if (response.text) {
			emit({
				type: "text",
				text: response.text,
				promptVersion: response.promptVersion,
			});
		}
	};

	/**
	 * Validate against a fresh snapshot and, when it holds, apply. Returns the
	 * tool results to send back, or null when nothing was applied (the caller
	 * has already emitted the reason).
	 */
	const applyCalls = async (
		calls: readonly ValidatedToolCall[],
	): Promise<AssistantApplyResult | null> => {
		const { snapshot } = deps.collect();
		// Re-validate from the RAW calls: `ValidatedToolCall.args` are already
		// normalized, so feeding them back through the validators is a verdict on
		// the current timeline, not a second normalization pass.
		const verdict = validateTurn({
			calls: calls.map((call) => ({
				id: call.id,
				name: call.name,
				args: call.args as unknown as Record<string, unknown>,
			})),
			snapshot,
		});
		if (!verdict.ok) {
			emit({ type: "error", reason: verdict.failure.reason });
			return null;
		}
		const plan = planAssistantTurn({
			calls: verdict.calls,
			snapshot,
			...(deps.look ? { look: deps.look } : {}),
		});
		const applied = executeAssistantTurn({ plan, editor: deps.editor });
		if (!applied) return null;
		// Show-me mode (T17.4): outside `plan.commands`, so it is not part of the
		// batch this undo handle reverts.
		showInsertedElement({ calls: verdict.calls, snapshot, editor: deps.editor });
		emit({
			type: "applied",
			count: applied.appliedCount,
			summaries: plan.ops.map((op) => op.summary),
			undo: applied.undo,
		});
		return applied;
	};

	/**
	 * One model response, turned into events. `retriesLeft` bounds the
	 * validation-failure retry at exactly one extra round.
	 */
	const handleResponse = async (
		response: AssistantTurnResponse,
		retriesLeft: number,
	): Promise<void> => {
		// A clarifying question ends the turn: `ask_user` mutates nothing, so a
		// turn containing it produces no batch at all.
		if (response.question) {
			if (response.text) {
				emit({
					type: "text",
					text: response.text,
					promptVersion: response.promptVersion,
				});
			}
			emit({
				type: "clarifying-question",
				question: response.question,
				...(response.questionOptions ? { options: response.questionOptions } : {}),
				promptVersion: response.promptVersion,
			});
			return;
		}

		if (response.toolCalls.length === 0) {
			emit({
				type: "text",
				text: response.text,
				promptVersion: response.promptVersion,
			});
			return;
		}

		const { snapshot } = deps.collect();
		const verdict = validateTurn({ calls: response.toolCalls, snapshot });
		if (!verdict.ok) {
			// Nothing is applied, the refusal is surfaced verbatim, and the model
			// gets the same sentence as a failed tool result so it can retry.
			emit({ type: "error", reason: verdict.failure.reason });
			const failure: AssistantToolResult[] = response.toolCalls.map((call) => ({
				toolCallId: call.id,
				ok: false,
				summary:
					call.id === verdict.call.id
						? verdict.failure.reason
						: "Not applied: another change in the same turn was refused.",
			}));
			if (retriesLeft <= 0) {
				await closeWithSummary(failure);
				return;
			}
			const retry = await post(failure);
			await handleResponse(retry, retriesLeft - 1);
			return;
		}

		if (response.text) {
			emit({
				type: "text",
				text: response.text,
				promptVersion: response.promptVersion,
			});
		}

		const plan = planAssistantTurn({
			calls: verdict.calls,
			snapshot,
			...(deps.look ? { look: deps.look } : {}),
		});
		if (plan.commands.length === 0) {
			// Every call was a no-op against the live timeline. Report success so
			// the model does not retry a turn that had nothing to do.
			await closeWithSummary(
				toolResultsFor({
					calls: verdict.calls,
					summaries: plan.ops.map((op) => op.summary),
				}),
			);
			return;
		}

		if (needsConfirmation(plan)) {
			held = {
				calls: verdict.calls,
				summaries: plan.ops.map((op) => op.summary),
			};
			emit({ type: "proposed-ops", summaries: held.summaries });
			return;
		}

		const applied = await applyCalls(verdict.calls);
		await closeWithSummary(
			applied
				? toolResultsFor({
						calls: verdict.calls,
						summaries: plan.ops.map((op) => op.summary),
					})
				: response.toolCalls.map((call) => ({
						toolCallId: call.id,
						ok: false,
						summary: "The timeline changed, so nothing was applied.",
					})),
		);
	};

	const send = async (text: string): Promise<void> => {
		if (busy) return;
		busy = true;
		held = null;
		try {
			messages.push({ role: "user", content: text });
			const response = await post();
			await handleResponse(response, 1);
		} catch (error) {
			emit({
				type: "error",
				reason:
					error instanceof Error
						? error.message
						: "The assistant could not be reached.",
			});
		} finally {
			busy = false;
		}
	};

	return {
		start: send,
		reply: send,
		async confirm() {
			const pending = held;
			if (!pending || busy) return;
			held = null;
			busy = true;
			try {
				const applied = await applyCalls(pending.calls);
				await closeWithSummary(
					applied
						? toolResultsFor({
								calls: pending.calls,
								summaries: pending.summaries,
							})
						: pending.calls.map((call) => ({
								toolCallId: call.id,
								ok: false,
								summary: "The timeline changed, so nothing was applied.",
							})),
				);
			} catch (error) {
				emit({
					type: "error",
					reason:
						error instanceof Error
							? error.message
							: "The assistant could not be reached.",
				});
			} finally {
				busy = false;
			}
		},
		cancel() {
			held = null;
		},
		events: {
			subscribe(listener) {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			},
		},
		isBusy: () => busy,
		isAwaitingConfirmation: () => held !== null,
		getMessages: () => [...messages],
		getPromptVersion: () => promptVersion,
	};
}

/** Re-exported so the chat layer can type its Undo affordance without also
 * importing the executor module. */
export type { AssistantUndoHandle };
