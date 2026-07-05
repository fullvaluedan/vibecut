// --- LLM redundancy planner (FrameCut, dedicated repeat-detection pass) ---
//
// The Director's general cut prompt does everything at once, and the lexical
// detectors (take-clusters / phrase-repeat / segment-repeat) only catch near-
// verbatim text. This pass does ONE focused job: read the whole transcript and
// GROUP the lines that make the same point — verbatim retakes AND reworded
// restatements — then name the best-delivered take to keep. Conservative (high-
// confidence only). It references opaque lineIds of real transcript lines; the
// sanitizer snaps every id back to a real line, so the review can only ever cut
// real spans (anti-hallucination).
//
// Named `llm-redundancy` to avoid colliding with the deterministic
// apps/web/.../director/redundancy.ts (the take-cluster mapper this pass demotes).

import { planJson, type TokenUsage } from "./author";
import type { ClaudeAuth } from "./types";
import {
	chunkTranscriptLines,
	dedupeByKey,
	transcriptExceedsBudget,
} from "./transcript-chunk";

/** One transcript line as the model sees it (timeline coordinates). */
export interface RedundancyLine {
	/** Opaque, stable id the model references (e.g. "L12"). Index-based, never
	 * start-based — two segments can share a rounded start-second. */
	lineId: string;
	/** Source clip name; omitted over a gap with no source mapping. */
	clipName?: string;
	startSec: number;
	endSec: number;
	text: string;
	/** Relative loudness 0..1, when audio features are available. */
	loudnessRelative?: number;
	wpm?: number;
	fillerCandidate?: boolean;
}

/** A resolved member of a redundancy group (snapped back to a real line). */
export interface RedundancyMember {
	lineId: string;
	clipName?: string;
	startSec: number;
	endSec: number;
	text: string;
}

/** A group of lines that make the same point: keep one, cut the rest. */
export interface RedundancyGroup {
	/** >= 2 distinct, resolved real lines. */
	members: RedundancyMember[];
	/** The lineId of the member to KEEP (best-delivered take). */
	keeperLineId: string;
	/** Model confidence 0..1. */
	confidence: number;
	reason: string;
}

export interface RedundancyPlan {
	groups: RedundancyGroup[];
}

const REDUNDANCY_SCHEMA = {
	type: "object",
	properties: {
		groups: {
			type: "array",
			items: {
				type: "object",
				properties: {
					lineIds: { type: "array", items: { type: "string" } },
					keeperLineId: { type: "string" },
					confidence: { type: "number" },
					reason: { type: "string" },
				},
				required: ["lineIds", "keeperLineId", "confidence", "reason"],
				additionalProperties: false,
			},
		},
	},
	required: ["groups"],
	additionalProperties: false,
} as const;

/** Render the transcript lines in time order (token-conscious) with signals. */
export function renderRedundancyCatalog(lines: readonly RedundancyLine[]): string {
	return lines
		.map((line) => {
			const signals = [
				line.loudnessRelative !== undefined
					? `loud=${line.loudnessRelative.toFixed(2)}`
					: null,
				line.wpm !== undefined ? `wpm=${Math.round(line.wpm)}` : null,
				line.fillerCandidate ? "filler" : null,
			]
				.filter((s): s is string => s !== null)
				.join(" ");
			const clip = line.clipName ? ` ${line.clipName}` : "";
			const text = line.text.trim().replace(/\s+/g, " ").slice(0, 160) || "-";
			return `[${line.lineId}] (${line.startSec.toFixed(1)}-${line.endSec.toFixed(1)})${clip}${signals ? ` ${signals}` : ""} "${text}"`;
		})
		.join("\n");
}

export function buildRedundancyPrompt({
	lines,
	taste,
}: {
	lines: readonly RedundancyLine[];
	taste?: string;
}): string {
	return `You are an expert video EDITOR finding REDUNDANCY in a talking-head recording's transcript. Below is every spoken line IN ORDER, each with an id like [L12], its source clip, timing, and delivery signals (loudness 0-1, speaking rate wpm, "filler" when it reads as a false-start).

Your job: find every set of lines that make the SAME POINT and should not all stay in the cut. This includes BOTH near-verbatim retakes (the speaker restarts and says almost the same sentence) AND reworded restatements (the same idea in different words), including PARTIAL retakes where only the back half of a line is redone. Group them, and for each group name the ONE best-delivered line to KEEP (the clearest, strongest delivery: higher loudness, steadier rate, no filler) — the rest will be cut.

Aim for RECALL — surface every plausible repeat for review. The editor reviews every group before anything is cut, and lower-confidence groups are shown UNCHECKED for the editor to opt into, so a borderline group costs nothing:
- Group lines that make the same point even when you are only moderately sure. Lines merely on the same TOPIC but making DIFFERENT points still should not be grouped.
- LEAVE intentional repetition alone: a deliberate callback, an "as I said earlier" recap, or repetition for rhetorical emphasis is NOT redundancy. Never group those.
- Do NOT drop a plausible group just because you are unsure — include it and lower its confidence instead.

confidence is 0..1 — set it HONESTLY: high when it is clearly the same point, lower for a judgment call. The lower-confidence groups are exactly the ones the editor wants to see and decide on.

TRANSCRIPT:
${renderRedundancyCatalog(lines)}
${taste ? `\nEDITOR TASTE (learned from this user's past reviews — respect it):\n${taste}\n` : ""}
Respond with ONLY JSON: {"groups":[{"lineIds":["L3","L12"],"keeperLineId":"L12","confidence":0.0-1.0,"reason":"why these say the same thing"}, ...]} — each lineId from the list above, each appearing in at most ONE group.`;
}

/**
 * Validate + resolve a raw redundancy plan (anti-hallucination, R8). Per group:
 * dedupe lineIds, drop unknown ids and ids already claimed by an EARLIER group (a
 * line belongs to at most one group — first group wins), drop groups with < 2
 * distinct members, drop a group whose keeperLineId isn't a surviving member, and
 * clamp confidence. Pure → unit-testable.
 */
export function sanitizeRedundancyPlan(
	raw: unknown,
	lines: readonly RedundancyLine[],
): RedundancyPlan {
	const byId = new Map<string, RedundancyLine>();
	for (const line of lines) byId.set(line.lineId, line);

	const rawObj =
		typeof raw === "object" && raw !== null
			? (raw as Record<string, unknown>)
			: {};
	const rawGroups = Array.isArray(rawObj.groups) ? rawObj.groups : [];

	const groups: RedundancyGroup[] = [];
	const claimed = new Set<string>(); // a line may be in at most one group

	for (const entry of rawGroups) {
		if (typeof entry !== "object" || entry === null) continue;
		const it = entry as Record<string, unknown>;
		const rawLineIds = Array.isArray(it.lineIds) ? it.lineIds : [];

		const members: RedundancyMember[] = [];
		const seen = new Set<string>();
		for (const rawId of rawLineIds) {
			if (typeof rawId !== "string") continue; // non-string id
			if (seen.has(rawId) || claimed.has(rawId)) continue; // dup within / across groups
			const line = byId.get(rawId);
			if (!line) continue; // hallucinated id
			seen.add(rawId);
			members.push({
				lineId: line.lineId,
				startSec: line.startSec,
				endSec: line.endSec,
				text: line.text,
				...(line.clipName !== undefined ? { clipName: line.clipName } : {}),
			});
		}
		if (members.length < 2) continue; // not a group

		const keeperLineId = typeof it.keeperLineId === "string" ? it.keeperLineId : "";
		if (!members.some((m) => m.lineId === keeperLineId)) continue; // keeper must be a member

		const confidence = Number(it.confidence);
		groups.push({
			members,
			keeperLineId,
			confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.5,
			reason: String(it.reason ?? "").slice(0, 240),
		});
		for (const m of members) claimed.add(m.lineId);
	}

	return { groups };
}

/**
 * Chunking budget (R6): a transcript whose line text exceeds this is split into
 * overlapping windows so a 30+ minute recording never overflows the prompt and
 * silently loses its tail. Conservative (line signals + prompt scaffolding add
 * overhead on top of the text). The overlap keeps a take that straddles a window
 * boundary visible in one window.
 */
const REDUNDANCY_MAX_CHARS = 12_000;
const REDUNDANCY_OVERLAP_LINES = 4;

/**
 * Merge redundancy groups gathered across chunk windows into one plan (R6). The
 * overlap re-surfaces a straddling group in two windows, so: dedupe by member-set,
 * then enforce the same one-group-per-line rule the single-window sanitizer applies
 * (first group to claim a line wins; a later group sharing a claimed line is
 * dropped). Pure → unit-tested.
 */
export function mergeRedundancyGroups(
	groups: readonly RedundancyGroup[],
): RedundancyGroup[] {
	const unique = dedupeByKey(groups, (g) =>
		g.members
			.map((m) => m.lineId)
			.sort()
			.join(","),
	);
	const claimed = new Set<string>();
	const out: RedundancyGroup[] = [];
	for (const group of unique) {
		if (group.members.some((m) => claimed.has(m.lineId))) continue;
		out.push(group);
		for (const m of group.members) claimed.add(m.lineId);
	}
	return out;
}

function addUsage(a: TokenUsage | null, b: TokenUsage | null): TokenUsage | null {
	if (!a) return b;
	if (!b) return a;
	return {
		inputTokens: a.inputTokens + b.inputTokens,
		outputTokens: a.outputTokens + b.outputTokens,
	};
}

/**
 * Build the redundancy prompt, dispatch it text-only, and return the sanitized plan
 * plus token usage. Mirrors `planAssembly` / `planDirector`. A transcript over the
 * prompt budget is chunked into overlapping windows (R6): each window is planned +
 * sanitized against the FULL line set (so every id resolves), then the groups are
 * merged/deduped so a straddling take reported in two windows becomes one.
 */
export async function planRedundancy({
	lines,
	taste,
	auth,
}: {
	lines: readonly RedundancyLine[];
	taste?: string;
	auth: ClaudeAuth;
}): Promise<{ plan: RedundancyPlan; usage: TokenUsage | null }> {
	if (!transcriptExceedsBudget({ lines, maxChars: REDUNDANCY_MAX_CHARS })) {
		const prompt = buildRedundancyPrompt({ lines, taste });
		const { raw, usage } = await planJson({ prompt, auth, schema: REDUNDANCY_SCHEMA });
		return { plan: sanitizeRedundancyPlan(raw, lines), usage };
	}

	const windows = chunkTranscriptLines({
		lines,
		maxChars: REDUNDANCY_MAX_CHARS,
		overlapLines: REDUNDANCY_OVERLAP_LINES,
	});
	const allGroups: RedundancyGroup[] = [];
	let usage: TokenUsage | null = null;
	for (const window of windows) {
		const prompt = buildRedundancyPrompt({ lines: window, taste });
		const { raw, usage: u } = await planJson({ prompt, auth, schema: REDUNDANCY_SCHEMA });
		// Sanitize against the FULL line set so every referenced id resolves even
		// though the window only showed a slice.
		allGroups.push(...sanitizeRedundancyPlan(raw, lines).groups);
		usage = addUsage(usage, u);
	}
	return { plan: { groups: mergeRedundancyGroups(allGroups) }, usage };
}
