"use client";

/**
 * The REAL AssistantService (round 17, T17.3 x T17.2 integration): bridges
 * T17.2's `AssistantTurnDriver` (features/assistant/edit-index.ts) - a
 * subscribe-based event stream with `start`/`confirm`/`cancel`/`reply` methods
 * - onto the chat UI's `AssistantService` contract (assistant-service.ts) - a
 * plain `sendTurn(input): AsyncGenerator<AssistantEvent>`. Three shape gaps,
 * predicted ahead of time by T17.2's own report, all closed here and nowhere
 * else:
 *
 * 1. SUBSCRIBE vs ASYNC GENERATOR. `driver.events.subscribe(listener)` pushes;
 *    `sendTurn` must pull. `createAsyncQueue` below is the bridge: subscribe
 *    before calling `start`/`confirm`, forward every driver event into the
 *    queue, drain the queue as the generator, close it once the driver's own
 *    promise settles. Subscribing BEFORE the call (not after) matters - the
 *    driver can emit synchronously inside `start`/`confirm`, and a listener
 *    added after the call started would miss it.
 * 2. FIELD NAMES. `reason` -> `message`, `options` -> `quickReplies`,
 *    `summaries: string[]` -> `AssistantProposedOp[]` (id/icon/timecode are
 *    all derived - the driver only ever sends the rendered sentence, see
 *    `opFromSummary` below).
 * 3. UNDO SHAPE. The driver's `applied.undo` is a handle object
 *    (`{ canUndo(): boolean; undo(): boolean }`, see executor.ts); the UI
 *    wants a plain `() => void`. `wrapUndoHandle` is the one-line conversion.
 *
 * CONFIRM/CANCEL. The mock resumes a held turn by calling `sendTurn` again
 * with `confirmedOps` on the input (see assistant-service.ts's docstring).
 * The real driver has no resend path - Confirm must call `driver.confirm()`
 * directly. `sendTurn` below branches on `input.confirmedOps` to pick
 * `confirm()` over `start()`, so `use-assistant-chat.ts`'s existing
 * confirm-by-resend call shape keeps working unchanged. Cancel is a pure
 * client-side transition in `assistant-reducer.ts` and never reaches a
 * service at all, so there is nothing to bridge for it.
 *
 * HISTORY. Two histories exist and stay deliberately un-merged:
 *  - the UI's `assistant-history-store.ts`, persisted per project, and the
 *    single source of truth for what RENDERS in the chat panel (survives a
 *    reload);
 *  - the driver's own `messages` (private to turn-service.ts, readable via
 *    `getMessages()`), the model-context window for one live session, empty
 *    again on a freshly constructed driver.
 * A reload therefore shows the same chat transcript but starts the model with
 * no memory of it, the same tradeoff most chat products have across a fresh
 * tab. Reconciling the two (replaying the UI's history into a new driver's
 * context) is out of scope for this integration; nothing below calls
 * `getMessages()`.
 *
 * MOCK FLAG. `isAssistantMockForced()` checks
 * `localStorage["vibecut-assistant-mock"] === "1"` for the offline-demo
 * escape hatch this round's mission asked for. Not a surface flag
 * (`features/editing/surface-flags.ts` is for permanently hiding shipped UI);
 * this is a dev-only toggle, off in every real session.
 */

import type { EditorCore } from "@/core";
import { useTimelineStore } from "@/timeline/timeline-store";
import {
	collectAssistantContext,
	createAssistantTurnDriver,
	editorTranscriptSource,
	postAssistantTurn,
	type AssistantTurnDriver,
	type AssistantTurnEvent,
} from "../edit-index";
import type {
	AssistantEvent,
	AssistantOpIcon,
	AssistantProposedOp,
	AssistantService,
	AssistantServiceInput,
} from "./assistant-service";

const MOCK_FLAG_KEY = "vibecut-assistant-mock";

/** Pure so the flag's meaning is testable without a real `localStorage` -
 * bun's test runtime has none at all (`ReferenceError`, not a throw-on-use
 * stub), which is exactly what `isAssistantMockForced`'s `catch` below is
 * for. */
export function isMockFlagValue(raw: string | null): boolean {
	return raw === "1";
}

/** Dev-only escape hatch for an offline demo - see the file docstring. Never
 * throws: a sandboxed, denied, or (as in bun's test runtime) entirely absent
 * `localStorage` just reads as "not forced". */
export function isAssistantMockForced(): boolean {
	try {
		return isMockFlagValue(localStorage.getItem(MOCK_FLAG_KEY));
	} catch {
		return false;
	}
}

/** The 400 the route sends when no Anthropic key is configured (see
 * `app/api/assistant/edit/route.ts`) - matched on a stable substring rather
 * than the exact sentence so route wording can drift without breaking this. */
function isMissingAnthropicKey(reason: string): boolean {
	return reason.toLowerCase().includes("anthropic api key");
}

const FRIENDLY_MISSING_KEY_MESSAGE =
	"The assistant needs an Anthropic key - add one in Settings > AI.";

/** Every other reason is already written for a person (see turn-service.ts
 * and the route) and passes through unchanged. */
function mapErrorReason(reason: string): string {
	return isMissingAnthropicKey(reason) ? FRIENDLY_MISSING_KEY_MESSAGE : reason;
}

// --- op summaries -> AssistantProposedOp ------------------------------------

/** Prefixes `op-summary.ts`'s `summarizeValidatedCall` actually produces, in
 * priority order. The driver only ever sends the rendered sentence (see the
 * file docstring's point 2), so this is the only place an icon can be
 * recovered from - keep it in step with that module by hand if it changes. */
function iconForSummary(summary: string): AssistantOpIcon {
	if (summary.startsWith("Cut ")) return "cut";
	if (summary.startsWith("Delete ")) return "delete";
	if (summary.startsWith("Extend ") || summary.startsWith("Trim ")) return "extend";
	if (summary.startsWith("Move ")) return "move";
	if (summary.startsWith("Split ")) return "split";
	if (summary.startsWith("Set ") && summary.includes("speed")) return "speed";
	if (summary.startsWith("Add the text ")) return "text";
	if (summary.startsWith("Add the marker ") || summary.startsWith("Add a marker"))
		return "marker";
	if (summary.startsWith("Add ")) return "text"; // add_motion_template: another visual add
	return "marker"; // select_clips and anything unrecognized: closest generic icon
}

/** Best-effort display range or point pulled out of the sentence - "" when
 * nothing timecode-shaped is in there (e.g. "Delete ..."). */
function timecodeForSummary(summary: string): string {
	const range = summary.match(/(\d+(?:\.\d+)?s) to (\d+(?:\.\d+)?s)/);
	if (range) return `${range[1]} - ${range[2]}`;
	const point = summary.match(/\b(\d{1,2}(?::\d{2}){1,2})\b/);
	return point ? point[1] : "";
}

let opIdCounter = 0;
function opFromSummary(summary: string): AssistantProposedOp {
	opIdCounter += 1;
	return {
		id: `real-op-${opIdCounter}`,
		icon: iconForSummary(summary),
		summary,
		timecode: timecodeForSummary(summary),
	};
}

// --- undo handle -> plain function -------------------------------------------

function wrapUndoHandle(undo: { undo: () => boolean }): () => void {
	return () => {
		undo.undo();
	};
}

// --- driver event -> UI event ------------------------------------------------

/** One driver event to zero-or-one UI events (an empty-text `text` event is
 * dropped rather than landing a blank bubble - the driver only sends one of
 * these per leg, so "empty" means the model had nothing to say). */
function mapDriverEvent(event: AssistantTurnEvent): AssistantEvent | null {
	switch (event.type) {
		case "text":
			return event.text ? { type: "text-delta", delta: event.text } : null;
		case "clarifying-question":
			return {
				type: "clarifying-question",
				question: event.question,
				...(event.options ? { quickReplies: event.options } : {}),
			};
		case "proposed-ops":
			return { type: "proposed-ops", ops: event.summaries.map(opFromSummary) };
		case "applied":
			return { type: "applied", count: event.count, undo: wrapUndoHandle(event.undo) };
		case "error":
			return { type: "error", message: mapErrorReason(event.reason) };
		default:
			return null;
	}
}

// --- pull queue ---------------------------------------------------------------

/** Minimal push/pull async queue: `push` before or after a `drain()` pull is
 * waiting, either order works. Backs the subscribe -> async-generator bridge
 * below - this is the whole answer to gap 1 in the file docstring. */
function createAsyncQueue<T>() {
	const buffer: T[] = [];
	const waiters: Array<(result: IteratorResult<T>) => void> = [];
	let closed = false;
	return {
		push(value: T): void {
			if (closed) return;
			const waiter = waiters.shift();
			if (waiter) waiter({ value, done: false });
			else buffer.push(value);
		},
		close(): void {
			if (closed) return;
			closed = true;
			while (waiters.length) {
				waiters.shift()?.({ value: undefined as never, done: true });
			}
		},
		async *drain(): AsyncGenerator<T> {
			for (;;) {
				if (buffer.length) {
					yield buffer.shift() as T;
					continue;
				}
				if (closed) return;
				const result = await new Promise<IteratorResult<T>>((resolve) => {
					waiters.push(resolve);
				});
				if (result.done) return;
				yield result.value;
			}
		},
	};
}

// --- the adapter itself --------------------------------------------------------

/**
 * Wrap an already-constructed `AssistantTurnDriver` into an `AssistantService`
 * - kept separate from driver construction (`createLiveAssistantTurnDriver`
 * below) so tests can stub the driver directly, with no editor, no fetch, and
 * no store involved.
 */
export function createAssistantServiceFromDriver(
	driver: AssistantTurnDriver,
): AssistantService {
	return {
		async *sendTurn(input: AssistantServiceInput): AsyncGenerator<AssistantEvent> {
			const queue = createAsyncQueue<AssistantEvent>();
			const unsubscribe = driver.events.subscribe((event) => {
				const mapped = mapDriverEvent(event);
				if (mapped) queue.push(mapped);
			});
			// `start`/`confirm` never reject in practice (turn-service.ts's `send`
			// catches internally and emits an `error` event instead), but the
			// catch below is the same safety net for a bug there as for one here.
			const action = input.confirmedOps ? driver.confirm() : driver.start(input.prompt);
			action
				.catch((error: unknown) => {
					queue.push({
						type: "error",
						message: mapErrorReason(error instanceof Error ? error.message : String(error)),
					});
				})
				.finally(() => {
					unsubscribe();
					queue.close();
				});
			try {
				yield* queue.drain();
			} finally {
				unsubscribe();
			}
		},
	};
}

/**
 * Build the live driver. `collect` reads a fresh snapshot on every call (the
 * turn service re-validates at execute time, see turn-service.ts's docstring)
 * and the timeline toggles come from the store's CURRENT value at call time,
 * never a stale closure. `mainTrackMagnetEnabled` is the store's real field
 * name (timeline/timeline-store.ts) - `collectAssistantContext` calls it
 * `magnetEnabled`; renamed here, nowhere else.
 */
export function createLiveAssistantTurnDriver(editor: EditorCore): AssistantTurnDriver {
	return createAssistantTurnDriver({
		collect: () => {
			const toggles = useTimelineStore.getState();
			return collectAssistantContext({
				editor,
				transcriptSource: editorTranscriptSource(editor),
				toggles: {
					magnetEnabled: toggles.mainTrackMagnetEnabled,
					rippleEditingEnabled: toggles.rippleEditingEnabled,
					snappingEnabled: toggles.snappingEnabled,
				},
			});
		},
		request: postAssistantTurn,
		editor,
	});
}

/** The real service, built once per editor instance - see
 * `use-assistant-chat.ts` for the memoization that keeps this to one driver
 * (and therefore one held/model-context state) per mount. */
export function createRealAssistantService(editor: EditorCore): AssistantService {
	return createAssistantServiceFromDriver(createLiveAssistantTurnDriver(editor));
}
