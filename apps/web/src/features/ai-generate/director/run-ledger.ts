/**
 * Director run ledger (taste v2, U3): a per-PROJECT, append-capped history of
 * Director "cut" review runs. `taste.ts`'s existing per-category accept/reject
 * tallies (`opStats`) live in a device-local zustand store, so they reset on a
 * new browser profile and never distinguish one project from another. This
 * ledger rides the PROJECT itself instead (same seam as `textStyles` - see
 * `features/text-styles/project-styles.ts`), so what the Director learns
 * about a project's footage survives closing VibeCut and stays with that
 * project specifically.
 *
 * One record per run, captured at the two points a decision becomes a fact:
 *  - the plan OPENS for review: `startRunRecord` snapshots what the pipeline
 *    PROPOSED and what defaulted ON, before any user decision exists.
 *  - the plan is APPLIED: `recordApplyDecisions` folds the user's final
 *    decisions onto that snapshot (toggled on/off from the default, and how
 *    many ended up applied).
 * A third fact lands later, if it happens: the round-9 persistent applied
 * review lets the user un-check a row AFTER it was already applied. That is a
 * stronger "the Director over-cut here" signal than a pre-apply toggle, so it
 * is tracked separately (`recordPostApplyRevisions`) and folded onto the most
 * recent record.
 *
 * Every function here is pure; the project-persistence wrapper (read the
 * project's `runLedger`, compute the next value, write it back) lives at the
 * call sites in `director-plan-store.ts` and `director-cut-panel.tsx`, which
 * already have a live `editor` to persist through - this module never touches
 * storage, zustand, or the editor itself, so it stays safe for the storage
 * service to import directly (no heavy runtime chain, mirroring the
 * `normalizeTextStyles` precedent).
 */

import type { DirectorOp, DirectorOpCategory, DirectorOpKind } from "@framecut/hf-bridge";

/** Keep at most this many runs; the oldest drops off first. */
export const MAX_LEDGER_RUNS = 20;

/** Hard cap on the ledger's OWN contribution to the injected taste note - a
 * few hundred characters, so a long project history can never balloon the
 * Director prompt. */
export const MAX_LEDGER_NOTE_CHARS = 300;

/** Every category the ledger (and taste.ts) tracks. Moved here from taste.ts
 * (U3): this module is now the source of truth for the category list and
 * labels, since both the ledger's aggregation and taste.ts's legacy
 * per-decision note need the identical set. */
export const DIRECTOR_OP_CATEGORIES: readonly DirectorOpCategory[] = [
	"duplicate",
	"filler",
	"pacing",
	"reorder",
	"take",
	"llm",
	"vision",
	"repeat",
	"deadair",
	"noise",
	"redundancy",
	"context",
	"retake",
	"structural",
	"speculation",
	"join",
];

export const CATEGORY_LABEL: Record<DirectorOpCategory, string> = {
	duplicate: "duplicate-word cuts",
	filler: "filler cuts",
	pacing: "pacing cuts",
	reorder: "reorders",
	take: "take selections",
	llm: "cuts",
	vision: "vision-based cuts",
	repeat: "repeated-phrase cuts",
	deadair: "dead-air cuts",
	noise: "noise-fragment cuts",
	redundancy: "redundancy cuts",
	context: "out-of-context cuts",
	retake: "retake cuts",
	structural: "structural section drops",
	speculation: "trailing-speculation cuts",
	join: "Join cleanup",
};

const CATEGORY_SET: ReadonlySet<string> = new Set(DIRECTOR_OP_CATEGORIES);

/**
 * The taste category for one op: its explicit category, else derived from the
 * op kind (raw LLM ops). `keep` (and any other kind with no mapping) carries
 * no signal (null). Shared by `taste.ts`'s per-decision aggregation and this
 * module's per-run counting, so an op buckets identically either way.
 */
export function resolveDirectorOpCategory({
	op,
	category,
}: {
	op: DirectorOpKind;
	category?: DirectorOpCategory;
}): DirectorOpCategory | null {
	if (category) return category;
	switch (op) {
		case "take_select":
			return "take";
		case "reorder":
			return "reorder";
		case "cut":
			return "llm";
		default:
			return null; // keep
	}
}

/** Per-category counts for one run. Every field starts at 0 and only grows. */
export interface RunLedgerCategoryCounts {
	/** Ops the pipeline offered in this category, regardless of default. */
	proposed: number;
	/** Of those, the ones that started checked (defaultAccept !== false). */
	defaultAccepted: number;
	/** Started unchecked (opt-in), ended checked at apply time. */
	toggledOn: number;
	/** Started checked (recommended), ended unchecked at apply time. */
	toggledOff: number;
	/** Actually accepted at apply time (the count that hit the timeline). */
	applied: number;
	/** Applied, then un-checked afterward in the persistent applied review. */
	revisedOff: number;
}

function emptyCounts(): RunLedgerCategoryCounts {
	return {
		proposed: 0,
		defaultAccepted: 0,
		toggledOn: 0,
		toggledOff: 0,
		applied: 0,
		revisedOff: 0,
	};
}

/** One run's outcome, per category. */
export interface RunLedgerRecord {
	/** Epoch ms when the run's plan opened for review. */
	at: number;
	categories: Partial<Record<DirectorOpCategory, RunLedgerCategoryCounts>>;
}

/**
 * Read the ledger off a project-like object. The field is optional, so every
 * project saved before this feature reads as an empty list (mirrors
 * `readTextStyles`).
 */
export function readRunLedger({
	project,
}: {
	project: { runLedger?: RunLedgerRecord[] } | null | undefined;
}): RunLedgerRecord[] {
	return project?.runLedger ?? [];
}

/**
 * Plan-open snapshot: proposed + default-accepted counts per category, before
 * any user decision exists. Everything else in the record fills in later.
 */
export function startRunRecord({
	operations,
}: {
	operations: readonly DirectorOp[];
}): RunLedgerRecord {
	const categories: RunLedgerRecord["categories"] = {};
	for (const op of operations) {
		const cat = resolveDirectorOpCategory(op);
		if (!cat) continue;
		const counts = categories[cat] ?? emptyCounts();
		counts.proposed += 1;
		if (op.defaultAccept !== false) counts.defaultAccepted += 1;
		categories[cat] = counts;
	}
	return { at: Date.now(), categories };
}

/**
 * Fold the user's apply-time decisions onto an open-time record (pure,
 * immutable). Per category: how many opt-in rows they turned ON, how many
 * recommended rows they turned OFF, and how many ended up applied.
 */
export function recordApplyDecisions({
	record,
	operations,
	decisions,
}: {
	record: RunLedgerRecord;
	operations: readonly DirectorOp[];
	decisions: Readonly<Record<string, boolean>>;
}): RunLedgerRecord {
	const categories: RunLedgerRecord["categories"] = { ...record.categories };
	for (const op of operations) {
		const cat = resolveDirectorOpCategory(op);
		if (!cat) continue;
		const counts = { ...(categories[cat] ?? emptyCounts()) };
		const defaultOn = op.defaultAccept !== false;
		const finalOn = Boolean(decisions[op.id]);
		if (finalOn) counts.applied += 1;
		if (!defaultOn && finalOn) counts.toggledOn += 1;
		if (defaultOn && !finalOn) counts.toggledOff += 1;
		categories[cat] = counts;
	}
	return { ...record, categories };
}

/** Append a finished record, capped to the last MAX_LEDGER_RUNS (FIFO). */
export function appendRunRecord({
	ledger,
	record,
}: {
	ledger: readonly RunLedgerRecord[];
	record: RunLedgerRecord;
}): RunLedgerRecord[] {
	const next = [...ledger, record];
	return next.length > MAX_LEDGER_RUNS
		? next.slice(next.length - MAX_LEDGER_RUNS)
		: next;
}

/**
 * Post-apply revisions (round-9 persistent review): fold every op that went
 * from accepted to un-checked WHILE ALREADY APPLIED onto the most recent
 * ledger record. `before`/`after` are decision maps (op id -> checked) from
 * immediately before and after the toggle that triggered this; a no-op
 * (returns `ledger` unchanged) when nothing reversed or the ledger is empty
 * (nothing to attribute the revision to - the run that produced these ops was
 * never recorded, e.g. it predates this feature).
 */
export function recordPostApplyRevisions({
	ledger,
	operations,
	before,
	after,
}: {
	// Mutable (not `readonly`): the no-op paths below return this SAME array
	// reference back unchanged, which a `readonly` parameter can't satisfy
	// against the mutable `RunLedgerRecord[]` return type.
	ledger: RunLedgerRecord[];
	operations: readonly DirectorOp[];
	before: Readonly<Record<string, boolean>>;
	after: Readonly<Record<string, boolean>>;
}): RunLedgerRecord[] {
	if (ledger.length === 0) return ledger;
	const revisedIds = operations
		.filter((op) => before[op.id] === true && after[op.id] !== true)
		.map((op) => op.id);
	if (revisedIds.length === 0) return ledger;

	const opById = new Map(operations.map((op) => [op.id, op]));
	const last = ledger[ledger.length - 1];
	const categories: RunLedgerRecord["categories"] = { ...last.categories };
	for (const id of revisedIds) {
		const op = opById.get(id);
		if (!op) continue;
		const cat = resolveDirectorOpCategory(op);
		if (!cat) continue;
		const counts = { ...(categories[cat] ?? emptyCounts()) };
		counts.revisedOff += 1;
		categories[cat] = counts;
	}
	return [...ledger.slice(0, -1), { ...last, categories }];
}

function isFiniteNonNegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isCategoryCounts(value: unknown): value is RunLedgerCategoryCounts {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return (
		isFiniteNonNegative(v.proposed) &&
		isFiniteNonNegative(v.defaultAccepted) &&
		isFiniteNonNegative(v.toggledOn) &&
		isFiniteNonNegative(v.toggledOff) &&
		isFiniteNonNegative(v.applied) &&
		isFiniteNonNegative(v.revisedOff)
	);
}

/**
 * Defensive read of whatever came back out of storage, the same shape as
 * `normalizeTextStyles`/`normalizeBookmarks`: anything that is not a usable
 * record is dropped rather than crashing the project load, and any category
 * key outside the known list is stripped so a hand-edited record can't smuggle
 * junk into the taste prompt. Also re-caps defensively (a hand-edited file
 * could carry more than `MAX_LEDGER_RUNS`).
 */
export function normalizeRunLedger({ raw }: { raw: unknown }): RunLedgerRecord[] {
	if (!Array.isArray(raw)) return [];
	const records = raw
		.map((item): RunLedgerRecord | null => {
			if (typeof item !== "object" || item === null) return null;
			const rec = item as Record<string, unknown>;
			if (!isFiniteNonNegative(rec.at)) return null;

			const categories: RunLedgerRecord["categories"] = {};
			const rawCategories = rec.categories;
			if (typeof rawCategories === "object" && rawCategories !== null) {
				for (const [key, value] of Object.entries(
					rawCategories as Record<string, unknown>,
				)) {
					if (!CATEGORY_SET.has(key)) continue;
					if (!isCategoryCounts(value)) continue;
					categories[key as DirectorOpCategory] = value;
				}
			}
			return { at: rec.at, categories };
		})
		.filter((r): r is RunLedgerRecord => r !== null);

	return records.length > MAX_LEDGER_RUNS
		? records.slice(records.length - MAX_LEDGER_RUNS)
		: records;
}

/** A category needs at least this many default-accepted samples (summed
 * across the ledger) before either signal below fires - one run's 1-of-1
 * should never read as a trend. */
const LEDGER_MIN_SAMPLES = 3;
/** Applied/default-accepted share at or above this reads as "keep it up". */
const LEDGER_HIGH_ACCEPT_SHARE = 0.95;
/** (toggled off + revised off)/default-accepted share at or above this reads
 * as "the Director over-cuts here". Checked first: a reversal is a stronger,
 * costlier-to-earn signal than a plain acceptance count, so it wins when both
 * would fire for the same category. */
const LEDGER_REVERSAL_SHARE = 0.4;

interface CategoryTotals {
	defaultAccepted: number;
	applied: number;
	reversed: number;
	runs: number;
}

function totalsByCategory(
	ledger: readonly RunLedgerRecord[],
): Partial<Record<DirectorOpCategory, CategoryTotals>> {
	const totals: Partial<Record<DirectorOpCategory, CategoryTotals>> = {};
	for (const record of ledger) {
		for (const key of Object.keys(record.categories) as DirectorOpCategory[]) {
			const counts = record.categories[key];
			if (!counts) continue;
			const t = totals[key] ?? { defaultAccepted: 0, applied: 0, reversed: 0, runs: 0 };
			t.defaultAccepted += counts.defaultAccepted;
			t.applied += counts.applied;
			t.reversed += counts.toggledOff + counts.revisedOff;
			t.runs += 1;
			totals[key] = t;
		}
	}
	return totals;
}

/**
 * Reduce the whole ledger to a compact plain-language note (or "" when the
 * ledger is empty or nothing crosses the sample threshold), hard-capped to
 * `MAX_LEDGER_NOTE_CHARS`. Feeds into `taste.ts`'s `buildDirectorTasteNote` at
 * the existing injection seam.
 */
export function deriveLedgerTasteNote(ledger: readonly RunLedgerRecord[]): string {
	if (ledger.length === 0) return "";
	const totals = totalsByCategory(ledger);
	const lines: string[] = [];
	for (const key of DIRECTOR_OP_CATEGORIES) {
		const t = totals[key];
		if (!t || t.defaultAccepted < LEDGER_MIN_SAMPLES) continue;
		const runWord = t.runs === 1 ? "run" : "runs";
		if (t.reversed / t.defaultAccepted >= LEDGER_REVERSAL_SHARE) {
			lines.push(
				`Across the last ${t.runs} ${runWord}, the user removed ${t.reversed} of ${t.defaultAccepted} default-accepted ${CATEGORY_LABEL[key]} - stay conservative.`,
			);
		} else if (t.applied / t.defaultAccepted >= LEDGER_HIGH_ACCEPT_SHARE) {
			const pct = Math.round((t.applied / t.defaultAccepted) * 100);
			lines.push(
				`${CATEGORY_LABEL[key]} are accepted ${pct}%+ across the last ${t.runs} ${runWord} - stay aggressive.`,
			);
		}
	}
	const note = lines.join(" ");
	return note.length > MAX_LEDGER_NOTE_CHARS
		? `${note.slice(0, MAX_LEDGER_NOTE_CHARS - 3).trimEnd()}...`
		: note;
}
