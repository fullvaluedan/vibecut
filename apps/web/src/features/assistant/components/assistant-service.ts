/**
 * The chat-turn service boundary (T17.3). This is the ONE interface T17.2's
 * real executor and this file's `createMockAssistantService` both implement,
 * so the UI (assistant-tab.tsx, use-assistant-chat.ts) never knows which one
 * it is talking to. Keep this file's exported types minimal and additions
 * deliberate - T17.2 builds against this shape directly.
 *
 * `createMockAssistantService` is a MOCK: every reply below is a scripted
 * string match on the prompt text, not a real model call. It exists so the
 * whole chat UI (streaming bubbles, clarifying questions, the confirmation
 * list, the applied chip + undo, error rendering) is drivable end to end
 * before the real backend (T17.2) lands. It is used by default; swap it out
 * by passing a different `AssistantService` to `useAssistantChat`.
 */

/** Icon key for one op row in a confirmation list (see `AssistantProposedOp`). */
export type AssistantOpIcon =
	| "cut"
	| "delete"
	| "extend"
	| "move"
	| "speed"
	| "text"
	| "marker"
	| "split";

/** One op in a proposed multi-op destructive change, shown for one-click review. */
export interface AssistantProposedOp {
	id: string;
	icon: AssistantOpIcon;
	/** Human-readable summary, e.g. `Delete clip "B-roll 2"`. */
	summary: string;
	/** Display timecode or range, e.g. `00:12 - 00:18`. */
	timecode: string;
}

/**
 * One event in a turn's stream, in the order the service may emit them:
 *
 * - `text-delta` - a chunk of the assistant's running reply. Consumers append
 *   `delta` to the current assistant message's text buffer. May repeat.
 * - `clarifying-question` - the prompt was ambiguous; the assistant needs the
 *   user to disambiguate before it can act (per the roadmap's ambiguity rule:
 *   never guess destructively). `quickReplies` are optional one-click answers;
 *   the composer autofocuses so the user can also type a custom reply. Ends
 *   the turn - no further events until the user replies (a new `sendTurn`
 *   call starts the next turn).
 * - `proposed-ops` - a destructive multi-op change proposed for one-click
 *   review (3+ ops, or anything irreversible-feeling). Ends the turn; the UI
 *   shows Confirm/Cancel. Confirm resumes with a follow-up `sendTurn` call
 *   carrying `confirmedOps`; Cancel is a pure client-side transition and never
 *   reaches the service.
 * - `applied` - the turn's edits landed on the timeline as one undoable batch.
 *   `count` is the number of ops applied; `undo()` reverts the whole batch in
 *   one call. Terminal event.
 * - `error` - the turn failed. `message` is always plain language, never a
 *   raw stack trace. Terminal event.
 */
export type AssistantEvent =
	| { type: "text-delta"; delta: string }
	| { type: "clarifying-question"; question: string; quickReplies?: string[] }
	| { type: "proposed-ops"; ops: AssistantProposedOp[] }
	| { type: "applied"; count: number; undo: () => void }
	| { type: "error"; message: string };

/** One prior turn, for the service's conversational context. */
export interface AssistantHistoryTurn {
	role: "user" | "assistant";
	text: string;
}

export interface AssistantServiceInput {
	/** The user's typed message, or the text of a clicked quick reply. */
	prompt: string;
	/** Prior turns, oldest first, trimmed by the caller to fit context. */
	history: AssistantHistoryTurn[];
	/**
	 * Present only when resuming a turn that ended in a `proposed-ops`
	 * confirmation list and the user clicked Confirm - these are the exact
	 * ops the user approved. Cancel never reaches the service.
	 */
	confirmedOps?: AssistantProposedOp[];
}

export interface AssistantService {
	/** One turn in, one event stream out. See `AssistantEvent` for the shape. */
	sendTurn(input: AssistantServiceInput): AsyncGenerator<AssistantEvent>;
}

/** Yield control to the microtask queue so "streaming" text visibly arrives in
 * chunks without a real network delay (fast and deterministic under tests). */
function tick(): Promise<void> {
	return Promise.resolve();
}

async function* streamText(text: string): AsyncGenerator<AssistantEvent> {
	const words = text.split(" ");
	for (let i = 0; i < words.length; i++) {
		await tick();
		yield { type: "text-delta", delta: (i === 0 ? "" : " ") + words[i] };
	}
}

let mockOpCounter = 0;
function mockOp(args: Omit<AssistantProposedOp, "id">): AssistantProposedOp {
	mockOpCounter += 1;
	return { id: `mock-op-${mockOpCounter}`, ...args };
}

/**
 * MOCK - see the file docstring. Scripted by matching the prompt (or, when
 * resuming a confirmation, by the presence of `confirmedOps`), never a real
 * model call.
 */
async function* mockSendTurn(
	input: AssistantServiceInput,
): AsyncGenerator<AssistantEvent> {
	if (input.confirmedOps) {
		// No streamText here: the confirmation card the user just approved
		// carries no streamed prose (see assistant-reducer.ts's `landsOn`), so
		// this `applied` event morphs it in place into the applied chip instead
		// of appending a redundant bubble.
		await tick();
		yield {
			type: "applied",
			count: input.confirmedOps.length,
			// MOCK: a real undo drives the actual command-stack undo (T17.2).
			undo: () => {},
		};
		return;
	}

	const prompt = input.prompt.toLowerCase();

	if (prompt.includes("silence")) {
		yield* streamText(
			"**Removing dead air.** I found 3 silent gaps at the start and cut them.",
		);
		await tick();
		yield { type: "applied", count: 3, undo: () => {} };
		return;
	}

	if (prompt.includes("welcome") || prompt.includes("title")) {
		yield* streamText('**Added a title.** "Welcome" now sits at the playhead.');
		await tick();
		yield { type: "applied", count: 1, undo: () => {} };
		return;
	}

	if (prompt.includes("speed up") || prompt.includes("2x")) {
		yield* streamText(
			"That touches more than one clip, so here's what I'd change before I apply anything:",
		);
		await tick();
		yield {
			type: "proposed-ops",
			ops: [
				mockOp({ icon: "speed", summary: 'Set clip "B-roll 2" to 2x speed', timecode: "00:18 - 00:24" }),
				mockOp({ icon: "move", summary: "Shift everything after it 3s earlier", timecode: "00:24 - end" }),
			],
		};
		return;
	}

	if (prompt.includes("boring")) {
		yield* streamText("I want to make sure I cut the right part.");
		await tick();
		yield {
			type: "clarifying-question",
			question:
				"The section from 2:10-2:45 has three long pauses; is that the boring part, or did you mean the intro?",
			quickReplies: ["The 2:10-2:45 section", "The intro instead"],
		};
		return;
	}

	if (prompt.includes("impossible") || prompt.includes("can't") || prompt.includes("cannot")) {
		await tick();
		yield {
			type: "error",
			message:
				"I can't do that here - it's outside what this editor can change. Try a cut, a text/graphic add, or a speed change instead.",
		};
		return;
	}

	yield* streamText(
		"**Got it.** Here's what I can do from this box:\n- Cut silences or a range you describe\n- Add a title or lower third\n- Speed up or slow down a clip\n\nTell me what you'd like, with as much detail as you can.",
	);
}

/** The default mock service (see the file docstring). */
export const mockAssistantService: AssistantService = {
	sendTurn: mockSendTurn,
};
