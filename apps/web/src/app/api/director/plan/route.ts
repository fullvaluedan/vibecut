import { NextRequest, NextResponse } from "next/server";
import { planDirector } from "@framecut/hf-bridge";
import { resolveAiAuth } from "@/features/ai-generate/resolve-ai-auth";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * The v0 Director planner endpoint: a fused-signal table + total duration + the
 * learned taste note in; a sanitized typed-op `DirectorPlan` + token usage out.
 * Text-only (no frames), so it works on every auth mode. Mirrors the cuts route.
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
	const segments: unknown = body?.segments;
	const totalSec: unknown = body?.totalSec;
	const taste: unknown = body?.taste;
	if (!Array.isArray(segments) || typeof totalSec !== "number") {
		return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
	}

	try {
		const { plan, usage } = await planDirector({
			segments,
			totalSec,
			taste: typeof taste === "string" ? taste : undefined,
			auth,
		});
		return NextResponse.json({ plan, usage });
	} catch (e) {
		return NextResponse.json(
			{ error: `Director planning failed: ${e instanceof Error ? e.message : String(e)}` },
			{ status: 500 },
		);
	}
}
