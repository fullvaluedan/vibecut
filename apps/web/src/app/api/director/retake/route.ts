import { NextRequest, NextResponse } from "next/server";
import { planRetake, type RetakeHandledSpan, type RetakeWord } from "@framecut/hf-bridge";
import { resolveAiAuth } from "@/features/ai-generate/resolve-ai-auth";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Parse the wire `words` array into typed `RetakeWord[]`, dropping any malformed
 * entry. Returns `null` when absent/not-an-array (a bad request).
 */
function parseWords(raw: unknown): RetakeWord[] | null {
	if (!Array.isArray(raw)) return null;
	const out: RetakeWord[] = [];
	for (const entry of raw) {
		if (typeof entry !== "object" || entry === null) continue;
		const it: Record<string, unknown> = entry;
		if (
			typeof it.text === "string" &&
			typeof it.startSec === "number" &&
			Number.isFinite(it.startSec) &&
			typeof it.endSec === "number" &&
			Number.isFinite(it.endSec)
		) {
			out.push({ text: it.text, startSec: it.startSec, endSec: it.endSec });
		}
	}
	return out;
}

/**
 * Parse the wire `handledSpans` array into typed `RetakeHandledSpan[]`, dropping
 * any malformed entry. Absent/not-an-array yields `undefined` (optional on the wire).
 */
function parseHandledSpans(raw: unknown): RetakeHandledSpan[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const out: RetakeHandledSpan[] = [];
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
 * The dedicated retake-hunt endpoint (U4): transcript words + the pipeline's
 * already-proposed removal spans in; a sanitized, word-resolved `RetakePlan`
 * (OFFERED-only retake/false-start cuts) + token usage out. Mirrors the Director
 * redundancy route in shape. The pass is fail-open end to end (R7): a planner
 * throw is caught here and reported as a degraded, empty plan rather than a 500,
 * so a flaky retake call never aborts the Director run — the client-side adapter
 * just receives zero candidates and the pipeline proceeds without them.
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
	const words = parseWords(body?.words);
	if (!words) {
		return NextResponse.json({ error: "Invalid words" }, { status: 400 });
	}
	const handledSpans = parseHandledSpans(body?.handledSpans);
	const removalHint = typeof body?.removalHint === "string" ? body.removalHint : undefined;
	const taste = typeof body?.taste === "string" ? body.taste : undefined;

	try {
		const { plan, usage } = await planRetake({ words, handledSpans, removalHint, taste, auth });
		return NextResponse.json({ plan, usage });
	} catch (e) {
		// Fail-open (R7): a planner error degrades to zero retake candidates instead of
		// failing the whole Director run. Logged server-side only; the client sees a
		// normal 200 with an empty plan.
		console.error("Retake planning failed:", e instanceof Error ? e.message : e);
		return NextResponse.json({ plan: { cuts: [] }, usage: null, degraded: true });
	}
}
