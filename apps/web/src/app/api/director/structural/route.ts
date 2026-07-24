import { NextRequest, NextResponse } from "next/server";
import { planStructural, type RedundancyLine, type StructuralHandledSpan } from "@framecut/hf-bridge";
import { resolveAiAuth } from "@/features/ai-generate/resolve-ai-auth";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Parse the wire `lines` array into typed `RedundancyLine[]`, dropping any malformed
 * entry. Returns `null` when absent/not-an-array (a bad request).
 */
function parseLines(raw: unknown): RedundancyLine[] | null {
	if (!Array.isArray(raw)) return null;
	const out: RedundancyLine[] = [];
	for (const entry of raw) {
		if (typeof entry !== "object" || entry === null) continue;
		const it: Record<string, unknown> = entry;
		if (
			typeof it.lineId === "string" &&
			typeof it.startSec === "number" &&
			Number.isFinite(it.startSec) &&
			typeof it.endSec === "number" &&
			Number.isFinite(it.endSec) &&
			typeof it.text === "string"
		) {
			out.push({
				lineId: it.lineId,
				startSec: it.startSec,
				endSec: it.endSec,
				text: it.text,
				...(typeof it.clipName === "string" ? { clipName: it.clipName } : {}),
				...(typeof it.loudnessRelative === "number"
					? { loudnessRelative: it.loudnessRelative }
					: {}),
				...(typeof it.wpm === "number" ? { wpm: it.wpm } : {}),
				...(it.fillerCandidate === true ? { fillerCandidate: true } : {}),
			});
		}
	}
	return out;
}

/**
 * Parse the wire `handledSpans` array into typed `StructuralHandledSpan[]`, dropping
 * any malformed entry. Absent/not-an-array yields `undefined` (optional on the wire).
 */
function parseHandledSpans(raw: unknown): StructuralHandledSpan[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const out: StructuralHandledSpan[] = [];
	for (const entry of raw) {
		if (typeof entry !== "object" || entry === null) continue;
		const it: Record<string, unknown> = entry;
		if (
			typeof it.startSec === "number" &&
			Number.isFinite(it.startSec) &&
			typeof it.endSec === "number" &&
			Number.isFinite(it.endSec)
		) {
			out.push({ startSec: it.startSec, endSec: it.endSec });
		}
	}
	return out;
}

/**
 * The dedicated structural-drop endpoint (U3): the full numbered-transcript catalog +
 * the pipeline's already-proposed removal spans in; a sanitized, line-resolved
 * `StructuralPlan` (OFFERED-only section drops) + token usage out. Mirrors the
 * Director retake route in shape. The pass is fail-open end to end (R4): a planner
 * throw is caught here and reported as a degraded, empty plan rather than a 500, so a
 * flaky structural call never aborts the Director run; the client-side adapter just
 * receives zero candidates and the pipeline proceeds without them.
 */
export async function POST(req: NextRequest) {
	const auth = resolveAiAuth(req);
	if (!auth) {
		return NextResponse.json(
			{ error: "Your AI connection isn't fully configured. Check Settings → AI." },
			{ status: 401 },
		);
	}

	const body = await req.json().catch(() => null);
	const lines = parseLines(body?.lines);
	if (!lines) {
		return NextResponse.json({ error: "Invalid lines" }, { status: 400 });
	}
	const handledSpans = parseHandledSpans(body?.handledSpans);
	const removalHint = typeof body?.removalHint === "string" ? body.removalHint : undefined;
	const taste = typeof body?.taste === "string" ? body.taste : undefined;

	try {
		const { plan, usage } = await planStructural({ lines, handledSpans, removalHint, taste, auth });
		return NextResponse.json({ plan, usage });
	} catch (e) {
		// Fail-open (R4): a planner error degrades to zero structural candidates instead
		// of failing the whole Director run. Logged server-side only; the client sees a
		// normal 200 with an empty plan.
		console.error("Structural planning failed:", e instanceof Error ? e.message : e);
		return NextResponse.json({ plan: { drops: [] }, usage: null, degraded: true });
	}
}
