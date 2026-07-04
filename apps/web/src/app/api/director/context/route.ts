import { NextRequest, NextResponse } from "next/server";
import { planContext, type RedundancyLine } from "@framecut/hf-bridge";
import { resolveAiAuth } from "@/features/ai-generate/resolve-ai-auth";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Parse the wire `lines` array into typed `RedundancyLine[]` (the same numbered-
 * transcript catalog the redundancy pass consumes), dropping any malformed entry.
 * Returns `null` when absent/not-an-array (a bad request). Mirrors the redundancy route.
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
			});
		}
	}
	return out;
}

/**
 * The dedicated out-of-context pass endpoint: the full transcript as numbered lines
 * in, a sanitized `ContextPlan` (the inferred throughline + the line spans that do
 * not fit it, each snapped to a real line) + token usage out. Mirrors the Director
 * redundancy route. Every flag is opt-in in the review (never auto-cut).
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
	if (!lines || lines.length === 0) {
		return NextResponse.json({ error: "Invalid or empty lines" }, { status: 400 });
	}
	const taste = typeof body?.taste === "string" ? body.taste : undefined;

	try {
		const { plan, usage } = await planContext({ lines, taste, auth });
		return NextResponse.json({ plan, usage });
	} catch (e) {
		return NextResponse.json(
			{
				error: `Context planning failed: ${e instanceof Error ? e.message : String(e)}`,
			},
			{ status: 500 },
		);
	}
}
