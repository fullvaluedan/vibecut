/**
 * Director taste module (U6) — the minimal self-learning seed.
 *
 * The Review modal's per-op accept/reject decisions are the ground-truth signal:
 * this module aggregates them per op type and, once a per-type sample threshold
 * is met, derives a compact plain-language note injected into the next Director
 * prompt (alongside the existing cut preferences). Device-local (localStorage),
 * no network I/O, clearable in Settings → AI. v0 is capture + inject only — the
 * LLM compression loop is deferred. Mirrors `preference-store.ts`.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { DirectorOpKind } from "@framecut/hf-bridge";

/** One reviewed op outcome. */
export interface ReviewDecision {
	op: DirectorOpKind;
	accepted: boolean;
}

interface OpStat {
	accepted: number;
	rejected: number;
}

/** Per-op-type accept/reject tallies. */
export type DirectorTasteStats = Partial<Record<DirectorOpKind, OpStat>>;

/** A note fires once a type has at least this many decisions. */
const MIN_SAMPLES = 2;
/** ...and the accept/reject share crosses this fraction. */
const SIGNAL_THRESHOLD = 0.5;

const OP_KINDS: readonly DirectorOpKind[] = ["cut", "take_select", "reorder", "keep"];
const OP_LABEL: Record<DirectorOpKind, string> = {
	cut: "cuts",
	take_select: "take selections",
	reorder: "reorders",
	keep: "keeps",
};

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
		const stat = next[d.op] ?? { accepted: 0, rejected: 0 };
		next[d.op] = d.accepted
			? { accepted: stat.accepted + 1, rejected: stat.rejected }
			: { accepted: stat.accepted, rejected: stat.rejected + 1 };
	}
	return next;
}

/** Pure: a compact taste note from the stats; empty string when nothing is confident. */
export function deriveTasteNote(stats: DirectorTasteStats): string {
	const lines: string[] = [];
	for (const key of OP_KINDS) {
		const stat = stats[key];
		if (!stat) continue;
		const total = stat.accepted + stat.rejected;
		if (total < MIN_SAMPLES) continue;
		if (stat.rejected / total >= SIGNAL_THRESHOLD) {
			lines.push(
				`The user rejected ${stat.rejected} of ${total} proposed ${OP_LABEL[key]} — be conservative with ${OP_LABEL[key]}.`,
			);
		} else if (stat.accepted / total >= SIGNAL_THRESHOLD) {
			lines.push(
				`The user accepted ${stat.accepted} of ${total} proposed ${OP_LABEL[key]} — that judgment is welcome.`,
			);
		}
	}
	return lines.join(" ");
}

interface DirectorTasteState {
	selfLearningEnabled: boolean;
	opStats: DirectorTasteStats;
	setSelfLearningEnabled: (enabled: boolean) => void;
	/** Record the Review modal's decisions when a plan is applied. */
	noteReviewDecisions: (decisions: readonly ReviewDecision[]) => void;
	/** The note injected into the next Director prompt ("" when disabled/empty). */
	buildDirectorTasteNote: () => string;
	clearTaste: () => void;
}

export const useDirectorTasteStore = create<DirectorTasteState>()(
	persist(
		(set, get) => ({
			selfLearningEnabled: true,
			opStats: {},
			setSelfLearningEnabled: (enabled) => set({ selfLearningEnabled: enabled }),
			noteReviewDecisions: (decisions) =>
				set((state) => ({
					opStats: aggregateDecisions({ stats: state.opStats, decisions }),
				})),
			buildDirectorTasteNote: () =>
				get().selfLearningEnabled ? deriveTasteNote(get().opStats) : "",
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
