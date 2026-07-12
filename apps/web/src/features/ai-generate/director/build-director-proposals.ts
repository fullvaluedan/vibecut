/**
 * The Director's pure proposal pipeline (U2). Given the fused senses of a
 * timeline — transcript words + segments, audio features + energy envelope, VAD
 * gaps, clip spans, source elements/assets, optional vision frames — plus an
 * `llm` adapter for the three planning passes, this produces the exact same
 * reviewed operation list the in-app Director builds, with zero browser or store
 * coupling. `run-director.ts` gathers the senses (decode, VAD, frames, store
 * reads, the three route `fetch`es) and calls this; the golden-footage eval
 * imports the SAME module and supplies the senses from a fixture, so the eval
 * measures the real pipeline and not a lookalike (KTD1/KTD2, R2).
 *
 * Landmine (discovery): this file must import ONLY the already-pure detector
 * modules — never `run-director.ts`, `@/wasm`, the editor stores, or the media
 * layer. Timing is in seconds throughout (no ticks), so no `@/wasm` is needed.
 */
import type {
	ContextFlag,
	DirectorAssetSummary,
	DirectorOp,
	DirectorSegment,
	DirectorVisionFrame,
	RedundancyGroup,
	RedundancyLine,
} from "@framecut/hf-bridge";
import type { TranscriptionWord } from "@/transcription/types";
import type { SpeechFeatures } from "./types";
import type { SourceMapElement } from "./source-map";
import type { TranscriptSegment } from "./build-signal-table";
import type { SpeechGap } from "./vad-dead-air";
import { ENERGY_WINDOW_SEC, meanEnergyOverRange } from "./audio-features";
import { buildSignalTable } from "./build-signal-table";
import { detectDuplicateWordCuts } from "./duplicate-words";
import { detectPhraseRepeatCuts } from "./phrase-repeat";
import { detectFillerCuts } from "./filler-words";
import { detectDeadAirCuts } from "./dead-air";
import { detectPacingCuts } from "./pacing";
import { detectNoiseFragmentCuts } from "./noise-fragment";
import { detectTinyClipCuts } from "./tiny-clip";
import { MIN_SURVIVING_CLIP_FRAMES } from "./content-word";
import { detectVadDeadAirCuts } from "./vad-dead-air";
import { snapRemovalOps } from "./snap-cut";
import { refineCutWordBounds } from "./refine-cut-words";
import { resolveTrimVsCut } from "./resolve-trim-vs-cut";
import { justifyCuts } from "./justify-cuts";
import { buildOpeningDebugReport } from "./director-debug";
import { buildRedundancyCatalog } from "./redundancy-catalog";
import { mapContextFlags } from "./context-relevance";
import {
	lexicalBackstopDefaultAccept,
	mapRedundancyGroups,
	shouldRunLexicalRepeatDetectors,
	type RedundancyReviewGroup,
} from "./redundancy-apply";
import { detectSegmentRepeatCuts } from "./segment-repeat";
import { runSecondPass } from "./second-pass";
import { mergeDetectedCuts, stableCutId, type KeeperSpan } from "./cut-utils";
import {
	collectPauseGaps,
	computeEmphasisPauseKeepers,
	computeRepeatAdjacentPauseFloors,
} from "./emphasis-pause";
import { groupTranscriptByAsset } from "./source-map";
import { buildTakeClusters, type KeeperPolicy } from "./take-clusters";
import { detectRedundancyCuts } from "./redundancy";
import { buildAssetCatalog } from "./asset-catalog";
import { scoreImportance, selectProtectedSpans } from "./importance";
import type { NearTieNote } from "./redundancy";

/** A surviving clip sliver up to this many frames (at the project fps) is a cut
 * remnant worth swallowing — covers the reported 2-frame and 13-frame artifacts. */
const REMNANT_FRAMES_TOLERANCE = 15;

/** Silence left behind (frames at the project fps) when tightening a pause that
 * sits next to a repeat/mistake we're cutting anyway (a breath, not a hard splice). */
const PAUSE_FLOOR_FRAMES = 15;

/** Request/response shapes for the three LLM passes. The in-app adapter wraps
 * the existing route `fetch`es; the eval adapter calls the hf-bridge planners
 * directly. Responses are the already-parsed route JSON (KTD2). */
export interface DirectorPlanRequest {
	segments: DirectorSegment[];
	totalSec: number;
	taste?: string;
	catalog?: DirectorAssetSummary[];
	frames?: DirectorVisionFrame[];
	/** Fraction of words to REMOVE (0..0.8); adds the compression contract (U3/KTD4).
	 * Absent = today's timid default. The cache key must include this (see the eval
	 * adapter) so an A/B run with a target doesn't read a no-target cached response. */
	compressionTarget?: number;
}
export interface DirectorPlanResponse {
	plan?: { operations?: DirectorOp[] };
	degraded?: boolean;
	usage?: { inputTokens?: number };
}
export interface DirectorRedundancyRequest {
	lines: RedundancyLine[];
	taste?: string;
}
export interface DirectorRedundancyResponse {
	plan?: { groups?: RedundancyGroup[] };
}
export interface DirectorContextRequest {
	lines: RedundancyLine[];
	taste?: string;
}
export interface DirectorContextResponse {
	plan?: { flags?: ContextFlag[] };
}

/**
 * The three planning passes as an injectable seam. `plan` MUST throw on failure
 * (the Director aborts, as it always has); `redundancy` and `context` may throw
 * on a route error — the pipeline catches and falls back (lexical repeats /
 * skips the out-of-context pass), matching the in-app try/catch exactly (KTD2).
 */
export interface DirectorLlmAdapter {
	plan(input: DirectorPlanRequest): Promise<DirectorPlanResponse>;
	redundancy(input: DirectorRedundancyRequest): Promise<DirectorRedundancyResponse>;
	context(input: DirectorContextRequest): Promise<DirectorContextResponse>;
}

export interface BuildDirectorProposalsInput {
	words: TranscriptionWord[];
	segments: TranscriptSegment[];
	/** Per-segment speech features (parallel to `segments`). */
	features: SpeechFeatures[];
	/** Shared RMS energy envelope (windowed at ENERGY_WINDOW_SEC). */
	envelope: number[];
	/** VAD non-speech gaps; empty when VAD is off or unavailable. */
	gaps: SpeechGap[];
	/** Video clip spans on the timeline, in seconds. */
	clipSpans: { startSec: number; endSec: number }[];
	/** Project fps as a float (numerator/denominator). */
	fps: number;
	/** Main-track source elements, for source mapping + take clustering. */
	elements: SourceMapElement[];
	/** Bin assets (id → name + duration) for the catalog + clip names. */
	assets: { id: string; name: string; durationSec: number }[];
	/** Sampled vision frames; empty for the text-only path. */
	frames?: DirectorVisionFrame[];
	/** Director taste note, when the user has trained one. */
	taste?: string;
	/** Total timeline duration in seconds. */
	totalSec: number;
	config: { vadEnabled: boolean; visionEnabled: boolean };
	/** Take-cluster keeper policy (KTD3/U2). Defaults to keep-last; the eval flips it
	 * to "quality" for the A/B scorecard. In-app default stays "last" until U5 adopts. */
	keeperPolicy?: KeeperPolicy;
	/** Compression target (U3/KTD4): fraction of words to REMOVE (0..0.8). Passed to the
	 * plan pass; absent = today's behavior. The eval computes it from the fixture's truth
	 * ratio; the app passes nothing until U5 decides the in-app default. */
	compressionTarget?: number;
	llm: DirectorLlmAdapter;
	onProgress?: (detail: string) => void;
	/** Emits the in-app toasts (vision degrade is handled by the plan adapter);
	 * omitted in the eval so the pipeline stays side-effect-free. */
	onNotice?: (notice: { kind: "info" | "warning"; message: string }) => void;
	signal?: AbortSignal;
}

export interface BuildDirectorProposalsResult {
	operations: DirectorOp[];
	nearTies: NearTieNote[];
	redundancyGroups: RedundancyReviewGroup[];
	/** The capped importance floor (advisory protected spans). */
	protectedSpans: KeeperSpan[];
	/** Apply-time spans the coalescer must never swallow. */
	applyProtectedSpans: { startSec: number; endSec: number }[];
	redundancyRan: boolean;
}

/**
 * Build the Director's reviewed operation list from fused senses. Pure given its
 * inputs (the `llm` adapter is the only I/O seam). Extracted verbatim from
 * `run-director.ts` — the detector block through `justifyCuts` +
 * `applyProtectedSpans` — so the app and the eval share one pipeline (R2/R5).
 */
export async function buildDirectorProposals(
	input: BuildDirectorProposalsInput,
): Promise<BuildDirectorProposalsResult> {
	const {
		words,
		segments,
		features,
		envelope,
		gaps,
		clipSpans,
		fps: fpsFloat,
		elements,
		assets,
		frames = [],
		taste,
		totalSec,
		config,
		keeperPolicy = "last",
		compressionTarget,
		llm,
		onProgress,
		onNotice,
		signal,
	} = input;
	const abort = () => {
		if (signal?.aborted) throw new Error("Cancelled");
	};

	// Always-on word-level cleanup (NOT repeat detectors): doubled words, dead air,
	// fillers, pacing — the LLM works at segment level and misses these. The REPEAT
	// detectors (phrase-repeat, segment-repeat) are computed here but only INCLUDED
	// when the dedicated LLM redundancy pass didn't run (R7 fallback, gated below).
	// Doubled words are a stutter/MISTAKE — kept as its own const so it can join the
	// repeat/mistake proximity set that disqualifies an emphasis pause (U2).
	const duplicateWordCuts = detectDuplicateWordCuts({ words });
	const wordCuts = [
		...duplicateWordCuts,
		...detectDeadAirCuts({ words }),
		...detectFillerCuts({ words }),
		...detectPacingCuts({ segments }),
	];
	const phraseRepeatCuts = detectPhraseRepeatCuts({ words });
	// Segment-level consecutive-repeat backstop (fallback only). Drop any that overlap
	// a word-level / phrase-repeat cut so the layers don't double up in the review.
	const segmentRepeatCuts = detectSegmentRepeatCuts({ segments }).filter(
		(op) =>
			![...wordCuts, ...phraseRepeatCuts].some(
				(w) => w.startSec < op.endSec && op.startSec < w.endSec,
			),
	);
	abort();

	// Non-speech noise guard (issue D): a short, loud, WORD-LESS blip between/around
	// the transcript (a bump, breath-pop, room noise) is invisible to every text-
	// driven detector and to the LLM. Scan the gaps over the energy envelope and flag
	// the fragments for review.
	const noiseCuts = detectNoiseFragmentCuts({ features, envelope, windowSec: ENERGY_WINDOW_SEC });

	// Micro-clip sweep (2P-U2): a stray sub-floor video clip (no speech, not a removal
	// remnant) survives every other layer, and the reorder can even promote it to the
	// head. Flag any clip shorter than the shared MIN_SURVIVING_CLIP_FRAMES floor; the
	// word-aware split auto-removes content-free shards and leaves content-bearing ones
	// as opt-in rows. clipSpans + the fps are shared with the cut-remnant snap below.
	const tinyClipCuts = detectTinyClipCuts({
		clips: clipSpans,
		minDurationSec: MIN_SURVIVING_CLIP_FRAMES / fpsFloat,
		words,
		// Auto-accept needs the shard to overlap SPEECH (F6): a wordless clip outside
		// any segment is what a deliberate visual insert looks like, so it stays opt-in.
		segments,
	});

	// VAD dead-air (Plan A / U5, default ON per U2/KTD3, still a user override): the
	// Silero VAD pass ran upstream (run-director) and handed us its NON-speech `gaps`;
	// here we filter them into reviewable "dead air" cuts, the silent "just sitting
	// there" a transcript can't see. Overlap-filtered against the other detected cuts
	// so it can't double with pacing / dead-air.
	let vadDeadAirCuts: DirectorOp[] = [];
	if (config.vadEnabled) {
		// Overlap-dedup only against DEFAULT-ACCEPTED rows (X4): an opt-in row (an
		// unchecked tiny-clip shard, a review-only noise fragment) must not veto the
		// only default remover of the silence around it, or a shattered timeline's
		// edge silence ships with neither the shard nor the gap removed.
		const acceptedOverlapSources = [...wordCuts, ...noiseCuts, ...tinyClipCuts].filter(
			(other) => other.defaultAccept !== false,
		);
		// Energy test for edge gaps (X5): Silero gaps are NON-speech, not silence. A
		// music sting / b-roll cold open reads as a gap but carries real energy, so
		// compare each gap's mean RMS against the median SPEECH segment energy; at or
		// above the ratio it is deliberate audio, opt-in rather than auto-removed.
		const speechEnergies = features.map((f) => f.energy).sort((a, b) => a - b);
		const medianSpeechEnergy =
			speechEnergies.length > 0
				? speechEnergies[Math.floor(speechEnergies.length / 2)]
				: 0;
		const ENERGETIC_GAP_RATIO = 0.35;
		const isEnergetic = (gap: { startSec: number; endSec: number }): boolean =>
			medianSpeechEnergy > 0 &&
			meanEnergyOverRange({
				envelope,
				windowSec: ENERGY_WINDOW_SEC,
				startSec: gap.startSec,
				endSec: gap.endSec,
			}) >=
				medianSpeechEnergy * ENERGETIC_GAP_RATIO;
		vadDeadAirCuts = detectVadDeadAirCuts({
			gaps,
			totalSec,
			isEnergetic,
		}).filter(
			(op) =>
				!acceptedOverlapSources.some(
					(other) => other.startSec < op.endSec && op.startSec < other.endSec,
				),
		);
		abort();
	}

	// Keep-side signal (Phase B / U1-U4): score each segment's emphasis/anchor
	// importance. It rides the signal table as an advisory "imp" column and yields a
	// CAPPED set of high-value spans (never the whole timeline) that the merge below
	// protects from removal — alongside the take-cluster keepers and the LLM keep ops.
	const importance = scoreImportance({ segments, features });
	const protectedSpans = selectProtectedSpans({ segments, importance });

	// Take-aware redundancy (U4/U6): cluster same-line spans across the assembled
	// clips (and far apart within one), rank the best take, and flag the redundant
	// ones as review ops. Keeper spans are protected in the merge below so a cluster
	// can never lose every take (KTD7). With no clusters (single-take / no repeats)
	// this is a no-op: no grp column, no catalog block — byte-identical request.
	onProgress?.("Comparing takes...");
	const assetTranscripts = groupTranscriptByAsset({
		segments,
		elements,
	});
	const takeClusters = buildTakeClusters({ assetTranscripts, features, keeperPolicy });
	// Keep-last: each cluster keeps its LATEST take and cuts the earlier near-
	// identical ones within the recency window. `nearTies` is empty (the rare A/B
	// "stitch" choice is the LLM planner's, not this deterministic step).
	const { ops: redundancyOps, nearTies } = detectRedundancyCuts({ clusters: takeClusters });
	const keepers: KeeperSpan[] = takeClusters.map((cluster) => {
		const keeper = cluster.members[cluster.keeperIndex];
		return { startSec: keeper.startSec, endSec: keeper.endSec };
	});
	// Map each clustered segment to a short grp id (C1, C2…) for the signal table, so
	// the planner SEES which rows are alternate takes and skips re-cutting them (U5/KTD3).
	const clusterIds = new Map<number, string>();
	takeClusters.forEach((cluster, ci) => {
		for (const member of cluster.members) {
			clusterIds.set(Math.round(member.startSec * 1000) / 1000, `C${ci + 1}`);
		}
	});
	// Per-clip catalog (U2/U5): the planner reasons over the bin, not a 6-char hash.
	const catalog: DirectorAssetSummary[] = buildAssetCatalog({
		assetTranscripts,
		features,
		assets: assets.map((a) => ({
			id: a.id,
			name: a.name,
			durationSec: a.durationSec,
		})),
	}).map((entry) => ({
		name: entry.name,
		durationSec: entry.durationSec,
		segmentCount: entry.segmentCount,
		firstLine: entry.firstLine,
		lastLine: entry.lastLine,
	}));
	abort();

	const signalTable = buildSignalTable({
		segments,
		features,
		elements,
		clusterIds,
		importance,
	});
	abort();

	onProgress?.("Directing...");
	const res = await llm.plan({
		segments: signalTable,
		totalSec,
		taste: taste || undefined,
		// Catalog only helps with ≥2 clips; omitting it for one clip keeps the
		// single-recording request byte-identical to the pre-asset-context path.
		...(catalog.length >= 2 ? { catalog } : {}),
		...(frames.length > 0 ? { frames } : {}),
		// Compression contract (U3): only sent when set, so a no-target run stays
		// byte-identical to the pre-U3 request (and cache key).
		...(compressionTarget !== undefined ? { compressionTarget } : {}),
	});
	const data = res;
	// Tag the LLM ops "vision" when the visual pass actually ran (frames sent AND
	// the backend wasn't degraded to text-only), so the review badge + per-category
	// taste learn vision cuts separately from text-only ones.
	const usedVision = frames.length > 0 && data?.degraded !== true;
	const rawPlanOps = Array.isArray(data?.plan?.operations)
		? data.plan.operations
		: [];
	const planOps: DirectorOp[] = usedVision
		? rawPlanOps.map((op) => ({ ...op, category: "vision" }))
		: rawPlanOps;
	// The LLM's keep ops (U4) mark load-bearing spans the imp score may underrate;
	// they protect (never remove), so fold them into the keeper set alongside the
	// take-cluster keepers and the capped high-value spans (U3).
	const llmKeepSpans: KeeperSpan[] = [];
	for (const op of planOps) {
		if (op?.op === "keep") {
			const startSec = Number(op.startSec);
			const endSec = Number(op.endSec);
			if (Number.isFinite(startSec) && Number.isFinite(endSec) && endSec > startSec) {
				llmKeepSpans.push({ startSec, endSec });
			}
		}
	}
	// Fold the deterministic cuts (word/phrase/dead-air/filler/pacing + the new
	// take/repeat redundancy ops) into the LLM plan, dropping any that overlap a cut
	// it already made AND any that would delete a protected span — take-cluster keeper,
	// capped high-value span, or LLM keep (KTD2/KTD7) — then hand off to the Review modal.
	// Dedicated LLM redundancy pass (R1) — the focused repeat-catcher. On success it is
	// the authority and the lexical repeat detectors stay silent (R7); on a route error
	// it falls through to them. Non-throwing (KTD-5).
	// The numbered-transcript catalog, shared by the redundancy pass and the new
	// out-of-context pass (U3 Part B) so both reason over the same lines.
	const redundancyLines = buildRedundancyCatalog({
		segments,
		features,
		elements,
		clipNameByAssetId: new Map(assets.map((a) => [a.id, a.name])),
	});
	let redundancyCuts: DirectorOp[] = [];
	let redundancyReviewGroups: RedundancyReviewGroup[] = [];
	let redundancyRan = false;
	// Out-of-context pass (U3 Part B): read the FULL transcript, infer the video's
	// throughline, and flag lines whose dialog does not fit it (tangents, abandoned
	// thoughts, meta-asides, wrong-video content). A flag at/above the shared accept
	// threshold default-accepts so clear mistakes leave the video (2P-U4); the
	// uncertain band stays an opt-in row Dan reviews. Non-throwing: a route error
	// skips Part B entirely. Mapped to ops + overlap-filtered at the merge below.
	let contextFlags: ContextFlag[] = [];
	// The two LLM passes read the SAME catalog and neither consumes the other's
	// output, so they run CONCURRENTLY: awaiting them back-to-back added a full LLM
	// round-trip of pure wait to every Director run (review F9). Each stays
	// individually non-throwing, so Promise.all never rejects.
	const redundancyPass = async () => {
		try {
			const rData = await llm.redundancy({
				lines: redundancyLines,
				taste: taste || undefined,
			});
			const groups = Array.isArray(rData?.plan?.groups) ? rData.plan.groups : [];
			const mapped = mapRedundancyGroups({ groups });
			redundancyCuts = mapped.cuts;
			redundancyReviewGroups = mapped.groups;
			redundancyRan = true;
		} catch {
			// route error → fall through to the lexical repeat detectors (KTD-5)
		}
	};
	const contextPass = async () => {
		if (segments.length === 0) return;
		try {
			const cData = await llm.context({
				lines: redundancyLines,
				taste: taste || undefined,
			});
			contextFlags = Array.isArray(cData?.plan?.flags) ? cData.plan.flags : [];
		} catch {
			// route error → skip the out-of-context pass (it is an enhancement)
		}
	};
	onProgress?.("Checking repeats and the throughline...");
	await Promise.all([redundancyPass(), contextPass()]);
	shouldRunLexicalRepeatDetectors(); // always run now (U5/R5), kept for intent
	abort();

	// Fold the always-on cleanup + the lexical repeat detectors into the LLM plan,
	// protecting take-cluster keepers + the importance floor + LLM keeps. The repeat
	// detectors run ADDITIVELY alongside the LLM pass (U5/R5): when the LLM pass ran
	// they are a backstop for repeats it missed. Phrase-repeat cuts are VERBATIM n-gram
	// matches (>=4 consecutive identical tokens, i.e. clearly-duplicate content), so they
	// auto-accept by default even when additive, letting obvious repeats leave the
	// timeline without row-toggling (U1/KTD2, high-confidence-only). The softer near-
	// identical backstops (segment-repeat + the take-cluster redundancyOps) stay accept-
	// OFF review rows (opt-in, never auto-cut newly-surfaced content, per OQ3/R7) when
	// additive, and only on route-error fallback are they the sole authority and keep
	// the accepted default.
	const withBackstopAccept = (op: DirectorOp, verbatim: boolean): DirectorOp =>
		lexicalBackstopDefaultAccept({ verbatim, redundancyRan })
			? op
			: { ...op, defaultAccept: false };
	const lexicalRepeatCuts = [
		...phraseRepeatCuts.map((op) => withBackstopAccept(op, true)),
		...segmentRepeatCuts.map((op) => withBackstopAccept(op, false)),
		...redundancyOps.map((op) => withBackstopAccept(op, false)),
	];
	// Emphasis-pause protection (#4/U2): keep a short, speech-bounded in-dialog pause
	// as a deliberate beat unless a repeat/mistake sits next to it. The repeat/mistake
	// spans must be known FIRST (they disqualify a pause), so collect every repeat- and
	// mistake-sourced cut in scope, then protect the qualifying inter-segment gaps via
	// keepers — mergeDetectedCuts drops the pacing / vad-dead-air removals over them,
	// suppressing ALL pause-removing sources at once (R2/KTD2). No words -> no keepers.
	const repeatMistakeSpans = [
		...duplicateWordCuts,
		...phraseRepeatCuts,
		...segmentRepeatCuts,
		...redundancyOps,
		...redundancyCuts,
	].map((op) => ({ startSec: op.startSec, endSec: op.endSec }));
	// Emphasis-pause PROTECTION sees segment gaps PLUS word-level gaps (X3): beats
	// live inside segments too, and VAD detects gaps anywhere, so protection must see
	// the same pauses. This WIDENING is protection-only: it must not feed the
	// pause-FLOOR cuts below, or intra-sentence word gaps near a repeat would spawn
	// new auto-accepted pacing cuts the segment-only version never made (review RX2).
	const pauseGaps = collectPauseGaps({ segments, words });
	const segmentPauseGaps = collectPauseGaps({ segments, words: [] });
	const emphasisPauseKeepers = computeEmphasisPauseKeepers({
		gaps: pauseGaps,
		words,
		repeatSpans: repeatMistakeSpans,
	});
	// The full protected-span set, in one place (X8): take-cluster keepers, the capped
	// importance floor, LLM keep ops, and emphasis-pause keepers. Both merges and the
	// apply-time protection derive from this, so a new keeper class is one edit, not
	// three spread sites that can silently drift.
	const allKeepers = [
		...keepers,
		...protectedSpans,
		...llmKeepSpans,
		...emphasisPauseKeepers,
	];
	// 15-frame floor (#3): a pause that WOULD be a beat but sits next to a repeat/
	// mistake is disqualified above (no keeper), so it would otherwise stay whole. It's
	// part of the mess we're cutting there anyway, so tighten it to a PAUSE_FLOOR_FRAMES
	// breath instead of leaving the full pause. Added as removals below; they can't be
	// protected away because these gaps have no keeper (the near-repeat test excluded them).
	const pauseFloorCuts: DirectorOp[] = computeRepeatAdjacentPauseFloors({
		gaps: segmentPauseGaps, // segment-only (RX2): word gaps protect, never cut
		words,
		repeatSpans: repeatMistakeSpans,
		floorSec: PAUSE_FLOOR_FRAMES / fpsFloat,
	}).map((cut) => ({
		id: `pausefloor-${stableCutId(`${cut.startSec.toFixed(3)}:${cut.endSec.toFixed(3)}`)}`,
		op: "cut",
		startSec: cut.startSec,
		endSec: cut.endSec,
		reason: "Tightened pause next to a repeat/mistake (left a short breath)",
		confidence: 0.6,
		category: "pacing",
	}));
	// Out-of-context flags → cut ops (U3 Part B, 2P-U4), dropped where they overlap a
	// removal another detector already made, so a context row never doubles a repeat /
	// dead-air / redundancy cut. High-confidence flags fold in default-ACCEPTED, the
	// uncertain band accept-OFF, protected by the same keepers as the other backstops.
	const contextCuts = mapContextFlags({
		flags: contextFlags,
		existingCuts: [
			...wordCuts,
			...noiseCuts,
			...tinyClipCuts,
			...vadDeadAirCuts,
			...lexicalRepeatCuts,
			...pauseFloorCuts,
			...redundancyCuts,
		],
	});
	const baseMerged = mergeDetectedCuts({
		planOps,
		extraOps: [
			...wordCuts,
			...noiseCuts,
			...tinyClipCuts,
			...vadDeadAirCuts,
			...lexicalRepeatCuts,
			...pauseFloorCuts,
			...contextCuts,
		],
		keepers: allKeepers,
	}).filter((op) => op.op !== "keep"); // protection is invisible in normal mode (KTD6)
	// Redundancy cuts are the redundancy AUTHORITY (KTD-7): folded in protected ONLY by
	// explicit LLM keep ops — the capped importance floor must not veto them.
	const mergedOps =
		redundancyRan && redundancyCuts.length > 0
			? mergeDetectedCuts({
					// A redundancy take is removed WHOLE. Drop any cleaning removal
					// (filler/pause/dead-air) fully INSIDE a redundancy span first —
					// otherwise that small contained cut would dedup the bigger redundancy
					// cut away (mergeDetectedCuts drops an extraOp overlapping a surviving
					// removal), leaving most of the take in AND killing its review row. The
					// redundancy cut subsumes the contained one, so nothing is lost. Reorders
					// are never removals — always keep them.
					planOps: baseMerged.filter(
						(op) =>
							op.op === "reorder" ||
							!redundancyCuts.some(
								(rc) => rc.startSec <= op.startSec && op.endSec <= rc.endSec,
							),
					),
					extraOps: redundancyCuts,
					// Carry the emphasis-pause keepers through the SECOND pass too, so a
					// protected pause survives both merges. Today no redundancy cut lands on a
					// protected gap (the proximity check disqualifies any gap near one upstream),
					// but re-passing the keepers hardens that invariant instead of relying on it.
					keepers: [...llmKeepSpans, ...emphasisPauseKeepers],
				}).filter((op) => op.op !== "keep")
			: baseMerged;
	// Virtual second pass (2P-U3): re-analyze the Director's OWN compressed output.
	// Compression reveals adjacency: two verbatim takes >60s apart only become close
	// enough to match once the material between them is cut, so apply the default-
	// accepted cuts to the transcript virtually and re-run the deterministic detectors
	// on the shortened result, mapping any new findings back to original coordinates.
	// Deterministic + transcript-only (no re-transcription, no LLM re-runs), capped at
	// 3 passes, folded into the SAME review and undo. Pure: it computes ops only, the
	// same keepers protect each pass, and the extra ops flow through the SAME snap/
	// coalesce chain below as the pass-1 cuts.
	const secondPass = runSecondPass({
		ops: mergedOps,
		words,
		segments,
		keepers: allKeepers,
		redundancyRan,
	});
	if (secondPass.extraOps.length > 0) {
		const extraPasses = secondPass.passesRun - 1;
		onNotice?.({
			kind: "info",
			message: `Director second pass: found ${secondPass.extraOps.length} more cut${secondPass.extraOps.length === 1 ? "" : "s"} the compression revealed (${extraPasses} extra pass${extraPasses === 1 ? "" : "es"}).`,
		});
	}
	const withSecondPass = [...mergedOps, ...secondPass.extraOps].sort(
		(a, b) => a.startSec - b.startSec,
	);
	// Issue E: snap each cut's edges to a nearby low-energy trough so a removal
	// begins and ends in the quiet BETWEEN sounds, not mid-word. Reuses the noise
	// guard's envelope; reorder ops are left untouched.
	const energySnapped = snapRemovalOps({ ops: withSecondPass, envelope });
	// Word-boundary refinement (U1/R1/KTD2): energy snap finds acoustic troughs, but a
	// trough can still fall mid-word and amputate a kept fragment ("So", "phone."). Move
	// any removal edge that lands inside a word onto its nearest gap — shrink to exclude
	// the word, or swallow it whole when its midpoint is in the cut — so trim-vs-cut and
	// justifyCuts below judge word-safe edges. Fail-open with no words. (KTD1: overwrites
	// startSec/endSec in place — the apply path reads only those.)
	const wordRefined = refineCutWordBounds({ ops: energySnapped, words });
	// Trim-vs-cut (U4/KTD4): a removal whose edge lands within a few frames of a clip
	// boundary is aligned to it so the removal TRIMS that clip edge (swallowing the
	// 2-frame / 13-frame slivers a cut left) instead of fragmenting the clip; a removal
	// with both edges mid-clip stays a ripple-cut. Reuses the clipSpans + fps above.
	// (Adjacent same-source slices are then merged post-apply by the consolidation pass.)
	const trimmed = resolveTrimVsCut({
		ops: wordRefined,
		clipStartsSec: clipSpans.map((c) => c.startSec),
		clipEndsSec: clipSpans.map((c) => c.endSec),
		toleranceSec: REMNANT_FRAMES_TOLERANCE / fpsFloat,
	});
	// No unnecessary cuts (2P-U5/R9): revert any sub-floor removal that splices two
	// content words in continuous speech and carries no concrete reason, so a boundary
	// is never created mid-sentence for nothing. Real pauses (silence removals) keep
	// their flanking words a floor apart and are untouched. Fail-open with no words.
	const operations = justifyCuts({
		ops: trimmed,
		words,
		floorSec: MIN_SURVIVING_CLIP_FRAMES / fpsFloat,
	});
	// Spans the APPLY-time coalescer must never swallow (review F5): every plan-time
	// keeper (a word-free protected pause has no word-guard protection at apply) plus
	// each cut justify reverted just above (re-swallowing it would re-create the exact
	// unjustified boundary 2P-U5 removed). The review surfaces add the user-rejected
	// rows at apply time.
	const justifyKept = new Set(operations);
	const applyProtectedSpans = [
		...[...keepers, ...protectedSpans, ...llmKeepSpans, ...emphasisPauseKeepers].map(
			(k) => ({ startSec: k.startSec, endSec: k.endSec }),
		),
		...trimmed
			.filter((op) => !justifyKept.has(op))
			.map((op) => ({ startSec: op.startSec, endSec: op.endSec })),
	];
	// Issue A investigation: opt-in opening-redundancy report (set window.__directorDebug
	// = true in the console before running). Shows the opening transcript, pairwise
	// similarity vs the merge bar, and whether the LLM proposed a cut there — so a
	// paraphrased opening repeat can be tuned against the REAL data, not a guess.
	if (typeof window !== "undefined" && window.__directorDebug) {
		console.log(buildOpeningDebugReport({ segments, planOps, operations }));
	}
	// Vision degrade / cost notice (R3/R4) is emitted by the in-app plan adapter,
	// which owns the toast + `formatVisionNotice` (browser-only import) — the pure
	// pipeline stays free of the media layer. Reference the flag so the extraction is
	// visibly faithful to the in-app tagging.
	void usedVision;
	void config.visionEnabled;

	return {
		operations,
		nearTies,
		redundancyGroups: redundancyReviewGroups,
		protectedSpans,
		applyProtectedSpans,
		redundancyRan,
	};
}
