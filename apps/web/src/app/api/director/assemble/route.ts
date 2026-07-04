import { NextRequest, NextResponse } from "next/server";
import { planAssembly, type AssemblyCandidate } from "@framecut/hf-bridge";
import { resolveAiAuth } from "@/features/ai-generate/resolve-ai-auth";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Parse the wire `candidates` array into typed `AssemblyCandidate[]`, dropping any
 * malformed entry. Returns `null` when absent/not-an-array (a bad request).
 */
function parseCandidates(raw: unknown): AssemblyCandidate[] | null {
	if (!Array.isArray(raw)) return null;
	const out: AssemblyCandidate[] = [];
	for (const entry of raw) {
		if (typeof entry !== "object" || entry === null) continue;
		const it: Record<string, unknown> = entry;
		if (
			typeof it.spanId === "string" &&
			typeof it.assetId === "string" &&
			typeof it.clipName === "string" &&
			typeof it.sourceStartSec === "number" &&
			Number.isFinite(it.sourceStartSec) &&
			typeof it.sourceEndSec === "number" &&
			Number.isFinite(it.sourceEndSec) &&
			typeof it.text === "string"
		) {
			out.push({
				spanId: it.spanId,
				assetId: it.assetId,
				clipName: it.clipName,
				sourceStartSec: it.sourceStartSec,
				sourceEndSec: it.sourceEndSec,
				text: it.text,
				...(typeof it.clusterId === "string" ? { clusterId: it.clusterId } : {}),
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
 * The auto-assemble planner endpoint: a pool of candidate spans (the whole bin) +
 * the learned taste note in; a sanitized, snapped-to-candidate `AssemblyPlan`
 * (ordered source spans) + token usage out. Mirrors the Director plan route.
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
	const candidates = parseCandidates(body?.candidates);
	if (!candidates || candidates.length === 0) {
		return NextResponse.json(
			{ error: "Invalid or empty candidates" },
			{ status: 400 },
		);
	}
	const taste = typeof body?.taste === "string" ? body.taste : undefined;

	try {
		const { plan, usage } = await planAssembly({ candidates, taste, auth });
		return NextResponse.json({ plan, usage });
	} catch (e) {
		return NextResponse.json(
			{
				error: `Assembly planning failed: ${e instanceof Error ? e.message : String(e)}`,
			},
			{ status: 500 },
		);
	}
}
