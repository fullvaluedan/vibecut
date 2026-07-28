// --- LLM verify sub-pass (FrameCut, Director recall-precision review) ---
//
// The recall passes (retake at WORD granularity, structural at SECTION granularity)
// hunt aggressively for removable material and OVER-propose on purpose: a missed cut
// ships in the final video, a spare review row costs nothing. This pass is the
// precision counterweight the eval named. It reads EVERY recall candidate at once and
// returns one verdict per candidate: keep it, reject it (removing the span would
// damage the finished cut), or tighten it (the span bleeds past the flub it names).
//
// Verdicts map back by candidate INDEX ([C0]..[Cn]), never by op id, so the model's
// hallucination surface stays as small as the L#/w# discipline in the finder passes.
// A tighten narrows through the SAME reference contract the finders use
// (`llm-reference-sanitizer.ts`): a retake candidate tightens via GLOBAL word indices,
// a structural candidate via line ids. Each tighten resolves INDIVIDUALLY (one op per
// resolver call): `resolveReferencedOps` sorts and drops overlaps, so a batched
// resolve would scramble the index pairing and silently drop tightens whose narrowed
// ranges overlap each other.
//
// Fail-open like every other pass: zero candidates never call the LLM, a malformed
// response yields ZERO verdicts (everything passes through unverified), and nothing
// throws. Module shape mirrors `llm-structural` (prompt builder + schema + sanitizer +
// planVerify).

import { planJson, type TokenUsage } from "./author";
import type { RedundancyLine } from "./llm-redundancy";
import {
	resolveReferencedOps,
	type RawReferencedOp,
	type ReferenceCatalog,
	type ReferenceWord,
} from "./llm-reference-sanitizer";
import type { ClaudeAuth } from "./types";

/**
 * Bumped on every WORDING change to the verify prompt. The eval cache keys on the
 * pass INPUT payload, so a prompt revision without an input change would silently
 * replay stale cached verdicts; the adapter folds this version into the payload so
 * wording changes bust the cache (the KTD7 discipline, learned the hard way when
 * prompt v2's gate re-run cache-hit v1's verdicts).
 */
export const VERIFY_PROMPT_VERSION = 7;

/** Which recall pass produced a candidate (fixes which anchors it tightens through). */
export type VerifyCategory = "retake" | "structural";

/** The three verdicts the verifier can return for a candidate. */
export type VerifyVerdictKind = "keep" | "reject" | "tighten";

/**
 * One OFFERED join-fragment row (round 12 U2/R3): a short run of kept words left
 * stranded between two accepted cuts in the ASSEMBLED result. The final-read side
 * of the verify pass judges each one against the assembled transcript: swallow it
 * (the viewer loses nothing nameable) or keep it (swallowing would cost the viewer
 * something specific). Round 13 reframed that criterion from "is it well formed"
 * to "does it earn its screen time". Verdicts key back by `id` (the join op's
 * stable id), never by index - the fragment set is tiny and the id survives the
 * round trip verbatim.
 */
export interface VerifyJoinFragment {
	/** The join op's stable id; the verdict echoes it verbatim. */
	id: string;
	/** The stranded kept text between the two cuts. */
	text: string;
	startSec: number;
	endSec: number;
	/** Up to ~15 KEPT words immediately before the fragment (assembled order). */
	contextBefore: string;
	/** Up to ~15 KEPT words immediately after the fragment (assembled order). */
	contextAfter: string;
}

/** The two verdicts the final read can return for a join fragment. */
export type VerifyJoinVerdictKind = "swallow" | "keep";

/** One join-fragment verdict, keyed back to its fragment by `id`. */
export interface VerifyJoinVerdict {
	id: string;
	verdict: VerifyJoinVerdictKind;
	/** Model confidence 0..1 (clamped by the sanitizer). */
	confidence: number;
}

/**
 * One DEFAULT-ACCEPTED cut handed to the final read's harm/texture review (round
 * 14 U2 / P3, verify v7). Dan select-alls and applies everything, so a cut that
 * survives to this list SHIPS unless the final read pulls it back. Two failure
 * modes are checked against the assembled seam it leaves:
 *  - HARM: removing this span leaves the surrounding kept text broken - a severed
 *    sentence, an orphaned referent, or a point the next kept line still leans on.
 *  - TEXTURE: it is one of the deterministic guard's BORDERLINE micro-cuts - a tiny
 *    chop beside a real edit that could read as a stutter rather than an edit.
 * The verdict either keeps the cut (the default) or REVERTS it, which only ever
 * DEMOTES the row to offered (never deletes it). Verdicts key back by `id`.
 */
export interface VerifyHarmCandidate {
	/** The cut op's stable id; the verdict echoes it verbatim. */
	id: string;
	startSec: number;
	endSec: number;
	/** The transcript words this cut REMOVES (what shipping it deletes). */
	removedText: string;
	/** Up to ~12 KEPT words immediately before the cut (assembled order). */
	contextBefore: string;
	/** Up to ~12 KEPT words immediately after the cut (assembled order). */
	contextAfter: string;
	/** True when the deterministic guard flagged this as a borderline micro-cut
	 * (a texture question), false for a substantial cut (a harm question). Renders
	 * a different one-line framing; the verdict contract is identical. */
	texture: boolean;
}

/** The two verdicts the final read can return for a harm/texture candidate. */
export type VerifyHarmVerdictKind = "keep" | "revert";

/** One harm/texture verdict, keyed back to its candidate by `id`. */
export interface VerifyHarmVerdict {
	id: string;
	verdict: VerifyHarmVerdictKind;
	/** Model confidence 0..1 (clamped by the sanitizer). */
	confidence: number;
}

/**
 * One recall-pass candidate handed to the verifier. Carries its resolved seconds
 * span (for the prompt) AND its own reference anchors so a tighten can narrow it: a
 * retake candidate carries a word-index range (`startWord`..`endWord`), a structural
 * candidate carries a line-id range (`startLineId`..`endLineId`).
 */
export interface VerifyCandidate {
	category: VerifyCategory;
	startSec: number;
	endSec: number;
	reason: string;
	confidence: number;
	/** The transcript text the span removes (rendered so the model can judge damage). */
	coveredText: string;
	startWord?: number;
	endWord?: number;
	startLineId?: string;
	endLineId?: string;
}

/** One verdict, keyed back to its candidate by `index`. A tighten carries the
 * RESOLVED narrowed span in seconds (resolved inside this module, never raw). */
export interface VerifyVerdict {
	index: number;
	verdict: VerifyVerdictKind;
	startSec?: number;
	endSec?: number;
}

export interface VerifyPlan {
	verdicts: VerifyVerdict[];
	/** Per-fragment final-read verdicts (round 12 U2). Empty when no fragments
	 * were sent or the response carried none/malformed ones (fail-open). */
	joinVerdicts: VerifyJoinVerdict[];
	/** Per-cut harm/texture verdicts (round 14 U2). Empty when no harm candidates
	 * were sent or the response carried none/malformed ones (fail-open). */
	harmVerdicts: VerifyHarmVerdict[];
}

const VERIFY_SCHEMA = {
	type: "object",
	properties: {
		verdicts: {
			type: "array",
			items: {
				type: "object",
				properties: {
					index: { type: "number" },
					verdict: { type: "string" },
					startLineId: { type: "string" },
					endLineId: { type: "string" },
					startWord: { type: "number" },
					endWord: { type: "number" },
				},
				required: ["index", "verdict"],
				additionalProperties: false,
			},
		},
		joinVerdicts: {
			type: "array",
			items: {
				type: "object",
				properties: {
					id: { type: "string" },
					verdict: { type: "string" },
					confidence: { type: "number" },
				},
				required: ["id", "verdict", "confidence"],
				additionalProperties: false,
			},
		},
		harmVerdicts: {
			type: "array",
			items: {
				type: "object",
				properties: {
					id: { type: "string" },
					verdict: { type: "string" },
					confidence: { type: "number" },
				},
				required: ["id", "verdict", "confidence"],
				additionalProperties: false,
			},
		},
	},
	required: ["verdicts"],
	additionalProperties: false,
} as const;

/** Matches `@/wasm` TICKS_PER_SECOND (wasm-free local copy). Only used for the
 * sanitizer's zero-length span check; the resolved verdict carries seconds. */
const VERIFY_TICKS_PER_SECOND = 120_000;

function isInt(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value);
}

/** A candidate's own reference tag: `[w340-w352]` for retake, `[L4-L5]` for
 * structural. Never leaks `undefined`/`NaN` (integers and non-empty ids fall back). */
function candidateAnchor(c: VerifyCandidate): string {
	if (c.category === "retake") {
		const a = isInt(c.startWord) ? c.startWord : 0;
		const b = isInt(c.endWord) ? c.endWord : 0;
		return `[w${a}-w${b}]`;
	}
	const a = typeof c.startLineId === "string" && c.startLineId ? c.startLineId : "L0";
	const b = typeof c.endLineId === "string" && c.endLineId ? c.endLineId : "L0";
	return `[${a}-${b}]`;
}

/** Words per anchored run when breaking a retake candidate's covered text into
 * rows (small enough that an edge word that does not belong stands out). */
const RETAKE_RUN_WORDS = 6;

/** Break a retake candidate's covered text into small ANCHORED word runs, one
 * indented row each ("  w340-w345: '...'"), so the model can see which edge words do
 * not belong to the flub and tighten them away. Anchors derive from the candidate's
 * own startWord plus token offset, clamped to its endWord (rendering aid only; a
 * tighten still resolves through the sanitizer). Empty text falls back to "-". */
function renderRetakeRuns(c: VerifyCandidate): string {
	const start = isInt(c.startWord) ? c.startWord : 0;
	const end = isInt(c.endWord) ? c.endWord : start;
	const tokens = c.coveredText.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return `  w${start}-w${end}: "-"`;
	const rows: string[] = [];
	for (let i = 0; i < tokens.length; i += RETAKE_RUN_WORDS) {
		const run = tokens.slice(i, i + RETAKE_RUN_WORDS);
		const a = Math.min(start + i, end);
		const b = Math.min(start + i + run.length - 1, end);
		rows.push(`  w${a}-w${b}: "${run.join(" ")}"`);
	}
	return rows.join("\n");
}

/** List each covered line of a structural candidate on its own anchored row
 * ("  L12: '...'") so the model can see which edge lines do not belong to the
 * tangent and tighten them away. Falls back to one coveredText row when the
 * candidate's line ids do not resolve against the catalog (fail-open). */
function renderStructuralRows(
	c: VerifyCandidate,
	lines: readonly RedundancyLine[],
): string {
	const startIdx = lines.findIndex((l) => l.lineId === c.startLineId);
	const endIdx = lines.findIndex((l) => l.lineId === c.endLineId);
	if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) {
		const text = c.coveredText.trim().replace(/\s+/g, " ").slice(0, 200) || "-";
		return `  ${candidateAnchor(c)}: "${text}"`;
	}
	return lines
		.slice(startIdx, endIdx + 1)
		.map((l) => {
			const text = l.text.trim().replace(/\s+/g, " ").slice(0, 200) || "-";
			return `  ${l.lineId}: "${text}"`;
		})
		.join("\n");
}

/** Render each candidate as a C-indexed header row (span, anchors, reason) followed
 * by its covered content BROKEN DOWN into anchored interior rows: per-line rows for
 * structural candidates, small word runs for retake candidates. The interior rows
 * are what let the model SEE edge bleed and tighten it. No `undefined`/`NaN` can
 * leak (numbers guarded, text falls back to "-"). */
function renderVerifyCandidates(
	candidates: readonly VerifyCandidate[],
	lines: readonly RedundancyLine[],
): string {
	return candidates
		.map((c, i) => {
			const conf = Number.isFinite(c.confidence) ? c.confidence : 0.5;
			const start = Number.isFinite(c.startSec) ? c.startSec : 0;
			const end = Number.isFinite(c.endSec) ? c.endSec : 0;
			const reason = c.reason.trim().replace(/\s+/g, " ").slice(0, 200) || "-";
			const header = `[C${i}] (${c.category}, conf ${conf.toFixed(1)}) ${start.toFixed(1)}s-${end.toFixed(1)}s ${candidateAnchor(c)} reason: "${reason}"`;
			const body =
				c.category === "retake" ? renderRetakeRuns(c) : renderStructuralRows(c, lines);
			return `${header}\n${body}`;
		})
		.join("\n");
}

/** Render each join fragment as a J-tagged header plus the TWO readings the
 * final read is actually choosing between: the assembled join WITH the fragment
 * and the same join WITHOUT it. Round 13: the earlier one-line render made the
 * model reason about the fragment in isolation ("is this a complete beat?")
 * when the question is comparative ("does the join read better without it?"),
 * so the alternative is now spelled out rather than left to be imagined. No
 * `undefined`/`NaN` leaks (numbers guarded, empty text falls back to "-"). */
function renderJoinFragments(fragments: readonly VerifyJoinFragment[]): string {
	return fragments
		.map((f, i) => {
			const start = Number.isFinite(f.startSec) ? f.startSec : 0;
			const end = Number.isFinite(f.endSec) ? f.endSec : 0;
			const clean = (s: string): string => s.trim().replace(/\s+/g, " ") || "-";
			const before = clean(f.contextBefore);
			const after = clean(f.contextAfter);
			return [
				`[J${i} id=${f.id || "-"}] ${start.toFixed(1)}s-${end.toFixed(1)}s stranded: "${clean(f.text)}"`,
				`  keep it   -> ...${before} >>${clean(f.text)}<< ${after}...`,
				`  swallow   -> ...${before} [CUT] ${after}...`,
			].join("\n");
		})
		.join("\n");
}

/** Render each harm/texture candidate as an H-tagged header plus the assembled
 * seam it leaves: the kept text before the cut, the removed text, and the kept
 * text after. The model judges the seam WITHOUT the removed text (that is what
 * ships), so the "shipped" line spells out exactly the join the viewer would read.
 * A texture candidate is tagged so the model reads it as a micro-cut stutter
 * question rather than a load-bearing-removal question. No `undefined`/`NaN` leaks
 * (numbers guarded, empty text falls back to "-"). */
function renderHarmCandidates(candidates: readonly VerifyHarmCandidate[]): string {
	return candidates
		.map((c, i) => {
			const start = Number.isFinite(c.startSec) ? c.startSec : 0;
			const end = Number.isFinite(c.endSec) ? c.endSec : 0;
			const clean = (s: string): string => s.trim().replace(/\s+/g, " ") || "-";
			const before = clean(c.contextBefore);
			const after = clean(c.contextAfter);
			const kind = c.texture ? "micro-cut" : "cut";
			return [
				`[H${i} id=${c.id || "-"}] (${kind}) ${start.toFixed(1)}s-${end.toFixed(1)}s removes: "${clean(c.removedText)}"`,
				`  shipped -> ...${before} [CUT] ${after}...`,
			].join("\n");
		})
		.join("\n");
}

/** Render the full transcript line catalog (context the verifier judges against). No
 * `undefined`/`NaN` leaks (timings are numbers, text falls back to "-"). */
function renderVerifyLineCatalog(lines: readonly RedundancyLine[]): string {
	return lines
		.map((line) => {
			const clip = line.clipName ? ` ${line.clipName}` : "";
			const text = line.text.trim().replace(/\s+/g, " ").slice(0, 200) || "-";
			return `[${line.lineId}] (${line.startSec.toFixed(1)}-${line.endSec.toFixed(1)})${clip} "${text}"`;
		})
		.join("\n");
}

export function buildVerifyPrompt({
	candidates,
	lines,
	taste,
	assembledTranscript,
	joinFragments = [],
	harmCandidates = [],
}: {
	candidates: readonly VerifyCandidate[];
	lines: readonly RedundancyLine[];
	taste?: string;
	/** The ASSEMBLED post-cut transcript (or timestamped windows around each join
	 * when the full text is too long). Sent only when join fragments exist. */
	assembledTranscript?: string;
	/** OFFERED join-fragment rows the final read adjudicates (round 12 U2/R3). */
	joinFragments?: readonly VerifyJoinFragment[];
	/** DEFAULT-ACCEPTED cuts the final read harm/texture-reviews (round 14 U2). */
	harmCandidates?: readonly VerifyHarmCandidate[];
}): string {
	// Final-read block (round 12 U2/R3): rendered only when join fragments exist,
	// so a candidates-only call keeps the lean damage-review prompt.
	const joinBlock =
		joinFragments.length > 0
			? `
ASSEMBLED RESULT (the transcript that REMAINS after every accepted cut, in order; " [CUT] " marks where two cuts meet):
${assembledTranscript?.trim() || "-"}

JOIN FRAGMENTS: Each row below is a SHORT run of 1-4 words left stranded BETWEEN TWO CUTS in the assembled result above - everything on both sides of it is already gone. This is a DIFFERENT question from the candidates above, and the "when torn, keep" rule above does NOT carry over: a stranded fragment survives only if it EARNS ITS SCREEN TIME.

Each row shows you both readings of the join: with the fragment, and with the fragment swallowed too. Compare them and ask what the viewer LOSES by swallowing it. Do NOT ask whether the fragment is well formed, complete, or grammatical - plenty of complete sentences are dead weight between two cuts, and a fragment that survives one is paying for screen time with nothing.
- "swallow" (the DEFAULT): the viewer loses nothing nameable. Filler, a dangling connective, a half thought, an acknowledgement of material that was cut, a lead-in whose payoff was cut, a stray aside, or a tidy sentence that simply carries no information the assembled result needs. If you cannot name what is lost, the answer is swallow.
- "keep": swallowing it would cost the viewer something SPECIFIC - a fact they need, a reaction that lands, or a turn the next surviving line depends on. Name that thing to yourself first; if you cannot, it is not a keep.

Three examples of the distinction (illustrations, not rows to judge):
- stranded "Okay, so." -> swallow: connective tissue pointing at material that is gone.
- stranded "Let me zoom in on this." -> swallow: a complete sentence, but the zoom it promises was cut, so keeping it makes the join read as a promise the video never pays.
- stranded "That is the whole trick." -> keep: it names the takeaway of the material that survives on either side, and the next line lands harder because of it.

CONFIDENCE IS LOAD-BEARING, so spend it honestly. A swallow is only ACTED ON above a confidence bar; below it the row is simply offered to the editor. So a swallow you would defend to the creator belongs at 0.85 or above, and a swallow you merely lean toward - anything where the fragment might be the creator's own reaction, aside, or deliberate flourish - belongs at 0.6 or below. Do not spend high confidence on a coin flip: an over-confident swallow deletes material the creator chose, while an under-confident one costs him one click.

${renderJoinFragments(joinFragments)}

Return one entry per fragment in "joinVerdicts": {"id": the fragment's id string EXACTLY as shown, "verdict": "swallow" or "keep", "confidence": 0..1 (how sure you are)}.
`
			: "";
	const joinJsonHint =
		joinFragments.length > 0
			? `,"joinVerdicts":[{"id":"join-abc","verdict":"swallow","confidence":0.9}, ...]`
			: "";
	// Harm/texture block (round 14 U2/P3): rendered only when harm candidates exist.
	// This is a THIRD, separate question from the candidates and the join fragments -
	// it never reframes either - and its bar is deliberately high: Dan applies every
	// default-accepted cut, so a reverted cut is one he WANTED gone that now needs a
	// click, while a missed harmful cut ships a broken read. Revert is the exception,
	// keep is the rule.
	const harmBlock =
		harmCandidates.length > 0
			? `
DEFAULT-ACCEPTED CUTS (these will SHIP as-is unless you pull one back): Each row below is a cut the pipeline is about to apply by default. Read the "shipped" line - the assembled join the viewer is left with once the removed words are gone - and decide whether that join survives.
- "keep" (the DEFAULT, and the answer for almost every row): the shipped join reads cleanly. The removed material was dead weight, a whole self-contained aside, or a clean repeat, and what remains on both sides still stands on its own. If you cannot name a specific way the join is BROKEN, keep.
- "revert": removing this span visibly DAMAGES the read - it severs a sentence mid-thought, orphans a pronoun or referent whose antecedent was in the removed text, or guts a point the very next kept line depends on. A "revert" does NOT delete anything; it only moves the cut to an offered row for the editor to reconsider. Reserve it for a join that is wrong at its CORE, not one that merely reads a little abruptly - an abrupt-but-intact join is a "keep".
For a "micro-cut" row the question is texture, not damage: is this tiny removal a helpful tightening, or a random stutter chopping a word or two out of live speech for no reason? Revert only the stutters; a micro-cut that tidies a real disfluency is a "keep".

CONFIDENCE IS LOAD-BEARING: a revert is only ACTED ON above a high bar, so a revert you would defend to the creator belongs at 0.8 or above, and anything you merely lean toward belongs below it (the cut then simply stays, as it would have anyway). Do not spend high confidence on a coin flip.

${renderHarmCandidates(harmCandidates)}

Return one entry per row in "harmVerdicts": {"id": the row's id string EXACTLY as shown, "verdict": "keep" or "revert", "confidence": 0..1}.
`
			: "";
	const harmJsonHint =
		harmCandidates.length > 0
			? `,"harmVerdicts":[{"id":"cut-abc","verdict":"keep","confidence":0.9}, ...]`
			: "";
	return `You are a precision EDITOR reviewing a list of PROPOSED CUTS before they reach the timeline. Each proposed cut was already found by an earlier recall pass that hunted aggressively for removable material. Your job is DAMAGE REVIEW, not taste: decide, for each proposed span, whether removing it would harm the finished video.

For EACH candidate below, return exactly one verdict:
- "keep": removing this span is safe - the finished cut still reads cleanly without it.
- "reject": removing this span would visibly DAMAGE the finished video - it destroys load-bearing dialog the audience needs, or it cuts mid-thought into material that stays. Reserve reject for a candidate that is wrong at its CORE, not merely bleeding at an edge.
- "tighten": the span is right to cut at its core but BLEEDS beyond the flub or tangent its reason names, taking good words with it. Return the NARROWED range that removes exactly the bad part. The narrowed range MUST land strictly INSIDE the candidate's own span.

Each candidate's covered content is broken down ROW BY ROW beneath it with its own anchors (one row per covered line for structural candidates, small word runs for retake candidates) so you can see exactly which rows belong to the flub or tangent and which do not. When the START or END of a span includes material that does not belong to the flub or tangent its reason names, TIGHTEN to exclude that material, returning the narrowed range via the anchors shown. Even a few extra words at an edge damage the finished edit - small edge bleed is NEVER a reason to keep. When torn between keep and tighten, tighten to the core.

Do NOT re-litigate whether the material could be cut - recall was the finder pass's job, and every candidate below was already judged removable. You are ONLY checking for DAMAGE and BLEED. When torn between keep and reject, keep.

A tighten narrows through the candidate's OWN reference anchors: a retake candidate carries a word range [w<start>-w<end>], so return "startWord"/"endWord" GLOBAL word indices inside it; a structural candidate carries a line range [L<start>-L<end>], so return "startLineId"/"endLineId" inside it. Never return raw seconds.

CANDIDATES:
${candidates.length > 0 ? renderVerifyCandidates(candidates, lines) : "(none this run - only the join fragments below need verdicts)"}
${joinBlock}${harmBlock}
TRANSCRIPT (full line catalog, for context):
${renderVerifyLineCatalog(lines)}
${taste ? `\nEDITOR TASTE (learned from this user's past reviews - respect it):\n${taste}\n` : ""}
Respond with ONLY JSON: {"verdicts":[{"index":0,"verdict":"keep"},{"index":1,"verdict":"reject"},{"index":2,"verdict":"tighten","startWord":342,"endWord":348}, ...]${joinJsonHint}${harmJsonHint}} - "index" is the C-number of the candidate (0-based), "verdict" is keep, reject, or tighten, and a tighten adds startWord/endWord (retake) or startLineId/endLineId (structural) strictly inside that candidate's span.`;
}

/** True when a resolved span is a proper SHRINK of the candidate's span: positive
 * width, both boundaries inside, and at least one boundary strictly moved inward. A
 * span equal to or wider than the original fails (so it degrades to keep). */
function isInnerSpan(
	resolved: { startSec: number; endSec: number },
	cand: VerifyCandidate,
): boolean {
	return (
		resolved.endSec > resolved.startSec &&
		resolved.startSec >= cand.startSec &&
		resolved.endSec <= cand.endSec &&
		(resolved.startSec > cand.startSec || resolved.endSec < cand.endSec)
	);
}

/**
 * Clean the raw `joinVerdicts` array into id-keyed fragment verdicts. Drops any
 * entry whose id is not a string, does not match a SENT fragment id, repeats an
 * already-seen id (first well-formed one wins), carries an unknown verdict kind,
 * or has a non-finite confidence; confidence clamps to [0, 1]. A malformed or
 * absent array yields zero join verdicts (fail-open). Never throws. Pure.
 */
function sanitizeJoinVerdicts({
	raw,
	joinFragments,
}: {
	raw: unknown;
	joinFragments: readonly VerifyJoinFragment[];
}): VerifyJoinVerdict[] {
	if (!Array.isArray(raw) || joinFragments.length === 0) return [];
	const sentIds = new Set(joinFragments.map((f) => f.id));
	const seen = new Set<string>();
	const out: VerifyJoinVerdict[] = [];
	for (const entry of raw) {
		if (typeof entry !== "object" || entry === null) continue;
		const e = entry as Record<string, unknown>;
		if (typeof e.id !== "string" || !sentIds.has(e.id)) continue;
		if (e.verdict !== "swallow" && e.verdict !== "keep") continue;
		if (typeof e.confidence !== "number" || !Number.isFinite(e.confidence)) continue;
		if (seen.has(e.id)) continue; // duplicate id: first well-formed one wins
		seen.add(e.id);
		out.push({
			id: e.id,
			verdict: e.verdict,
			confidence: Math.min(1, Math.max(0, e.confidence)),
		});
	}
	return out;
}

/**
 * Clean the raw `harmVerdicts` array into id-keyed cut verdicts (round 14 U2).
 * Same discipline as `sanitizeJoinVerdicts`: drops any entry whose id is not a
 * string, does not match a SENT harm candidate, repeats an already-seen id (first
 * well-formed one wins), carries an unknown verdict kind, or has a non-finite
 * confidence; confidence clamps to [0, 1]. A malformed or absent array yields zero
 * harm verdicts (fail-open). Never throws. Pure.
 */
function sanitizeHarmVerdicts({
	raw,
	harmCandidates,
}: {
	raw: unknown;
	harmCandidates: readonly VerifyHarmCandidate[];
}): VerifyHarmVerdict[] {
	if (!Array.isArray(raw) || harmCandidates.length === 0) return [];
	const sentIds = new Set(harmCandidates.map((c) => c.id));
	const seen = new Set<string>();
	const out: VerifyHarmVerdict[] = [];
	for (const entry of raw) {
		if (typeof entry !== "object" || entry === null) continue;
		const e = entry as Record<string, unknown>;
		if (typeof e.id !== "string" || !sentIds.has(e.id)) continue;
		if (e.verdict !== "keep" && e.verdict !== "revert") continue;
		if (typeof e.confidence !== "number" || !Number.isFinite(e.confidence)) continue;
		if (seen.has(e.id)) continue; // duplicate id: first well-formed one wins
		seen.add(e.id);
		out.push({
			id: e.id,
			verdict: e.verdict,
			confidence: Math.min(1, Math.max(0, e.confidence)),
		});
	}
	return out;
}

/**
 * Clean a raw verify response into index-keyed verdicts. Drops entries with an
 * unknown/duplicate/non-integer index or an unknown verdict string. Each tighten
 * resolves INDIVIDUALLY (a single-op resolver call) against a catalog built from BOTH
 * `lines` and `words` (word indices win when both are present); its span must land
 * strictly inside the candidate's original span, else the verdict degrades to keep. A
 * malformed response yields zero verdicts. Join-fragment verdicts (round 12 U2) ride
 * the same response and sanitize id-keyed against the SENT fragment set. Never
 * throws. Pure -> unit-tested.
 */
export function sanitizeVerifyPlan({
	raw,
	candidates,
	lines,
	words,
	joinFragments = [],
	harmCandidates = [],
}: {
	raw: unknown;
	candidates: readonly VerifyCandidate[];
	lines: readonly RedundancyLine[];
	words: readonly ReferenceWord[];
	joinFragments?: readonly VerifyJoinFragment[];
	harmCandidates?: readonly VerifyHarmCandidate[];
}): VerifyPlan {
	let value: unknown = raw;
	if (typeof value === "string") {
		try {
			value = JSON.parse(value);
		} catch {
			return { verdicts: [], joinVerdicts: [], harmVerdicts: [] };
		}
	}
	if (typeof value !== "object" || value === null)
		return { verdicts: [], joinVerdicts: [], harmVerdicts: [] };
	const joinVerdicts = sanitizeJoinVerdicts({
		raw: (value as Record<string, unknown>).joinVerdicts,
		joinFragments,
	});
	const harmVerdicts = sanitizeHarmVerdicts({
		raw: (value as Record<string, unknown>).harmVerdicts,
		harmCandidates,
	});
	const arr = (value as Record<string, unknown>).verdicts;
	if (!Array.isArray(arr)) return { verdicts: [], joinVerdicts, harmVerdicts };

	const catalog: ReferenceCatalog = {
		lines: lines.map((l) => ({
			lineId: l.lineId,
			startSec: l.startSec,
			endSec: l.endSec,
		})),
		words: words.map((w) => ({ startSec: w.startSec, endSec: w.endSec })),
	};

	const seen = new Set<number>();
	const verdicts: VerifyVerdict[] = [];
	for (const entry of arr) {
		if (typeof entry !== "object" || entry === null) continue;
		const e = entry as Record<string, unknown>;
		const index = e.index;
		if (!isInt(index) || index < 0 || index >= candidates.length) continue;
		const kind = e.verdict;
		if (kind !== "keep" && kind !== "reject" && kind !== "tighten") continue;
		if (seen.has(index)) continue; // duplicate index: first well-formed one wins
		seen.add(index);

		if (kind !== "tighten") {
			verdicts.push({ index, verdict: kind });
			continue;
		}

		// One op, resolved on its own: a batched resolve reorders and drops overlaps,
		// which would scramble the candidate<->verdict pairing (KTD2).
		const rawOp: RawReferencedOp = {
			startWord: e.startWord,
			endWord: e.endWord,
			startLineId: e.startLineId,
			endLineId: e.endLineId,
		};
		const [resolved] = resolveReferencedOps({
			rawOps: [rawOp],
			catalog,
			ticksPerSecond: VERIFY_TICKS_PER_SECOND,
		});
		if (resolved && isInnerSpan(resolved, candidates[index])) {
			verdicts.push({
				index,
				verdict: "tighten",
				startSec: resolved.startSec,
				endSec: resolved.endSec,
			});
		} else {
			// Unresolved or not a proper shrink: fall back to keeping the whole span.
			verdicts.push({ index, verdict: "keep" });
		}
	}
	return { verdicts, joinVerdicts, harmVerdicts };
}

/**
 * Build the verify prompt, dispatch it text-only, and return the sanitized verdicts
 * plus token usage. Mirrors `planStructural`. R4 FAIL-OPEN: zero candidates AND zero
 * join fragments contribute empty verdict lists WITHOUT calling the LLM (guard
 * first, never a throw). One batched call otherwise: the candidate + fragment set is
 * small (a few dozen rows at most). Round 12 U2: the pass fires for join fragments
 * ALONE now - the final read must run even when no recall candidate exists.
 */
export async function planVerify({
	candidates,
	lines,
	words,
	taste,
	assembledTranscript,
	joinFragments = [],
	harmCandidates = [],
	auth,
}: {
	candidates: readonly VerifyCandidate[];
	lines: readonly RedundancyLine[];
	words: readonly ReferenceWord[];
	taste?: string;
	/** Assembled post-cut transcript (or windows); sent with join fragments. */
	assembledTranscript?: string;
	/** OFFERED join-fragment rows the final read adjudicates (round 12 U2). */
	joinFragments?: readonly VerifyJoinFragment[];
	/** DEFAULT-ACCEPTED cuts the final read harm/texture-reviews (round 14 U2). */
	harmCandidates?: readonly VerifyHarmCandidate[];
	auth: ClaudeAuth;
}): Promise<{ plan: VerifyPlan; usage: TokenUsage | null }> {
	// R4: nothing to verify at all -> the LLM is never invoked (guard first). Round 14
	// U2: harm candidates alone are enough to fire the pass (the final read must run
	// when the only thing to judge is whether the assembled cut damaged the read).
	if (
		candidates.length === 0 &&
		joinFragments.length === 0 &&
		harmCandidates.length === 0
	)
		return {
			plan: { verdicts: [], joinVerdicts: [], harmVerdicts: [] },
			usage: null,
		};
	const prompt = buildVerifyPrompt({
		candidates,
		lines,
		taste,
		assembledTranscript,
		joinFragments,
		harmCandidates,
	});
	const { raw, usage } = await planJson({ prompt, auth, schema: VERIFY_SCHEMA });
	return {
		plan: sanitizeVerifyPlan({
			raw,
			candidates,
			lines,
			words,
			joinFragments,
			harmCandidates,
		}),
		usage,
	};
}
