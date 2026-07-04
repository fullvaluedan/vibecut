// --- Assembly planner (FrameCut auto-assemble) ---
//
// Where the Director planner TIGHTENS an existing timeline, the assembly planner
// BUILDS one: given a pool of candidate spans drawn from the WHOLE bin (every
// retake + unused clip, with transcript + audio + take groups), the model infers
// the narrative, picks the single best span per beat, drops the junk, and ORDERS
// the keepers into a rough cut. It references opaque `spanId`s of real candidates
// (never free-form timestamps), and the sanitizer snaps every returned id back to
// a real candidate — so the placer can only ever receive real source ranges.

import { planJson, type TokenUsage } from "./author";
import type { ClaudeAuth } from "./types";

/** One selectable span of source footage, as the model sees it. */
export interface AssemblyCandidate {
	/** Opaque, stable id the model references (e.g. "s12"). */
	spanId: string;
	/** Source asset id (resolved back in by the sanitizer; not shown to the model). */
	assetId: string;
	/** Display name of the source clip. */
	clipName: string;
	sourceStartSec: number;
	sourceEndSec: number;
	text: string;
	/** Take-cluster id when this span is an alternate take of the same line. */
	clusterId?: string;
	/** Relative loudness 0..1. */
	loudnessRelative?: number;
	wpm?: number;
	fillerCandidate?: boolean;
}

/** One chosen span in the assembled order (source coordinates). */
export interface AssemblySpan {
	spanId: string;
	assetId: string;
	sourceStartSec: number;
	sourceEndSec: number;
	reason: string;
	confidence: number;
}

/** The ordered rough-cut the model proposed, plus its read of the story. */
export interface AssemblyPlan {
	/** Chosen spans, IN ASSEMBLY ORDER. */
	spans: AssemblySpan[];
	/** The model's one-line read of the narrative (informational). */
	narrative?: string;
}

const ASSEMBLY_SCHEMA = {
	type: "object",
	properties: {
		narrative: { type: "string" },
		spans: {
			type: "array",
			items: {
				type: "object",
				properties: {
					spanId: { type: "string" },
					reason: { type: "string" },
					confidence: { type: "number" },
				},
				required: ["spanId", "reason", "confidence"],
				additionalProperties: false,
			},
		},
	},
	required: ["spans"],
	additionalProperties: false,
} as const;

/** Render the candidate footage grouped by source clip (token-conscious). */
export function renderCandidateCatalog(
	candidates: readonly AssemblyCandidate[],
): string {
	const byClip = new Map<string, AssemblyCandidate[]>();
	for (const candidate of candidates) {
		const list = byClip.get(candidate.clipName);
		if (list) list.push(candidate);
		else byClip.set(candidate.clipName, [candidate]);
	}

	const blocks: string[] = [];
	for (const [clipName, spans] of byClip) {
		const lines = spans.map((span) => {
			const signals = [
				span.clusterId ? `grp=${span.clusterId}` : null,
				span.loudnessRelative !== undefined
					? `loud=${span.loudnessRelative.toFixed(2)}`
					: null,
				span.wpm !== undefined ? `wpm=${Math.round(span.wpm)}` : null,
				span.fillerCandidate ? "filler" : null,
			]
				.filter((s): s is string => s !== null)
				.join(" ");
			const text = span.text.trim().replace(/\s+/g, " ").slice(0, 160) || "-";
			return `  [${span.spanId}] (${span.sourceStartSec.toFixed(1)}-${span.sourceEndSec.toFixed(1)})${signals ? ` ${signals}` : ""} "${text}"`;
		});
		blocks.push(`Clip "${clipName}":\n${lines.join("\n")}`);
	}
	return blocks.join("\n\n");
}

export function buildAssemblyPrompt({
	candidates,
	taste,
}: {
	candidates: readonly AssemblyCandidate[];
	taste?: string;
}): string {
	return `You are an expert video EDITOR assembling a rough cut from RAW FOOTAGE. Below is every usable spoken line from every clip in the bin — including multiple TAKES of the same line and unused footage. Each line has an id like [s12], its source clip, timing, and signals (loudness 0-1, speaking rate wpm, "filler" when it reads as a false-start/filler, and "grp=Cn" when it is one of several near-identical TAKES of the same line).

Your job:
1. INFER THE STORY from the content itself — what is this video about, and what is the natural arc (hook → body → payoff)? There is no script; read it from the lines.
2. PICK THE BEST SPAN PER BEAT. When several spans share a "grp" id they are alternate takes of the SAME line — choose exactly ONE (the cleanest, strongest delivery: higher loudness, steadier rate, no filler) and drop the rest.
3. DROP THE JUNK — retakes you didn't pick, filler/false-starts, off-topic tangents, dead-weight intros/outros, and lines that don't advance the story. Be decisive: the editor reviews your cut and can bring anything back, so leaving boring footage in wastes their time more than cutting too much.
4. ORDER the spans you keep into a COHERENT sequence. The order may differ from the source order if a different arrangement tells the story better (e.g. lead with the strongest hook).

Output ONLY the spans you are keeping, IN FINAL ASSEMBLY ORDER, by their ids.

CANDIDATE FOOTAGE:
${renderCandidateCatalog(candidates)}
${taste ? `\nEDITOR TASTE (learned from this user's past reviews — respect it):\n${taste}\n` : ""}
Respond with ONLY JSON: {"narrative":"one-line read of the story","spans":[{"spanId":"s12","reason":"why this span here","confidence":0.0-1.0}, ...]} — spans in final order, each spanId appearing at most once and only from the list above.`;
}

/**
 * Validate + resolve a raw assembly plan: keep only spans whose `spanId` is a REAL
 * candidate (snap-to-candidate, the anti-hallucination guard), drop duplicates
 * (a span can appear at most once), clamp confidence, and resolve each to its
 * source range. Pure → unit-testable.
 */
export function sanitizeAssemblyPlan(
	raw: unknown,
	candidates: readonly AssemblyCandidate[],
): AssemblyPlan {
	const byId = new Map<string, AssemblyCandidate>();
	for (const candidate of candidates) byId.set(candidate.spanId, candidate);

	const rawObj =
		typeof raw === "object" && raw !== null
			? (raw as Record<string, unknown>)
			: {};
	const rawSpans = Array.isArray(rawObj.spans) ? rawObj.spans : [];

	const spans: AssemblySpan[] = [];
	const used = new Set<string>();
	for (const entry of rawSpans) {
		if (typeof entry !== "object" || entry === null) continue;
		const it = entry as Record<string, unknown>;
		const spanId = typeof it.spanId === "string" ? it.spanId : null;
		if (!spanId) continue;
		const candidate = byId.get(spanId);
		if (!candidate) continue; // hallucinated id — drop it
		if (used.has(spanId)) continue; // a span can't appear twice
		used.add(spanId);

		const confidence = Number(it.confidence);
		spans.push({
			spanId,
			assetId: candidate.assetId,
			sourceStartSec: candidate.sourceStartSec,
			sourceEndSec: candidate.sourceEndSec,
			reason: String(it.reason ?? "").slice(0, 240),
			confidence: Number.isFinite(confidence)
				? Math.max(0, Math.min(1, confidence))
				: 0.5,
		});
	}

	const narrative =
		typeof rawObj.narrative === "string"
			? rawObj.narrative.slice(0, 280)
			: undefined;
	return narrative !== undefined ? { spans, narrative } : { spans };
}

/**
 * Build the assembly prompt, dispatch it text-only, and return the sanitized
 * (snapped-to-candidate) plan plus token usage. Mirrors `planDirector`.
 */
export async function planAssembly({
	candidates,
	taste,
	auth,
}: {
	candidates: readonly AssemblyCandidate[];
	taste?: string;
	auth: ClaudeAuth;
}): Promise<{ plan: AssemblyPlan; usage: TokenUsage | null }> {
	const prompt = buildAssemblyPrompt({ candidates, taste });
	const { raw, usage } = await planJson({ prompt, auth, schema: ASSEMBLY_SCHEMA });
	return { plan: sanitizeAssemblyPlan(raw, candidates), usage };
}
