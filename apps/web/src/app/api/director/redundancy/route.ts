import { NextRequest, NextResponse } from "next/server";
import { planRedundancy, type RedundancyLine } from "@framecut/hf-bridge";
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
 * The dedicated redundancy-pass endpoint: the full transcript as numbered lines +
 * the learned taste note in; a sanitized, snapped-to-line `RedundancyPlan` (groups
 * of same-meaning lines, each with a keeper) + token usage out. Mirrors the Director
 * assemble route.
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
		const { plan, usage } = await planRedundancy({ lines, taste, auth });
		return NextResponse.json({ plan, usage });
	} catch (e) {
		return NextResponse.json(
			{
				error: `Redundancy planning failed: ${e instanceof Error ? e.message : String(e)}`,
			},
			{ status: 500 },
		);
	}
}
