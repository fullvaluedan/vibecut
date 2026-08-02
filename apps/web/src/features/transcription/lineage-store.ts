/**
 * Persistence for the transcript lineage (T16.1), on the same localStorage
 * discipline as `transcript-cache.ts`: one JSON blob keyed by project id, a
 * 6-project LRU (oldest `updatedAt` evicted first), versioned so a shape change
 * discards stale records instead of mis-reading them, and every write wrapped so a
 * quota error can never break an edit.
 *
 * UNDO RECONCILIATION lives here too, in `resolveActiveJournal`. The journal is
 * NOT reconciled eagerly on undo/redo (nothing reliable fires for `undo()`, which
 * runs no reactors) - it is reconciled LAZILY at read time by matching the LIVE
 * timeline-audio hash against the journal's `hashAfter` chain:
 *
 *   live hash === captureHash            -> zero entries in effect
 *   live hash === journal[i].hashAfter   -> entries 0..i in effect
 *   no match                             -> the lineage cannot explain the timeline
 *
 * That single rule covers undo (the live hash reverts to an earlier link, so the
 * later entries stop being reported), redo (it advances again), and the
 * cannot-explain case (a trim/move/new-media edit lands on a hash that is on no
 * link at all) with no command references, no stack positions, and nothing that
 * can go stale across a page reload. Appending truncates the journal to the active
 * prefix first, which is exactly the redo-stack-clearing semantics of the command
 * manager.
 *
 * Pure + wasm-free apart from the storage probe -> bun-testable.
 */

import {
	TRANSCRIPT_LINEAGE_VERSION,
	type LineageJournalEntry,
	type TranscriptLineageRecord,
} from "./lineage-types";

const LINEAGE_KEY = "vibecut-transcript-lineage";
const MAX_PROJECT_ENTRIES = 6;

/** The two storage methods this module needs. */
interface LineageStorage {
	getItem: (key: string) => string | null;
	setItem: (key: string, value: string) => void;
}

/**
 * `localStorage` when it works, an in-memory map otherwise. Bun's test runtime
 * ships a `localStorage` that THROWS on access, and a browser can refuse it in
 * private mode; either way the lineage must still work for the session rather
 * than crash the panel. Probed once, then cached.
 */
let storage: LineageStorage | null = null;
function getStorage(): LineageStorage {
	if (storage) return storage;
	try {
		localStorage.getItem(LINEAGE_KEY);
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
export function resetLineageStorageForTests(): void {
	storage = null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Read every stored record, dropping anything malformed or on an old version. */
export function readLineageStore(): Record<string, TranscriptLineageRecord> {
	try {
		const raw = getStorage().getItem(LINEAGE_KEY);
		if (!raw) return {};
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed)) return {};
		const out: Record<string, TranscriptLineageRecord> = {};
		for (const [projectId, value] of Object.entries(parsed)) {
			if (!isRecord(value)) continue;
			if (value.version !== TRANSCRIPT_LINEAGE_VERSION) continue;
			if (!Array.isArray(value.journal) || !Array.isArray(value.words)) continue;
			out[projectId] = value as unknown as TranscriptLineageRecord;
		}
		return out;
	} catch {
		return {};
	}
}

/** The record for one project, or null when there is none (or it is stale). */
export function readLineageRecord(projectId: string): TranscriptLineageRecord | null {
	return readLineageStore()[projectId] ?? null;
}

/** Persist one record, evicting the least-recently-updated projects past the cap. */
export function writeLineageRecord(record: TranscriptLineageRecord): void {
	try {
		const store = readLineageStore();
		store[record.projectId] = record;
		const keys = Object.keys(store);
		if (keys.length > MAX_PROJECT_ENTRIES) {
			keys
				.sort((a, b) => store[a].updatedAt - store[b].updatedAt)
				.slice(0, keys.length - MAX_PROJECT_ENTRIES)
				.forEach((key) => delete store[key]);
		}
		getStorage().setItem(LINEAGE_KEY, JSON.stringify(store));
	} catch {
		// The lineage is an optimization - a quota error must never break an edit.
	}
}

/** Forget one project's lineage entirely. */
export function clearLineageRecord(projectId: string): void {
	try {
		const store = readLineageStore();
		if (!(projectId in store)) return;
		delete store[projectId];
		getStorage().setItem(LINEAGE_KEY, JSON.stringify(store));
	} catch {
		// See above.
	}
}

/** The journal prefix in effect for `liveHash`, and whether it explains it at all. */
export interface ActiveJournal {
	entries: LineageJournalEntry[];
	explained: boolean;
}

/**
 * Reconcile the journal against the live timeline-audio hash (see the module
 * comment). Returns the LONGEST matching prefix, so a hash that repeats resolves
 * to the most recent state rather than an older one.
 */
export function resolveActiveJournal({
	record,
	liveHash,
}: {
	record: TranscriptLineageRecord;
	liveHash: string;
}): ActiveJournal {
	for (let i = record.journal.length; i > 0; i--) {
		if (record.journal[i - 1].hashAfter === liveHash) {
			return { entries: record.journal.slice(0, i), explained: true };
		}
	}
	if (liveHash === record.captureHash) return { entries: [], explained: true };
	return { entries: [], explained: false };
}

/**
 * Append one entry, first TRUNCATING the journal to the prefix that `hashBefore`
 * identifies. Undone-then-re-edited history is dropped exactly as the command
 * manager clears its redo stack on the next execute, so the chain
 * `captureHash -> hashAfter -> hashAfter -> ...` stays unbroken by construction.
 * Returns the updated record (unsaved) or null when `hashBefore` is on no link,
 * i.e. the lineage could not explain the timeline the edit was made against.
 */
export function appendJournalEntry({
	record,
	entry,
}: {
	record: TranscriptLineageRecord;
	entry: LineageJournalEntry;
}): TranscriptLineageRecord | null {
	const active = resolveActiveJournal({ record, liveHash: entry.hashBefore });
	if (!active.explained) return null;
	return {
		...record,
		journal: [...active.entries, entry],
		updatedAt: Date.now(),
	};
}
