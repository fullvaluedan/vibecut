/**
 * Per-project persistence for the Assistant chat history (T17.3), on the same
 * localStorage discipline as `features/transcription/lineage-store.ts`: one
 * JSON blob keyed by project id, versioned so a shape change discards stale
 * records instead of mis-reading them, capped so one project's chat can never
 * grow unbounded, and every write wrapped so a quota error can never break an
 * edit. A small LRU across projects (mirroring the lineage store) keeps the
 * blob itself bounded too.
 *
 * `AssistantMessage.undo` (a live function) is never round-tripped: it is not
 * declared on the persisted shape below, and `JSON.stringify` silently drops
 * function-valued properties, so a reload shows the same "Applied: N changes"
 * chip with Undo simply unavailable (see assistant-reducer.ts's docstring).
 *
 * Pure + wasm-free apart from the storage probe -> bun-testable.
 */

import { capMessages, type AssistantMessage } from "./assistant-reducer";

export const ASSISTANT_HISTORY_VERSION = 1;
/** Per-project cap (T17.3 spec: "capped ~100 messages"). */
export const MAX_MESSAGES_PER_PROJECT = 100;
/** Cross-project LRU cap, same order of magnitude as lineage-store's. */
const MAX_PROJECT_ENTRIES = 10;

const HISTORY_KEY = "vibecut-assistant-history";

export type PersistedAssistantMessage = Omit<AssistantMessage, "undo">;

export interface AssistantHistoryRecord {
	version: number;
	projectId: string;
	updatedAt: number;
	messages: PersistedAssistantMessage[];
}

interface HistoryStorage {
	getItem: (key: string) => string | null;
	setItem: (key: string, value: string) => void;
}

/** `localStorage` when it works, an in-memory map otherwise (Bun's test
 * runtime and private-mode browsers can both refuse real localStorage). */
let storage: HistoryStorage | null = null;
function getStorage(): HistoryStorage {
	if (storage) return storage;
	try {
		localStorage.getItem(HISTORY_KEY);
		storage = localStorage;
	} catch {
		const memory = new Map<string, string>();
		storage = {
			getItem: (key) => memory.get(key) ?? null,
			setItem: (key, value) => {
				memory.set(key, value);
			},
		};
	}
	return storage;
}

/** Test seam: drop the cached storage probe (and any in-memory fallback data). */
export function resetAssistantHistoryStorageForTests(): void {
	storage = null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Read every stored record, dropping anything malformed or on an old version. */
export function readAssistantHistoryStore(): Record<string, AssistantHistoryRecord> {
	try {
		const raw = getStorage().getItem(HISTORY_KEY);
		if (!raw) return {};
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed)) return {};
		const out: Record<string, AssistantHistoryRecord> = {};
		for (const [projectId, value] of Object.entries(parsed)) {
			if (!isRecord(value)) continue;
			if (value.version !== ASSISTANT_HISTORY_VERSION) continue;
			if (!Array.isArray(value.messages)) continue;
			out[projectId] = value as unknown as AssistantHistoryRecord;
		}
		return out;
	} catch {
		return {};
	}
}

/** The message history for one project, or an empty list when there is none
 * (or it is stale/unreadable). */
export function readAssistantHistory(projectId: string): PersistedAssistantMessage[] {
	return readAssistantHistoryStore()[projectId]?.messages ?? [];
}

/**
 * Low-level write: persist one already-built record as-is (including its
 * `version`), evicting the least-recently-updated projects past the
 * cross-project cap. Exported mainly as a test seam (mirrors
 * `writeLineageRecord`'s shape in lineage-store.ts) so a stale-version record
 * can be written directly without this module stamping over it; production
 * code should use `writeAssistantHistory` below.
 */
export function writeAssistantHistoryRecord(record: AssistantHistoryRecord): void {
	try {
		const store = readAssistantHistoryStore();
		store[record.projectId] = record;
		const keys = Object.keys(store);
		if (keys.length > MAX_PROJECT_ENTRIES) {
			keys
				.sort((a, b) => store[a].updatedAt - store[b].updatedAt)
				.slice(0, keys.length - MAX_PROJECT_ENTRIES)
				.forEach((key) => delete store[key]);
		}
		getStorage().setItem(HISTORY_KEY, JSON.stringify(store));
	} catch {
		// Chat history is a convenience - a quota error must never break the editor.
	}
}

/** Persist one project's message list, capping to the last N messages. */
export function writeAssistantHistory({
	projectId,
	messages,
	now,
}: {
	projectId: string;
	messages: readonly AssistantMessage[];
	now: number;
}): void {
	writeAssistantHistoryRecord({
		version: ASSISTANT_HISTORY_VERSION,
		projectId,
		updatedAt: now,
		messages: capMessages(messages, MAX_MESSAGES_PER_PROJECT).map(
			({ undo: _undo, ...persisted }) => persisted,
		),
	});
}

/** Forget one project's chat history entirely (not currently wired to any UI
 * action, kept for parity with `clearLineageRecord` and future "Clear chat"). */
export function clearAssistantHistory(projectId: string): void {
	try {
		const store = readAssistantHistoryStore();
		delete store[projectId];
		getStorage().setItem(HISTORY_KEY, JSON.stringify(store));
	} catch {
		// Best-effort, same as above.
	}
}
