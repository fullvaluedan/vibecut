/**
 * Take clustering (U3): group transcript spans that cover the SAME line into
 * clusters, so the Director can keep the best take/instance and flag the rest.
 *
 * Members are raw timeline segments (the unit the signal table already uses). A
 * pair is LINKED when their lexical similarity (U1) clears HIGH_SIMILAR and they
 * are eligible: cross-asset pairs always (alternate takes), same-asset pairs only
 * when separated by MIN_SAME_ASSET_GAP_SEC (a far-apart restart/callback, not two
 * adjacent parallel lines — adjacent verbatim repeats are phrase-repeat's job).
 * Links are unioned into clusters.
 *
 * KTD2: every member carries its TIMELINE [startSec,endSec) — the coordinate the
 * removal path uses. (Source time is for transcript grouping only and never
 * leaves U3.) KTD5: the keeper is the LATEST take ("the last attempt is the
 * keeper after stumbles") — recency wins outright, audio quality no longer
 * overrides it. The redundancy step then cuts the earlier near-identical takes
 * that fall within its keep-last window. KTD6: a far-apart same-asset cluster
 * (callback/recap risk) is `lowConfidence`.
 *
 * Pure + wasm-free → bun-testable. Pre-bucketing by shared content token keeps
 * the pairwise cost off the O(n²) worst case on long, repeat-free transcripts.
 */

import { contentTokens, HIGH_SIMILAR, similarity } from "./text-similarity";
import type { AssetTranscript } from "./source-map";
import type { CandidateSpan } from "./candidate-pool";
import type { SpeechFeatures } from "./types";

/** Same-asset members must be at least this far apart (s) to count as a repeat. */
export const MIN_SAME_ASSET_GAP_SEC = 3;
/** A same-asset cluster spanning more than this (s) is callback territory → low confidence. */
export const CALLBACK_GAP_SEC = 60;
/** Penalty subtracted from a member's loudness when it reads as filler. */
const FILLER_PENALTY = 0.2;

/** One member of a take cluster, in TIMELINE coordinates. */
export interface ClusterMember {
	/** Index into the flattened candidate list (stable within one run). */
	index: number;
	assetId: string;
	/** Timeline start (seconds) — the coordinate removals use. */
	startSec: number;
	/** Timeline end (seconds). */
	endSec: number;
	text: string;
	/** Audio quality score (loudness minus a filler penalty); 0 when no features. */
	audioScore: number;
}

/** A group of spans covering the same line. */
export interface TakeCluster {
	/** `take` = members span ≥2 source clips; `repeat` = one clip restating itself. */
	kind: "take" | "repeat";
	/** Members sorted by timeline start. */
	members: ClusterMember[];
	/** Index INTO `members` of the keeper — always the LATEST take (keep-last). */
	keeperIndex: number;
	/** True for a far-apart same-asset cluster (callback/recap risk). */
	lowConfidence: boolean;
	/** Min pairwise similarity across the cluster (conservative cluster cohesion). */
	similarity: number;
}

interface Candidate {
	index: number;
	assetId: string;
	startSec: number;
	endSec: number;
	text: string;
	audioScore: number;
}

function startKey(sec: number): number {
	return Math.round(sec * 1000) / 1000;
}

/** Union-find with path compression. */
function find({ parent, i }: { parent: number[]; i: number }): number {
	let root = i;
	while (parent[root] !== root) root = parent[root];
	let node = i;
	while (parent[node] !== root) {
		const next = parent[node];
		parent[node] = root;
		node = next;
	}
	return root;
}

function union({ parent, a, b }: { parent: number[]; a: number; b: number }): void {
	const ra = find({ parent, i: a });
	const rb = find({ parent, i: b });
	if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
}

/** Two same-asset spans are eligible to link only when far enough apart. */
function sameAssetGapOk({ a, b }: { a: Candidate; b: Candidate }): boolean {
	const gap = Math.max(a.startSec, b.startSec) - Math.min(a.endSec, b.endSec);
	return gap >= MIN_SAME_ASSET_GAP_SEC;
}

/**
 * Build take clusters from per-asset transcripts + per-segment audio features.
 * Returns only multi-member clusters (a lone span is not a take). Empty input,
 * or input with no repeats, returns `[]`.
 */
export function buildTakeClusters({
	assetTranscripts,
	features,
}: {
	assetTranscripts: readonly AssetTranscript[];
	features: readonly SpeechFeatures[];
}): TakeCluster[] {
	const featureByStart = new Map<number, SpeechFeatures>();
	for (const f of features) featureByStart.set(startKey(f.startSec), f);

	// Flatten to candidates, joining audio for the keeper ranking.
	const candidates: Candidate[] = [];
	for (const transcript of assetTranscripts) {
		for (const seg of transcript.segments) {
			const f = featureByStart.get(startKey(seg.start));
			const audioScore = f ? f.loudnessRelative - (f.fillerCandidate ? FILLER_PENALTY : 0) : 0;
			candidates.push({
				index: candidates.length,
				assetId: transcript.assetId,
				startSec: seg.start,
				endSec: seg.end,
				text: seg.text,
				audioScore,
			});
		}
	}
	if (candidates.length < 2) return [];
	return clusterCandidates({ candidates });
}

/**
 * Shared clustering core: token-bucket → similarity union-find → groups →
 * TakeClusters (keeper = the latest take). Operates on pre-flattened candidates so
 * both the timeline path (`buildTakeClusters`) and the bin-wide path
 * (`buildTakeClustersFromPool`) reuse it verbatim.
 */
function clusterCandidates({
	candidates,
}: {
	candidates: Candidate[];
}): TakeCluster[] {
	if (candidates.length < 2) return [];

	// Pre-bucket: only pairs sharing a content token are worth scoring.
	const tokenToIndices = new Map<string, number[]>();
	const candidateTokens: Set<string>[] = [];
	for (const cand of candidates) {
		const tokens = contentTokens(cand.text);
		candidateTokens.push(tokens);
		for (const token of tokens) {
			const list = tokenToIndices.get(token);
			if (list) list.push(cand.index);
			else tokenToIndices.set(token, [cand.index]);
		}
	}

	const parent = candidates.map((_, i) => i);
	const checked = new Set<string>();
	for (let i = 0; i < candidates.length; i++) {
		// Gather distinct partners sharing ≥1 content token with i.
		const partners = new Set<number>();
		for (const token of candidateTokens[i]) {
			for (const j of tokenToIndices.get(token) ?? []) {
				if (j > i) partners.add(j);
			}
		}
		for (const j of partners) {
			const pairKey = `${i}:${j}`;
			if (checked.has(pairKey)) continue;
			checked.add(pairKey);
			const a = candidates[i];
			const b = candidates[j];
			const crossAsset = a.assetId !== b.assetId;
			if (!crossAsset && !sameAssetGapOk({ a, b })) continue;
			if (similarity({ a: a.text, b: b.text }) >= HIGH_SIMILAR) {
				union({ parent, a: i, b: j });
			}
		}
	}

	// Group by root.
	const groups = new Map<number, Candidate[]>();
	for (const cand of candidates) {
		const root = find({ parent, i: cand.index });
		const list = groups.get(root);
		if (list) list.push(cand);
		else groups.set(root, [cand]);
	}

	const clusters: TakeCluster[] = [];
	for (const group of groups.values()) {
		if (group.length < 2) continue;
		const members = [...group]
			.sort((a, b) => a.startSec - b.startSec)
			.map((c) => ({
				index: c.index,
				assetId: c.assetId,
				startSec: c.startSec,
				endSec: c.endSec,
				text: c.text,
				audioScore: c.audioScore,
			}));

		const assetIds = new Set(members.map((m) => m.assetId));
		const kind = assetIds.size >= 2 ? "take" : "repeat";

		// Keeper: the LATEST take ("the last attempt is the keeper after stumbles").
		// members are sorted ascending by timeline start, so the last one is latest.
		const keeperIndex = members.length - 1;

		// Callback guard: a far-apart same-asset cluster is low confidence. Measure
		// the cluster's start-to-start extent (not end-to-start, which a long first
		// member would shrink below the threshold).
		const span = members[members.length - 1].startSec - members[0].startSec;
		const lowConfidence = kind === "repeat" && span > CALLBACK_GAP_SEC;

		// Conservative cohesion: the weakest pairwise similarity in the cluster.
		let minSim = 1;
		for (let i = 0; i < members.length; i++) {
			for (let j = i + 1; j < members.length; j++) {
				minSim = Math.min(minSim, similarity({ a: members[i].text, b: members[j].text }));
			}
		}

		clusters.push({ kind, members, keeperIndex, lowConfidence, similarity: minSim });
	}

	return clusters;
}

/**
 * Cluster takes across the WHOLE bin (FrameCut auto-assemble): the same candidate
 * pool, but in SOURCE coordinates spanning every clip — so an unused retake in
 * the bin clusters with its keeper just like a placed one. Reuses the clustering
 * core verbatim; the keeper is still the latest take.
 */
export function buildTakeClustersFromPool({
	pool,
}: {
	pool: readonly CandidateSpan[];
}): TakeCluster[] {
	const candidates: Candidate[] = pool.map((span, index) => ({
		index,
		assetId: span.assetId,
		startSec: span.sourceStartSec,
		endSec: span.sourceEndSec,
		text: span.text,
		audioScore: span.audio
			? span.audio.loudnessRelative -
				(span.audio.fillerCandidate ? FILLER_PENALTY : 0)
			: 0,
	}));
	return clusterCandidates({ candidates });
}
