/**
 * Shapes for the per-project TRANSCRIPT LINEAGE (T16.1): the last FULL transcript
 * plus an ordered journal of the removals applied since, so the panel can render
 * surviving AND deleted words without re-transcribing.
 *
 * Types only (no logic, no imports) so the persistence layer, the read API and
 * the UI that consumes it (T16.2) can all depend on this without cycles.
 *
 * COORDINATE CONVENTION. Every timing in the captured transcript (`words`,
 * `segments`) is in SOURCE seconds - the timeline coordinates the transcript was
 * produced against, i.e. the timeline as it stood at `captureHash`. Every journal
 * range and op span is in SOURCE TICKS, mapped back through the coordinate map of
 * the journal prefix that was already in effect when the edit applied. That makes
 * the journal composable: N removals in a row are just N disjoint source spans,
 * regardless of the order the user made them in.
 */

/** Bump when the persisted record shape changes; older records are discarded. */
export const TRANSCRIPT_LINEAGE_VERSION = 1;

/** One transcript word in SOURCE seconds. */
export interface LineageWord {
	start: number;
	end: number;
	text: string;
}

/** One transcript segment in SOURCE seconds. */
export interface LineageSegment {
	start: number;
	end: number;
	text: string;
}

/** Who made the removal. "other" covers non-transcript timeline edits that still
 * only remove time (a ripple delete driven from the timeline, say). */
export type LineageEditSource = "manual-transcript" | "director" | "other";

/** A half-open span in SOURCE ticks. */
export interface LineageSourceRange {
	/** ticks */
	start: number;
	/** ticks */
	end: number;
}

/**
 * One Director op that contributed to a journal entry, carried so a seam can name
 * the cut ("filler", "Removed a repeated phrase") instead of just "a cut". Its
 * span is in SOURCE ticks like every other range here, so seam attribution is a
 * plain overlap test.
 */
export interface LineageOpMeta {
	id: string;
	category?: string;
	reason?: string;
	/** ticks */
	start: number;
	/** ticks */
	end: number;
}

/**
 * One journal event. `hashBefore`/`hashAfter` are the timeline-audio hashes
 * immediately before and after the entry's command executed; they are what makes
 * undo/redo reconciliation possible without holding a command reference (see
 * `resolveActiveJournal`).
 *
 * T16.2 adds `restores`: a per-word RESTORE puts back source the journal had
 * already removed, so it is recorded as its own APPENDED entry rather than by
 * rewriting the earlier removals. Rewriting would have broken the hash chain
 * (the pre-restore timeline would stop being any entry's `hashAfter`, so one
 * Ctrl+Z would land on "cannot-explain") and would have discarded the Director
 * category/reason of every other seam in the same entry. Appending keeps undo
 * and redo of a restore working by the SAME rule as everything else, and keeps
 * the journal composable: fold it in order, adding `ranges` and subtracting
 * `restores` entry by entry (see `foldJournalRemovals` in lineage.ts).
 */
export interface LineageJournalEntry {
	id: string;
	source: LineageEditSource;
	/** Removed spans in SOURCE ticks, sorted and disjoint. */
	ranges: LineageSourceRange[];
	/**
	 * Spans in SOURCE ticks this entry PUT BACK (T16.2 restores). Applied after
	 * `ranges` within the same entry; absent on every removal entry.
	 */
	restores?: LineageSourceRange[];
	/** Wall-clock ms when the entry was recorded. */
	at: number;
	/** Timeline-audio hash immediately BEFORE this entry applied. */
	hashBefore: string;
	/** Timeline-audio hash immediately AFTER this entry applied. */
	hashAfter: string;
	/** Contributing Director ops (source "director" only). */
	ops?: LineageOpMeta[];
}

/** The per-project persisted record. */
export interface TranscriptLineageRecord {
	version: number;
	projectId: string;
	/** The timeline-audio hash the captured transcript was produced against. */
	captureHash: string;
	/** The FULL transcript at capture, in SOURCE seconds. */
	words: LineageWord[];
	segments: LineageSegment[];
	/** Total SOURCE seconds of the timeline at capture. */
	sourceTotalSec: number;
	/** True when words were wanted at capture but the model could not produce them. */
	wordsUnavailable?: boolean;
	/** Removal events since capture, in the order they were applied. */
	journal: LineageJournalEntry[];
	createdAt: number;
	updatedAt: number;
}

/** A journal entry's contribution to one seam. */
export interface LineageSeamContribution {
	entryId: string;
	source: LineageEditSource;
	/** Wall-clock ms of the entry. */
	at: number;
	/** The ops of that entry which actually overlap THIS seam. */
	ops: LineageOpMeta[];
}

/** A span in SOURCE seconds (the read API's outward-facing unit). */
export interface LineageSourceSpanSec {
	startSec: number;
	endSec: number;
}

/**
 * One place where removed content sits between two surviving words: the red pipe
 * T16.2 draws. `atSec` is where it belongs on the CURRENT timeline;
 * `afterWordIndex` is the index into the view's `words` of the surviving word the
 * pipe sits immediately before (`words.length` for a trailing seam).
 */
export interface LineageSeam {
	id: string;
	/** Seconds on the CURRENT timeline. */
	atSec: number;
	afterWordIndex: number;
	/** The removed words, in source order, with SOURCE timings. */
	removedWords: LineageWord[];
	/** The merged source spans this seam collapses. */
	removedSpans: LineageSourceSpanSec[];
	/** Total removed seconds across `removedSpans`. */
	removedSec: number;
	contributions: LineageSeamContribution[];
}

/**
 * - `explained`: the lineage accounts for the live timeline; `words`/`seams` are
 *   authoritative and no re-transcription is needed.
 * - `missing`: no lineage stored for this project yet.
 * - `cannot-explain`: a lineage exists but the live timeline is not any prefix of
 *   its journal (new media, a trim, a move). The caller re-transcribes and resets.
 */
export type LineageStatus = "explained" | "missing" | "cannot-explain";

/** What T16.2 reads to draw surviving words plus red pipes. */
export interface LineageView {
	status: LineageStatus;
	/** Surviving words remapped to CURRENT timeline seconds. */
	words: LineageWord[];
	/** Surviving segments remapped to CURRENT timeline seconds. */
	segments: LineageSegment[];
	seams: LineageSeam[];
	/** The journal prefix currently in effect (empty when nothing is applied). */
	activeEntries: LineageJournalEntry[];
	/** Mirrors the captured transcript's flag. */
	wordsUnavailable?: boolean;
}

/** One SOURCE range to re-insert, plus where it re-enters the CURRENT timeline. */
export interface LineageRestoreRange extends LineageSourceRange {
	/** Insertion point on the CURRENT timeline, in ticks. */
	insertAtTicks: number;
}

/**
 * What a restore needs: the exact SOURCE ranges to re-insert and where they go on
 * the CURRENT timeline. T16.2 feeds this to its RestoreRangeCommand; this task
 * builds the math only.
 */
export interface LineageRestorePlan {
	seamId: string;
	/** Ranges in SOURCE ticks to re-insert, in source order. */
	sourceRanges: LineageRestoreRange[];
	/** The seam's own insertion point on the CURRENT timeline, in ticks. */
	insertAtTicks: number;
	restoredSec: number;
	/** What stays removed at this seam afterwards (empty = the pipe disappears). */
	remainingRanges: LineageSourceRange[];
	/** The words that stay removed afterwards. */
	remainingWords: LineageWord[];
	/** The words this plan restores. */
	restoredWords: LineageWord[];
}
