/**
 * Director taste module (U6 + Round-2 U4) — the self-learning seed.
 *
 * The Review modal's per-op accept/reject decisions are the ground-truth signal:
 * this module aggregates them per CUT CATEGORY (duplicate / filler / pacing /
 * reorder / take / llm) and, once a per-category sample threshold is met, derives
 * a compact plain-language note injected into the next Director prompt. Learning
 * per category (not just per op kind) lets it distinguish "this editor keeps
 * fillers" from "rejects tangent cuts". Device-local (localStorage), no network
 * I/O, clearable in Settings → AI. Mirrors `preference-store.ts`.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { DirectorOpCategory, DirectorOpKind } from "@framecut/hf-bridge";

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

const CATEGORIES: readonly DirectorOpCategory[] = [
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
const CATEGORY_LABEL: Record<DirectorOpCategory, string> = {
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

/**
 * The taste category for a reviewed op: its explicit category, else derived from
 * the op kind (raw LLM ops). `keep` is informational and carries no signal (null).
 */
function resolveCategory({ op, category }: ReviewDecision): DirectorOpCategory | null {
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
