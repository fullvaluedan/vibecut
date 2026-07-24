/**
 * Director taste module (U6 + Round-2 U4) - the self-learning seed.
 *
 * The Review modal's per-op accept/reject decisions are the ground-truth signal:
 * this module aggregates them per CUT CATEGORY (duplicate / filler / pacing /
 * reorder / take / llm) and, once a per-category sample threshold is met, derives
 * a compact plain-language note injected into the next Director prompt. Learning
 * per category (not just per op kind) lets it distinguish "this editor keeps
 * fillers" from "rejects tangent cuts". Device-local (localStorage), no network
 * I/O, clearable in Settings -> AI. Mirrors `preference-store.ts`.
 *
 * Taste v2 (U3, run ledger): the tallies above are session/device-local and
 * reset on a new browser profile. `run-ledger.ts` rides the PROJECT instead (an
 * append-capped history of past runs), so it is now the source of truth for the
 * category list/labels and op-category resolution (both imported below).
 * This module has no editor/project access of its own (it must stay safe to
 * import from anywhere, including code that mocks `@/core` for unrelated unit
 * tests - a real, observed conflict during this round), so the ledger's
 * compact per-project note is PUSHED in rather than pulled: `ledgerNote` is a
 * plain string field, kept in sync by `DirectorDockShell` (the one
 * always-mounted place with a live `useEditor` subscription) via
 * `setLedgerNote`. `buildDirectorTasteNote` just joins it onto the legacy
 * per-decision note, at the SAME injection seam every existing caller already
 * uses (a zero-arg call - the public API here is unchanged).
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { DirectorOpCategory, DirectorOpKind } from "@framecut/hf-bridge";
import {
	CATEGORY_LABEL,
	DIRECTOR_OP_CATEGORIES,
	resolveDirectorOpCategory,
} from "./run-ledger";

/** One reviewed op outcome. `category` is the op's explicit category when set. */
export interface ReviewDecision {
	op: DirectorOpKind;
	category?: DirectorOpCategory;
	accepted: boolean;
}

interface OpStat {
	accepted: number;
	rejected: number;
}

/** Per-category accept/reject tallies. */
export type DirectorTasteStats = Partial<Record<DirectorOpCategory, OpStat>>;

/** A note fires once a category has at least this many decisions. */
const MIN_SAMPLES = 2;
/** ...and the accept/reject share crosses this fraction. */
const SIGNAL_THRESHOLD = 0.5;

/** Taste v2: the category list and labels now live in `run-ledger.ts` (the
 * source of truth both modules read from - see the file docstring). */
const CATEGORIES = DIRECTOR_OP_CATEGORIES;

/**
 * The taste category for a reviewed op: its explicit category, else derived from
 * the op kind (raw LLM ops). `keep` is informational and carries no signal (null).
 * Delegates to `run-ledger.ts`'s `resolveDirectorOpCategory` so an op buckets
 * identically here and in the run ledger.
 */
function resolveCategory({ op, category }: ReviewDecision): DirectorOpCategory | null {
	return resolveDirectorOpCategory({ op, category });
}

/** Pure: fold a batch of decisions onto the existing stats (immutably). */
export function aggregateDecisions({
	stats,
	decisions,
}: {
	stats: DirectorTasteStats;
	decisions: readonly ReviewDecision[];
}): DirectorTasteStats {
	const next: DirectorTasteStats = { ...stats };
	for (const d of decisions) {
		const cat = resolveCategory(d);
		if (!cat) continue;
		const stat = next[cat] ?? { accepted: 0, rejected: 0 };
		next[cat] = d.accepted
			? { accepted: stat.accepted + 1, rejected: stat.rejected }
			: { accepted: stat.accepted, rejected: stat.rejected + 1 };
	}
	return next;
}

/** Pure: a compact taste note from the stats; empty string when nothing is confident. */
export function deriveTasteNote(stats: DirectorTasteStats): string {
	const lines: string[] = [];
	for (const key of CATEGORIES) {
		const stat = stats[key];
		if (!stat) continue;
		const total = stat.accepted + stat.rejected;
		if (total < MIN_SAMPLES) continue;
		if (stat.rejected / total >= SIGNAL_THRESHOLD) {
			lines.push(
				`The user rejected ${stat.rejected} of ${total} proposed ${CATEGORY_LABEL[key]} — be conservative with ${CATEGORY_LABEL[key]}.`,
			);
		} else if (stat.accepted / total >= SIGNAL_THRESHOLD) {
			lines.push(
				`The user accepted ${stat.accepted} of ${total} proposed ${CATEGORY_LABEL[key]} — that judgment is welcome.`,
			);
		}
	}
	return lines.join(" ");
}

interface DirectorTasteState {
	selfLearningEnabled: boolean;
	opStats: DirectorTasteStats;
	/**
	 * Taste v2: the run ledger's compact per-project note, pushed in by
	 * `DirectorDockShell` whenever the active project's ledger changes (project
	 * load, apply, or a post-apply revision). NOT persisted here - it is
	 * derived from the project, so a stale copy in this browser's localStorage
	 * would be actively wrong the next time a different project opens.
	 */
	ledgerNote: string;
	setSelfLearningEnabled: (enabled: boolean) => void;
	/** Record the Review modal's decisions when a plan is applied. */
	noteReviewDecisions: (decisions: readonly ReviewDecision[]) => void;
	/** Push the run ledger's current note in (see `ledgerNote` above). */
	setLedgerNote: (note: string) => void;
	/** The note injected into the next Director prompt ("" when disabled/empty). */
	buildDirectorTasteNote: () => string;
	clearTaste: () => void;
}

export const useDirectorTasteStore = create<DirectorTasteState>()(
	persist(
		(set, get) => ({
			selfLearningEnabled: true,
			opStats: {},
			ledgerNote: "",
			setSelfLearningEnabled: (enabled) => set({ selfLearningEnabled: enabled }),
			noteReviewDecisions: (decisions) =>
				set((state) => ({
					opStats: aggregateDecisions({ stats: state.opStats, decisions }),
				})),
			setLedgerNote: (note) => set({ ledgerNote: note }),
			// Taste v2: joins the legacy per-decision note (device-local, this
			// browser's opStats) with the run ledger's per-project note (durable,
			// kept in sync via setLedgerNote - see the file docstring). Still a
			// zero-arg call, so every existing caller (run-director.ts,
			// run-highlight.ts, run-assemble.ts) picks this up unchanged.
			buildDirectorTasteNote: () =>
				get().selfLearningEnabled
					? [deriveTasteNote(get().opStats), get().ledgerNote]
							.filter(Boolean)
							.join(" ")
					: "",
			clearTaste: () => set({ opStats: {} }),
		}),
		{
			name: "vibecut-director-taste",
			partialize: (state) => ({
				selfLearningEnabled: state.selfLearningEnabled,
				opStats: state.opStats,
			}),
		},
	),
);
