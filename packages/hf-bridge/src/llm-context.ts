// --- LLM out-of-context planner (FrameCut, dedicated relevance pass) ---
//
// Dan's ask: read the ENTIRE transcript, infer the video's throughline, and flag
// the lines whose dialog does NOT fit it: off-topic tangents, abandoned thoughts,
// meta-asides ("let me redo that", "wait, that's wrong"), content that belongs to
// a different video. This is the semantic complement to the redundancy pass (which
// only groups lines that repeat each other): here a line is flagged for NOT
// belonging, not for repeating.
//
// PRECISION over recall by design: semantic relevance is false-positive-prone, so
// every flag is surfaced as an OPT-IN review row (never auto-cut). The sanitizer
// snaps each flagged lineId back to a real transcript line (anti-hallucination), so
// review can only ever cut real spans.
//
// Reuses `RedundancyLine` as the input line shape (same numbered-transcript catalog
// the redundancy pass consumes) to avoid a parallel type + builder.

import { planJson, type TokenUsage } from "./author";
import type { RedundancyLine } from "./llm-redundancy";
import type { ClaudeAuth } from "./types";

/** One line the model flagged as out-of-context, snapped back to a real line. */
export interface ContextFlag {
	lineId: string;
	clipName?: string;
	startSec: number;
	endSec: number;
	text: string;
	/** Model confidence 0..1. */
	confidence: number;
	reason: string;
}

export interface ContextPlan {
	/** The model's one-line reading of the video's main topic / throughline. */
	topic: string;
	flags: ContextFlag[];
}

const CONTEXT_SCHEMA = {
	type: "object",
	properties: {
		topic: { type: "string" },
		flags: {
			type: "array",
			items: {
				type: "object",
				properties: {
					lineId: { type: "string" },
					confidence: { type: "number" },
					reason: { type: "string" },
				},
				required: ["lineId", "confidence", "reason"],
				additionalProperties: false,
			},
		},
	},
	required: ["topic", "flags"],
	additionalProperties: false,
} as const;

/** Render the transcript lines in time order (id, timing, source clip, text). */
export function renderContextCatalog(lines: readonly RedundancyLine[]): string {
	return lines
		.map((line) => {
			const clip = line.clipName ? ` ${line.clipName}` : "";
			const text = line.text.trim().replace(/\s+/g, " ").slice(0, 200) || "-";
			return `[${line.lineId}] (${line.startSec.toFixed(1)}-${line.endSec.toFixed(1)})${clip} "${text}"`;
		})
		.join("\n");
}

export function buildContextPrompt({
	lines,
	taste,
}: {
	lines: readonly RedundancyLine[];
	taste?: string;
}): string {
	return `You are an expert video EDITOR reviewing a talking-head recording's FULL transcript for lines that do NOT belong in the finished video. Below is every spoken line IN ORDER, each with an id like [L12], its source clip, and timing.

First, read the WHOLE transcript and infer the video's main topic / throughline in one short line.

Then flag the lines whose content does NOT fit that throughline:
- Off-topic tangents or asides that wander away from the subject.
- Abandoned thoughts and false starts the speaker drops and moves on from.
- Meta-asides / self-corrections about the recording itself ("let me redo that", "wait, that's wrong", "scratch that", "can we cut this part", "hold on").
- Content that clearly belongs to a DIFFERENT video.

PRECISION over recall. This is the load-bearing instruction. A high-confidence flag is REMOVED AUTOMATICALLY, so a wrong high-confidence flag deletes wanted footage. Only flag a line when it is CLEARLY out of context. When you are unsure whether a line belongs, do NOT flag it. It is much better to miss a borderline line than to flag one that fits.

Do NOT flag:
- A line that is merely a repeat/restatement (that is the redundancy pass's job, not yours).
- A brief transition, setup, or aside that still serves the throughline.
- Anything on-topic, even if it is not the strongest delivery.

confidence is 0..1 and it DECIDES the action: 0.7 or above is removed automatically, below 0.7 is shown as an opt-in suggestion the editor approves. Calibrate:
- Clear self-corrections / mistakes / meta-asides ("scratch that", "let me redo that") are usually high-confidence (0.8+) and safe to auto-remove.
- Off-topic tangents or wrong-video content: high-confidence ONLY when unmistakable.
- Topic-relevance judgment calls (is this aside worth keeping?) stay BELOW 0.7 so the editor, not you, decides.

TRANSCRIPT:
${renderContextCatalog(lines)}
${taste ? `\nEDITOR TASTE (learned from this user's past reviews, respect it):\n${taste}\n` : ""}
Respond with ONLY JSON: {"topic":"the video's throughline in one line","flags":[{"lineId":"L7","confidence":0.0-1.0,"reason":"why this line does not fit"}, ...]}. Use each lineId from the list above, each appearing at most ONCE. Return an empty flags array if nothing is clearly out of context.`;
}

/**
 * Validate + resolve a raw context plan (anti-hallucination). Keeps a clamped topic
 * string; per flag: drop non-string / unknown / duplicate ids, snap each surviving
 * id back to its real line span, clamp confidence, trim the reason. Pure →
 * unit-testable.
 */
export function sanitizeContextPlan(
	raw: unknown,
	lines: readonly RedundancyLine[],
): ContextPlan {
	const byId = new Map<string, RedundancyLine>();
	for (const line of lines) byId.set(line.lineId, line);

	const rawObj =
		typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
	const topic = String(rawObj.topic ?? "").slice(0, 200);
	const rawFlags = Array.isArray(rawObj.flags) ? rawObj.flags : [];

	const flags: ContextFlag[] = [];
	const claimed = new Set<string>(); // a line may be flagged at most once
	for (const entry of rawFlags) {
		if (typeof entry !== "object" || entry === null) continue;
		const it = entry as Record<string, unknown>;
		const lineId = typeof it.lineId === "string" ? it.lineId : "";
		if (!lineId || claimed.has(lineId)) continue;
		const line = byId.get(lineId);
		if (!line) continue; // hallucinated id
		claimed.add(lineId);
		const confidence = Number(it.confidence);
		flags.push({
			lineId: line.lineId,
			startSec: line.startSec,
			endSec: line.endSec,
			text: line.text,
			...(line.clipName !== undefined ? { clipName: line.clipName } : {}),
			confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.5,
			reason: String(it.reason ?? "").slice(0, 240),
		});
	}

	return { topic, flags };
}

/**
 * Build the context prompt, dispatch it text-only, and return the sanitized plan
 * plus token usage. Mirrors `planRedundancy`.
 */
export async function planContext({
	lines,
	taste,
	auth,
}: {
	lines: readonly RedundancyLine[];
	taste?: string;
	auth: ClaudeAuth;
}): Promise<{ plan: ContextPlan; usage: TokenUsage | null }> {
	const prompt = buildContextPrompt({ lines, taste });
	const { raw, usage } = await planJson({ prompt, auth, schema: CONTEXT_SCHEMA });
	return { plan: sanitizeContextPlan(raw, lines), usage };
}
