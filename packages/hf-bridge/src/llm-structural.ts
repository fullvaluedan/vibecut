// --- LLM structural-drop planner (FrameCut, dedicated section-drop pass) ---
//
// The retake pass hunts WORD-level flubs and the redundancy pass groups repeated
// LINES. This pass works one level up: it reads the WHOLE transcript, infers the
// video's throughline, and proposes the whole SECTIONS a ruthless editor drops -
// off-throughline tangents, weak or superseded takes, over-explanation, sections
// re-recorded elsewhere. It is the recall lever for the STRUCTURAL gap the eval
// named: the missed cut material that lives above line granularity (whole-section
// drops), not word-level stumbles.
//
// Candidates are LINE-ID ranges (startLineId..endLineId), resolved through the
// shared, tested line-id contract in `llm-reference-sanitizer.ts` (never raw
// seconds): any unknown id or reversed range is dropped, never thrown, and a
// malformed response yields ZERO drops. Every row is OFFERED-only review material,
// never auto-applied.
//
// Module shape mirrors `llm-retake` (prompt builder + schema + sanitizer +
// planStructural); the throughline-first framing over the full catalog mirrors
// `llm-context` (the judgment template). Reuses `RedundancyLine` as the input line
// shape (the same numbered-transcript catalog redundancy and context consume).

import { planJson, type TokenUsage } from "./author";
import type { RedundancyLine } from "./llm-redundancy";
import { HANDLED_LINE_COVER_FRACTION } from "./llm-retake";
import {
	sanitizeReferencedPlan,
	type ReferenceCatalog,
} from "./llm-reference-sanitizer";
import type { ClaudeAuth } from "./types";

/** A timeline span the pipeline already removes (cut/take_select), in seconds. */
export interface StructuralHandledSpan {
	startSec: number;
	endSec: number;
}

/** One resolved section drop in TIMELINE seconds (line ids already resolved). */
export interface StructuralDrop {
	startSec: number;
	endSec: number;
	reason: string;
	confidence: number;
}

export interface StructuralPlan {
	drops: StructuralDrop[];
}

/** A catalog line that may carry the [HANDLED] mask (absent flag = unmarked). */
type MarkedStructuralLine = RedundancyLine & { handled?: boolean };

const STRUCTURAL_SCHEMA = {
	type: "object",
	properties: {
		operations: {
			type: "array",
			items: {
				type: "object",
				properties: {
					startLineId: { type: "string" },
					endLineId: { type: "string" },
					reason: { type: "string" },
					confidence: { type: "number" },
				},
				required: ["startLineId", "endLineId", "reason", "confidence"],
				additionalProperties: false,
			},
		},
	},
	required: ["operations"],
	additionalProperties: false,
} as const;

/** Matches `@/wasm` TICKS_PER_SECOND (wasm-free local copy). Only used for the
 * sanitizer's zero-length drop check; the resolved drop carries seconds. */
const STRUCTURAL_TICKS_PER_SECOND = 120_000;

/**
 * Flag the lines whose duration is substantially covered by `handledSpans` (the
 * pipeline's already-proposed removals). The catalog renders them [HANDLED] and the
 * prompt tells the model not to re-propose that material, pointing the pass at the
 * UNHANDLED sections instead. A RedundancyLine-shaped sibling of retake's
 * `markHandledLines` (that one is typed to word-anchored RetakeLines). Overlapping
 * spans are unioned first so they never double-count coverage. Pure.
 */
export function markHandledStructuralLines({
	lines,
	handledSpans,
	coverFraction = HANDLED_LINE_COVER_FRACTION,
}: {
	lines: readonly RedundancyLine[];
	handledSpans: readonly StructuralHandledSpan[];
	coverFraction?: number;
}): MarkedStructuralLine[] {
	const sorted = handledSpans
		.filter((s) => s.endSec > s.startSec)
		.slice()
		.sort((a, b) => a.startSec - b.startSec);
	if (sorted.length === 0) return [...lines];
	const union: StructuralHandledSpan[] = [];
	for (const s of sorted) {
		const last = union[union.length - 1];
		if (last && s.startSec <= last.endSec) {
			if (s.endSec > last.endSec) last.endSec = s.endSec;
		} else {
			union.push({ startSec: s.startSec, endSec: s.endSec });
		}
	}
	return lines.map((line) => {
		const len = line.endSec - line.startSec;
		if (len <= 0) return line;
		let covered = 0;
		for (const s of union) {
			covered += Math.max(
				0,
				Math.min(line.endSec, s.endSec) - Math.max(line.startSec, s.startSec),
			);
		}
		return covered / len >= coverFraction ? { ...line, handled: true } : line;
	});
}

/** Render the transcript lines in time order (id, timing, source clip, text), each
 * with a [HANDLED] marker on lines the pipeline already covers (absent flag =
 * byte-identical line). No `undefined`/`NaN` can leak (timings are numbers, text
 * falls back to "-", the clip fragment is present only when named). */
export function renderStructuralCatalog(
	lines: readonly MarkedStructuralLine[],
): string {
	return lines
		.map((line) => {
			const clip = line.clipName ? ` ${line.clipName}` : "";
			const text = line.text.trim().replace(/\s+/g, " ").slice(0, 200) || "-";
			const handled = line.handled ? " [HANDLED]" : "";
			return `[${line.lineId}]${handled} (${line.startSec.toFixed(1)}-${line.endSec.toFixed(1)})${clip} "${text}"`;
		})
		.join("\n");
}

export function buildStructuralPrompt({
	lines,
	handledSpans,
	removalHint,
	taste,
}: {
	lines: readonly RedundancyLine[];
	/** The pipeline's already-proposed removal spans. Lines substantially covered are
	 * rendered [HANDLED] and the model is told to hunt the UNHANDLED sections instead.
	 * Absent/empty = byte-identical prompt (no marker, no instruction block). */
	handledSpans?: readonly StructuralHandledSpan[];
	/** One-line removal-share hint (e.g. "This creator removes roughly 80% of raw
	 * words in the finished cut"). Absent = the generic large-share wording. */
	removalHint?: string;
	taste?: string;
}): string {
	const hasHandled = handledSpans !== undefined && handledSpans.length > 0;
	const marked = hasHandled
		? markHandledStructuralLines({ lines, handledSpans })
		: lines;
	const handledBlock = hasHandled
		? `
Sections tagged [HANDLED] are already flagged by the other editing passes - that material is handled; DO NOT re-propose it. Spend your effort on the UNHANDLED sections that no other pass reached.
`
		: "";
	const removalSentence =
		removalHint ||
		"This creator, like most talking-head creators, removes a large share of the raw footage before publishing";
	return `You are a ruthless video EDITOR deciding which whole SECTIONS to drop from a talking-head recording. Below is every spoken line IN ORDER, each with an id like [L12], its source clip, and timing.

First, read the WHOLE transcript and infer the video's throughline - the single spine the finished cut is built around - in one line.

Then propose EVERY section a ruthless editor would drop because it does NOT serve that throughline - not a sample, not the obvious few, ALL of them:
- An off-throughline TANGENT: a stretch that wanders away from the spine and never pays it back.
- A WEAK TAKE: a section delivered worse than another attempt at the same point, or a superseded earlier take.
- OVER-EXPLANATION: a point already made, belabored past the moment the audience got it.
- A section RE-RECORDED elsewhere: material the speaker clearly re-does in a cleaner pass somewhere else.
${handledBlock}
Emit each drop as a LINE RANGE: "startLineId" and "endLineId" are ids from the tags above (inclusive) covering EXACTLY the section to REMOVE. In the "reason", name WHY that section does not serve the throughline.

Aim for EXHAUSTIVE RECALL. ${removalSentence} - a large share of what gets removed is exactly this structural material, so expect MANY section drops spread across the whole recording. Over-proposing is SAFE: every candidate is a review-only row shown UNCHECKED for the editor to opt into, never auto-applied. A borderline drop costs nothing; a section that should have been cut but was not ships in the final video:
- Propose a plausible drop even when you are only moderately sure, and lower its confidence instead of dropping it.
- Do NOT stop after the first few - keep judging to the LAST line.
- LEAVE on-throughline material alone: a brief setup, transition, or aside that still serves the spine is NOT a drop.

confidence is 0..1 - set it HONESTLY: high for an obvious off-throughline tangent, lower for a judgment call. The lower-confidence rows are exactly the ones the editor wants to see and decide on.

TRANSCRIPT:
${renderStructuralCatalog(marked)}
${taste ? `\nEDITOR TASTE (learned from this user's past reviews - respect it):\n${taste}\n` : ""}
Respond with ONLY JSON: {"operations":[{"startLineId":"L3","endLineId":"L7","reason":"why this section does not serve the throughline","confidence":0.0-1.0}, ...]} - each startLineId and endLineId a line id from the tags above.`;
}

/**
 * Resolve a raw structural response to TIMELINE-seconds drops through the shared
 * line-id sanitizer (anti-hallucination). Unknown ids and reversed ranges are
 * dropped, duplicates and overlaps collapse, and a malformed response yields ZERO
 * drops, never a throw. Pure -> unit-tested.
 */
export function sanitizeStructuralPlan(
	raw: unknown,
	lines: readonly RedundancyLine[],
): StructuralPlan {
	const catalog: ReferenceCatalog = {
		lines: lines.map((l) => ({
			lineId: l.lineId,
			startSec: l.startSec,
			endSec: l.endSec,
		})),
	};
	const { ops } = sanitizeReferencedPlan({
		raw,
		stage: "structural",
		catalog,
		ticksPerSecond: STRUCTURAL_TICKS_PER_SECOND,
	});
	return {
		drops: ops.map((o) => ({
			startSec: o.startSec,
			endSec: o.endSec,
			reason: o.reason,
			confidence: o.confidence,
		})),
	};
}

/**
 * Build the structural prompt, dispatch it text-only, and return the sanitized
 * drops plus token usage. Mirrors `planContext`. R4 FAIL-OPEN: an empty line catalog
 * contributes zero candidates WITHOUT calling the LLM (guard first, never a throw).
 * Single call by default: throughline judgment is global and the full catalog fits
 * one call (KTD3, the llm-context precedent); no chunking this round.
 */
export async function planStructural({
	lines,
	handledSpans,
	removalHint,
	taste,
	auth,
}: {
	lines: readonly RedundancyLine[];
	/** The pipeline's already-proposed removal spans ([HANDLED] mask; see the prompt). */
	handledSpans?: readonly StructuralHandledSpan[];
	/** One-line removal-share hint; absent = the generic large-share wording. */
	removalHint?: string;
	taste?: string;
	auth: ClaudeAuth;
}): Promise<{ plan: StructuralPlan; usage: TokenUsage | null }> {
	// R4: no lines -> no candidates, and the LLM is never invoked (guard first).
	if (lines.length === 0) return { plan: { drops: [] }, usage: null };
	const prompt = buildStructuralPrompt({ lines, handledSpans, removalHint, taste });
	const { raw, usage } = await planJson({ prompt, auth, schema: STRUCTURAL_SCHEMA });
	return { plan: sanitizeStructuralPlan(raw, lines), usage };
}
