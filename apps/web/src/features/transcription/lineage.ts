/**
 * TRANSCRIPT LINEAGE (T16.1) - the data layer that lets the transcript panel show
 * words the timeline no longer contains.
 *
 * THE PROBLEM. `transcript-cache.ts` keys its cache on a hash of every element's
 * media/placement/trims, so ANY edit invalidates it and the next refresh runs a
 * FULL re-transcription of whatever audio survived. The deleted words are gone
 * exactly when the round-16 UI (red pipe bars + per-word restore, T16.2) needs
 * them.
 *
 * THE FIX. Keep the last FULL transcript alongside an ordered journal of the
 * removals applied since (`lineage-types.ts` / `lineage-store.ts`). Everything the
 * panel needs is then derivable:
 *
 *   surviving words  = source words whose midpoint is outside the merged journal
 *                      ranges, remapped through the coordinate map
 *   red pipes        = the runs of removed words between two survivors
 *   restore          = the source range under a chosen subset of a run
 *
 * NOTHING HERE IS NEW MATH. The removal-merge, the midpoint survival rule, the
 * coordinate map and the word partition are the Director's own, imported from
 * `director/cut-utils.ts`, `director/virtual-timeline.ts` and
 * `director/assembled-transcript.ts`, so the panel and the Director can never
 * drift on which words a cut removed. Those modules are pure (their only external
 * imports are type-only), so importing them here costs the panel nothing.
 *
 * COORDINATES. "SOURCE" means the timeline the stored transcript was captured
 * against; "CURRENT" means the live timeline after the active journal prefix. The
 * captured transcript is in source SECONDS; journal ranges are in source TICKS.
 *
 * UNDO/REDO. Handled entirely by `resolveActiveJournal`'s lazy hash-chain match -
 * see the `lineage-store.ts` module comment.
 */

import {
	buildCoordinateMap,
	type AssembledCoordinateMap,
} from "@/features/ai-generate/director/virtual-timeline";
import {
	partitionWordsByRemovals,
	type RemovedWordRun,
} from "@/features/ai-generate/director/assembled-transcript";
import {
	isMidpointContained,
	stableCutId,
	type WordTiming,
} from "@/features/ai-generate/director/cut-utils";
import { computeAudioHash, type AudioHashTracks } from "./audio-hash";
import {
	appendJournalEntry,
	clearLineageRecord,
	readLineageRecord,
	resolveActiveJournal,
	writeLineageRecord,
} from "./lineage-store";
import {
	TRANSCRIPT_LINEAGE_VERSION,
	type LineageJournalEntry,
	type LineageOpMeta,
	type LineageRestorePlan,
	type LineageRestoreRange,
	type LineageSeam,
	type LineageSeamContribution,
	type LineageSegment,
	type LineageSourceRange,
	type LineageSourceSpanSec,
	type LineageView,
	type LineageWord,
	type TranscriptLineageRecord,
	type LineageEditSource,
} from "./lineage-types";

/**
 * Ticks per second - a wasm-free local copy of `@/wasm`'s `TICKS_PER_SECOND`
 * (120_000), kept inline so this module (which the transcript panel imports on
 * every render) stays bun-testable without the opencut-wasm binary. Same
 * precedent as `director/source-map.ts`.
 */
const TICKS_PER_SECOND = 120_000;

/** Floating-point slack for seam/boundary comparisons (well under one frame). */
const EPS = 1e-9;

/** The editor slice the lineage reads. The real `EditorCore` satisfies it. */
export interface LineageEditor {
	project: { getActive: () => { metadata: { id: string } } };
	scenes: { getActiveScene: () => { tracks: AudioHashTracks } };
}

/** The live timeline-audio hash, or "" when it cannot be computed. */
export function safeLineageHash(editor: LineageEditor): string {
	try {
		return computeAudioHash({ tracks: editor.scenes.getActiveScene().tracks });
	} catch {
		return "";
	}
}

function projectIdOf(editor: LineageEditor): string | null {
	try {
		return editor.project.getActive().metadata.id || null;
	} catch {
		return null;
	}
}

// --- Range helpers ---------------------------------------------------------

/** Sort + union a set of tick ranges into disjoint ascending ranges. */
export function mergeSourceRanges(
	ranges: readonly LineageSourceRange[],
): LineageSourceRange[] {
	const sorted = ranges
		.filter((r) => r.end > r.start)
		.map((r) => ({ start: r.start, end: r.end }))
		.sort((a, b) => a.start - b.start);
	const merged: LineageSourceRange[] = [];
	for (const r of sorted) {
		const last = merged[merged.length - 1];
		if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
		else merged.push(r);
	}
	return merged;
}

/** `ranges` minus `holes`, both disjoint + ascending, in ticks. */
function subtractRanges({
	ranges,
	holes,
}: {
	ranges: readonly LineageSourceRange[];
	holes: readonly LineageSourceRange[];
}): LineageSourceRange[] {
	const out: LineageSourceRange[] = [];
	for (const range of ranges) {
		let cursor = range.start;
		for (const hole of holes) {
			if (hole.end <= cursor || hole.start >= range.end) continue;
			if (hole.start > cursor) out.push({ start: cursor, end: hole.start });
			cursor = Math.max(cursor, hole.end);
		}
		if (cursor < range.end) out.push({ start: cursor, end: range.end });
	}
	return out;
}

const ticksToSec = (ticks: number): number => ticks / TICKS_PER_SECOND;
const secToTicks = (sec: number): number => Math.round(sec * TICKS_PER_SECOND);

// --- Geometry --------------------------------------------------------------

/** Everything derived from a record + its active journal prefix. */
interface LineageGeometry {
	map: AssembledCoordinateMap;
	/** Merged removals in SOURCE seconds. */
	removalsSec: LineageSourceSpanSec[];
	/** Merged removals in SOURCE ticks (the same spans). */
	removalsTicks: LineageSourceRange[];
	entries: LineageJournalEntry[];
}

/**
 * The removals still in effect after replaying `entries` IN ORDER: each entry
 * first adds its `ranges` and then subtracts its `restores` (T16.2). Order is
 * what makes remove -> restore -> remove-again land on "removed" instead of
 * cancelling out, which a single global union-then-subtract would get wrong.
 */
export function foldJournalRemovals(
	entries: readonly LineageJournalEntry[],
): LineageSourceRange[] {
	let removals: LineageSourceRange[] = [];
	for (const entry of entries) {
		removals = mergeSourceRanges([...removals, ...entry.ranges]);
		if (entry.restores && entry.restores.length > 0) {
			removals = subtractRanges({
				ranges: removals,
				holes: mergeSourceRanges(entry.restores),
			});
		}
	}
	return removals;
}

function buildGeometry({
	record,
	entries,
}: {
	record: TranscriptLineageRecord;
	entries: readonly LineageJournalEntry[];
}): LineageGeometry {
	const removalsTicks = foldJournalRemovals(entries);
	const removalsSec = removalsTicks.map((r) => ({
		startSec: ticksToSec(r.start),
		endSec: ticksToSec(r.end),
	}));
	// The map clamps to `totalSec`, so it must cover everything the record knows
	// about: a capture total that under-reports (a stub, or trailing silence the
	// duration missed) would clip the last removal and corrupt every later offset.
	let totalSec = record.sourceTotalSec;
	for (const r of removalsSec) totalSec = Math.max(totalSec, r.endSec);
	for (const w of record.words) totalSec = Math.max(totalSec, w.end);
	for (const s of record.segments) totalSec = Math.max(totalSec, s.end);
	return {
		map: buildCoordinateMap({ removals: removalsSec, totalSec }),
		removalsSec,
		removalsTicks,
		entries: [...entries],
	};
}

/** The merged removal spans a run of removed words actually sits inside. */
function spansForRun({
	run,
	removalsSec,
}: {
	run: RemovedWordRun;
	removalsSec: readonly LineageSourceSpanSec[];
}): LineageSourceSpanSec[] {
	return removalsSec.filter((span) =>
		run.words.some((w) =>
			isMidpointContained({
				spanStart: w.start,
				spanEnd: w.end,
				containerStart: span.startSec,
				containerEnd: span.endSec,
			}),
		),
	);
}

/** The journal entries (and the specific ops) that overlap a seam's spans. */
function contributionsFor({
	entries,
	spans,
}: {
	entries: readonly LineageJournalEntry[];
	spans: readonly LineageSourceSpanSec[];
}): LineageSeamContribution[] {
	const out: LineageSeamContribution[] = [];
	const overlaps = (a: LineageSourceRange): boolean =>
		spans.some(
			(s) =>
				ticksToSec(a.start) + EPS < s.endSec && s.startSec + EPS < ticksToSec(a.end),
		);
	for (const entry of entries) {
		if (!entry.ranges.some(overlaps)) continue;
		out.push({
			entryId: entry.id,
			source: entry.source,
			at: entry.at,
			ops: (entry.ops ?? []).filter((op) => overlaps(op)),
		});
	}
	return out;
}

/** A stable id for a seam, derived from the source span it collapses. */
function seamId(spans: readonly LineageSourceSpanSec[]): string {
	const first = spans[0];
	const last = spans[spans.length - 1];
	return `seam-${stableCutId(
		`${(first?.startSec ?? 0).toFixed(3)}:${(last?.endSec ?? 0).toFixed(3)}`,
	)}`;
}

/**
 * What is LEFT of one segment's own span once the journal ranges are subtracted,
 * as a single SOURCE span from the first surviving piece to the last. Null when the
 * removals swallowed the segment whole. Used only by the word-less path below,
 * where there are no words to fold.
 */
function survivingSegmentSpan({
	seg,
	removalsTicks,
}: {
	seg: LineageSegment;
	removalsTicks: readonly LineageSourceRange[];
}): LineageSourceSpanSec | null {
	const pieces = subtractRanges({
		ranges: [{ start: secToTicks(seg.start), end: secToTicks(seg.end) }],
		holes: removalsTicks,
	});
	if (pieces.length === 0) return null;
	return {
		startSec: ticksToSec(pieces[0].start),
		endSec: ticksToSec(pieces[pieces.length - 1].end),
	};
}

/**
 * The surviving segments, derived from the SAME journal fold the view's words come
 * from. A segment owns the words whose midpoint falls inside it; it survives while
 * any of those words do, and a partially cut segment reports only the words it has
 * left, spanning their surviving extent. A segment whose words are all gone is
 * dropped. An untouched segment keeps its original text and bounds verbatim, so an
 * unedited (or fully restored) transcript serializes byte-identically.
 *
 * A capture with no word-level data has nothing to fold, so its segments shrink to
 * whatever the journal ranges left of their own span instead, keeping the text
 * whole (the best the record can say without words).
 *
 * TESTING THE SEGMENT'S OWN MIDPOINT - what this replaces - was the G6 bug: a
 * removal in the MIDDLE of a sentence contains that sentence's midpoint, so the
 * whole segment vanished. Invisible in the panel, which draws `words`, but the
 * Export menu serializes `segments` only, so the entire sentence went missing from
 * every exported .txt/.srt/.csv.
 */
function segmentsFromRecord({
	record,
	geo,
}: {
	record: TranscriptLineageRecord;
	geo: LineageGeometry;
}): LineageSegment[] {
	const isRemoved = (start: number, end: number): boolean =>
		geo.removalsSec.some((r) =>
			isMidpointContained({
				spanStart: start,
				spanEnd: end,
				containerStart: r.startSec,
				containerEnd: r.endSec,
			}),
		);

	const out: LineageSegment[] = [];
	record.segments.forEach((seg, i) => {
		// Half-open ownership everywhere except the final segment, so a word whose
		// midpoint lands exactly on a boundary belongs to the segment after it and
		// the last word of the transcript is never left unowned.
		const owned = record.words.filter((w) =>
			isMidpointContained({
				spanStart: w.start,
				spanEnd: w.end,
				containerStart: seg.start,
				containerEnd: seg.end,
				inclusiveEnd: i === record.segments.length - 1,
			}),
		);

		if (owned.length === 0) {
			const span = survivingSegmentSpan({ seg, removalsTicks: geo.removalsTicks });
			if (!span) return;
			out.push({
				text: seg.text,
				start: geo.map.toAssembled(span.startSec),
				end: geo.map.toAssembled(span.endSec),
			});
			return;
		}

		const kept = owned.filter((w) => !isRemoved(w.start, w.end));
		if (kept.length === 0) return;
		const intact = kept.length === owned.length;
		out.push({
			text: intact ? seg.text : kept.map((w) => w.text.trim()).join(" "),
			start: geo.map.toAssembled(intact ? seg.start : kept[0].start),
			end: geo.map.toAssembled(intact ? seg.end : kept[kept.length - 1].end),
		});
	});
	return out;
}

// --- Read API (what T16.2 consumes) ----------------------------------------

/**
 * The lineage as it applies to the LIVE timeline: surviving words/segments in
 * CURRENT coordinates, the seams where removed words sit between two survivors,
 * and whether the lineage explains the timeline at all.
 *
 * `status: "cannot-explain"` is the caller's signal to re-transcribe and reset
 * (a trim, a move, or new media changed the audio itself, not just its extent).
 */
export function readTranscriptLineage({
	editor,
}: {
	editor: LineageEditor;
}): LineageView {
	const projectId = projectIdOf(editor);
	const record = projectId ? readLineageRecord(projectId) : null;
	if (!record) {
		return { status: "missing", words: [], segments: [], seams: [], activeEntries: [] };
	}
	const liveHash = safeLineageHash(editor);
	const active = resolveActiveJournal({ record, liveHash });
	if (!active.explained) {
		return {
			status: "cannot-explain",
			words: [],
			segments: [],
			seams: [],
			activeEntries: [],
		};
	}
	return { ...viewFromRecord({ record, entries: active.entries }), status: "explained" };
}

/**
 * The pure core of `readTranscriptLineage`: a view for an EXPLICIT journal prefix,
 * with no storage or hashing involved. Exported for tests and for callers that
 * already resolved the prefix.
 */
export function viewFromRecord({
	record,
	entries,
}: {
	record: TranscriptLineageRecord;
	entries: readonly LineageJournalEntry[];
}): LineageView {
	const geo = buildGeometry({ record, entries });
	const partition = partitionWordsByRemovals({
		words: record.words,
		removedSpans: geo.removalsSec,
	});

	const words: LineageWord[] = partition.kept.map((w) => ({
		text: w.text,
		start: geo.map.toAssembled(w.start),
		end: geo.map.toAssembled(w.end),
	}));

	const segments = segmentsFromRecord({ record, geo });

	const seams: LineageSeam[] = [];
	for (const run of partition.removedRuns) {
		const spans = spansForRun({ run, removalsSec: geo.removalsSec });
		if (spans.length === 0) continue;
		seams.push({
			id: seamId(spans),
			atSec: geo.map.toAssembled(spans[0].startSec),
			afterWordIndex: run.beforeKeptIndex,
			removedWords: run.words.map((w) => ({
				text: w.text,
				start: w.start,
				end: w.end,
			})),
			removedSpans: spans,
			removedSec: spans.reduce((acc, s) => acc + (s.endSec - s.startSec), 0),
			contributions: contributionsFor({ entries: geo.entries, spans }),
		});
	}

	return {
		status: "explained",
		words,
		segments,
		seams,
		activeEntries: geo.entries,
		wordsUnavailable: record.wordsUnavailable,
	};
}

// --- Restore ---------------------------------------------------------------

/**
 * The exact SOURCE range(s) to re-insert to bring back part (or all) of a seam,
 * plus where each re-enters the CURRENT timeline and what stays removed
 * afterwards. T16.2 feeds this to a RestoreRangeCommand; nothing here mutates.
 *
 * `wordStartIndex`/`wordEndIndex` are INCLUSIVE indices into `seam.removedWords`
 * and default to the whole run. A selection that includes the run's FIRST word
 * restores from the removal's leading boundary (and likewise for the last word and
 * the trailing boundary), so restoring everything returns exactly the removal
 * spans and the pipe disappears; an interior selection is word-tight, so the
 * leading/trailing silence stays cut. Returns null when the selection is empty.
 */
export function planSeamRestore({
	seam,
	wordStartIndex = 0,
	wordEndIndex = seam.removedWords.length - 1,
	map,
}: {
	seam: LineageSeam;
	wordStartIndex?: number;
	wordEndIndex?: number;
	/** The view's coordinate map, when the caller has one; otherwise the seam's
	 * own `atSec` anchors every range (correct whenever the seam is one span). */
	map?: AssembledCoordinateMap;
}): LineageRestorePlan | null {
	const lo = Math.max(0, wordStartIndex);
	const hi = Math.min(seam.removedWords.length - 1, wordEndIndex);
	if (seam.removedWords.length === 0 || hi < lo) return null;

	const selected = seam.removedWords.slice(lo, hi + 1);
	const spansTicks = seam.removedSpans.map((s) => ({
		start: secToTicks(s.startSec),
		end: secToTicks(s.endSec),
	}));
	const startTicks =
		lo === 0 ? spansTicks[0].start : secToTicks(selected[0].start);
	const endTicks =
		hi === seam.removedWords.length - 1
			? spansTicks[spansTicks.length - 1].end
			: secToTicks(selected[selected.length - 1].end);

	const restored: LineageRestoreRange[] = [];
	for (const span of spansTicks) {
		const start = Math.max(span.start, startTicks);
		const end = Math.min(span.end, endTicks);
		if (end <= start) continue;
		restored.push({
			start,
			end,
			insertAtTicks: map
				? secToTicks(map.toAssembled(ticksToSec(span.start)))
				: secToTicks(seam.atSec),
		});
	}
	if (restored.length === 0) return null;

	const remainingRanges = subtractRanges({ ranges: spansTicks, holes: restored });
	const inRestored = (w: LineageWord): boolean => {
		const mid = secToTicks((w.start + w.end) / 2);
		return restored.some((r) => mid >= r.start && mid < r.end);
	};

	return {
		seamId: seam.id,
		sourceRanges: restored,
		insertAtTicks: secToTicks(seam.atSec),
		restoredSec: restored.reduce((acc, r) => acc + ticksToSec(r.end - r.start), 0),
		remainingRanges,
		remainingWords: seam.removedWords.filter((w) => !inRestored(w)),
		restoredWords: seam.removedWords.filter(inRestored),
	};
}

// --- Capture ---------------------------------------------------------------

/**
 * Replace the lineage for this project with a freshly transcribed transcript.
 * Called after every REAL transcription: the new transcript becomes the capture
 * and the journal starts empty, which is also the reset the cannot-explain path
 * needs (a trim/move/new-media edit invalidates the old lineage outright).
 */
export function resetTranscriptLineage({
	editor,
	words,
	segments,
	sourceTotalSec,
	wordsUnavailable,
	hash,
}: {
	editor: LineageEditor;
	words: readonly LineageWord[];
	segments: readonly LineageSegment[];
	sourceTotalSec: number;
	wordsUnavailable?: boolean;
	/** The hash the transcript was produced against; defaults to the live one. */
	hash?: string;
}): void {
	const projectId = projectIdOf(editor);
	if (!projectId) return;
	const captureHash = hash ?? safeLineageHash(editor);
	if (!captureHash) return;
	const now = Date.now();
	writeLineageRecord({
		version: TRANSCRIPT_LINEAGE_VERSION,
		projectId,
		captureHash,
		words: words.map((w) => ({ text: w.text, start: w.start, end: w.end })),
		segments: segments.map((s) => ({ text: s.text, start: s.start, end: s.end })),
		sourceTotalSec,
		wordsUnavailable,
		journal: [],
		createdAt: now,
		updatedAt: now,
	});
}

/** Forget this project's lineage (the panel's hard reset). */
export function clearTranscriptLineage({ editor }: { editor: LineageEditor }): void {
	const projectId = projectIdOf(editor);
	if (projectId) clearLineageRecord(projectId);
}

/** One Director op as the capture hook receives it: CURRENT-timeline seconds. */
export interface LineageOpInput {
	id: string;
	category?: string;
	reason?: string;
	startSec: number;
	endSec: number;
}

/**
 * Record a removal in the journal. Call BEFORE executing the command (the hash
 * before the edit and the coordinate map the ranges were expressed against are
 * both only readable then), and invoke the returned `commit` once the command has
 * executed - that is when the after-hash exists.
 *
 * `rangesTicks` and `ops` are in CURRENT timeline coordinates; both are carried
 * back to SOURCE through the active journal prefix's map (start on the "start"
 * edge, end on the "end" edge, exactly as `mapAssembledOpsToSource` does), so a
 * span that straddles an earlier cut correctly re-absorbs that cut's gap.
 *
 * Returns null - a silent no-op - when there is no lineage to extend or the
 * current timeline is not one the journal explains. The removal still applies;
 * only the pipe-bar memory of it is skipped, and the next full transcription
 * re-establishes the lineage.
 */
export function beginLineageRemoval({
	editor,
	source,
	rangesTicks,
	ops = [],
}: {
	editor: LineageEditor;
	source: LineageEditSource;
	rangesTicks: readonly LineageSourceRange[];
	ops?: readonly LineageOpInput[];
}): (() => void) | null {
	const projectId = projectIdOf(editor);
	if (!projectId) return null;
	const record = readLineageRecord(projectId);
	if (!record) return null;
	const hashBefore = safeLineageHash(editor);
	if (!hashBefore) return null;
	const active = resolveActiveJournal({ record, liveHash: hashBefore });
	if (!active.explained) return null;

	const { map } = buildGeometry({ record, entries: active.entries });
	const toSourceTicks = (r: { start: number; end: number }): LineageSourceRange => ({
		start: secToTicks(map.toSource(ticksToSec(r.start), "start")),
		end: secToTicks(map.toSource(ticksToSec(r.end), "end")),
	});
	const ranges = mergeSourceRanges(
		rangesTicks.filter((r) => r.end > r.start).map(toSourceTicks),
	);
	if (ranges.length === 0) return null;

	const mappedOps: LineageOpMeta[] = ops.map((op) => {
		const mapped = toSourceTicks({
			start: secToTicks(op.startSec),
			end: secToTicks(op.endSec),
		});
		return {
			id: op.id,
			category: op.category,
			reason: op.reason,
			start: mapped.start,
			end: mapped.end,
		};
	});

	return () => {
		const hashAfter = safeLineageHash(editor);
		// Nothing measurable changed (or the hash is unreadable): recording an entry
		// whose two hashes are equal would make the chain ambiguous, so skip it.
		if (!hashAfter || hashAfter === hashBefore) return;
		const fresh = readLineageRecord(projectId);
		if (!fresh || fresh.captureHash !== record.captureHash) return;
		const entry: LineageJournalEntry = {
			id: `le-${stableCutId(`${hashBefore}:${hashAfter}:${ranges[0].start}`)}-${Date.now().toString(36)}`,
			source,
			ranges,
			at: Date.now(),
			hashBefore,
			hashAfter,
			...(mappedOps.length > 0 ? { ops: mappedOps } : {}),
		};
		const updated = appendJournalEntry({ record: fresh, entry });
		if (updated) writeLineageRecord(updated);
	};
}

/**
 * The restore counterpart of `beginLineageRemoval` (T16.2). Same two-phase
 * protocol - call BEFORE executing the RestoreRangeCommand (the pre-edit hash
 * only exists then) and invoke the returned `commit` after - but the ranges are
 * ALREADY in source ticks (they come straight out of `planSeamRestore`, which
 * works in the record's own coordinates), so nothing is mapped here.
 *
 * The entry is APPENDED rather than editing the removals it puts back; see the
 * `restores` field on `LineageJournalEntry` for why. `source` stays
 * "manual-transcript" because a restore is always a transcript-panel action, and
 * a restore entry has no `ranges`, so it never shows up as a seam contribution.
 */
export function beginLineageRestore({
	editor,
	restoredRanges,
}: {
	editor: LineageEditor;
	restoredRanges: readonly LineageSourceRange[];
}): (() => void) | null {
	const projectId = projectIdOf(editor);
	if (!projectId) return null;
	const record = readLineageRecord(projectId);
	if (!record) return null;
	const hashBefore = safeLineageHash(editor);
	if (!hashBefore) return null;
	const active = resolveActiveJournal({ record, liveHash: hashBefore });
	if (!active.explained) return null;
	const restores = mergeSourceRanges(restoredRanges);
	if (restores.length === 0) return null;

	return () => {
		const hashAfter = safeLineageHash(editor);
		if (!hashAfter || hashAfter === hashBefore) return;
		const fresh = readLineageRecord(projectId);
		if (!fresh || fresh.captureHash !== record.captureHash) return;
		const entry: LineageJournalEntry = {
			id: `lr-${stableCutId(`${hashBefore}:${hashAfter}:${restores[0].start}`)}-${Date.now().toString(36)}`,
			source: "manual-transcript",
			ranges: [],
			restores,
			at: Date.now(),
			hashBefore,
			hashAfter,
		};
		const updated = appendJournalEntry({ record: fresh, entry });
		if (updated) writeLineageRecord(updated);
	};
}

// --- Fast-path refresh -----------------------------------------------------

/** A transcript served from the lineage instead of from the transcriber. */
export interface LineageFastPathTranscript {
	segments: LineageSegment[];
	words?: LineageWord[];
	wordsUnavailable?: boolean;
}

/**
 * The refresh fast path: when the timeline's hash changed but the journal EXPLAINS
 * the change (only removals since capture), remap the stored transcript instead of
 * re-transcribing the surviving audio. Returns null whenever the caller must fall
 * back to a real transcription - no lineage, a change the journal cannot explain,
 * or a word-level request the capture cannot satisfy.
 */
export function getLineageFastPathTranscript({
	editor,
	wantWords = false,
}: {
	editor: LineageEditor;
	wantWords?: boolean;
}): LineageFastPathTranscript | null {
	const projectId = projectIdOf(editor);
	const record = projectId ? readLineageRecord(projectId) : null;
	if (!record) return null;
	// A word-level caller cannot be served from a capture that has no words, unless
	// the capture already learned this device's model cannot produce them (in which
	// case re-transcribing would only fail the same way).
	if (wantWords && record.words.length === 0 && !record.wordsUnavailable) return null;
	const active = resolveActiveJournal({
		record,
		liveHash: safeLineageHash(editor),
	});
	if (!active.explained) return null;
	const view = viewFromRecord({ record, entries: active.entries });
	return {
		segments: view.segments,
		words: record.wordsUnavailable ? undefined : view.words,
		wordsUnavailable: record.wordsUnavailable,
	};
}

/** Re-export so consumers need one import for the word shape the Director uses. */
export type { WordTiming };
