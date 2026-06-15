import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { authorComposition, renderCompDir } from "@framecut/hf-bridge";
import { resolveAiAuth } from "@/features/ai-generate/resolve-ai-auth";

export const runtime = "nodejs";
export const maxDuration = 600;

/**
 * Skill-as-producer: Claude AUTHORS a custom HyperFrames composition from the
 * compiled brief (text output — it never writes files; the product does), then
 * we render it and stream the transparent WebM back, with the comp id so the
 * caller can later open it in Studio and re-render.
 */
export async function POST(req: NextRequest) {
	const auth = resolveAiAuth(req);
	if (!auth) {
		return NextResponse.json(
			{ error: "Your AI connection isn't fully configured. Check Settings → AI." },
			{ status: 401 },
		);
	}
	let body: {
		prompt?: string;
		fps?: number;
		width?: number;
		height?: number;
		durationSec?: number;
	};
	try {
		body = await req.json();
	} catch {
		return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	if (typeof body.prompt !== "string" || body.prompt.trim().length < 10) {
		return NextResponse.json({ error: "Missing prompt" }, { status: 400 });
	}
	const fps = Number.isFinite(body.fps) ? Number(body.fps) : 30;
	const width = Number.isFinite(body.width) ? Number(body.width) : 1920;
	const height = Number.isFinite(body.height) ? Number(body.height) : 1080;
	// Authored runs are now CHUNKED (each request covers one ≤~150s segment), so
	// a single call never spans the whole video — keeps the generation small and
	// well under any token ceiling.
	const durationSec = Number.isFinite(body.durationSec)
		? Math.min(Math.max(Number(body.durationSec), 1), 180)
		: 5;

	try {
		const { compId, usage } = await authorComposition({
			prompt: body.prompt.slice(0, 12000),
			fps,
			width,
			height,
			durationSec,
			auth,
			// Client cancel / disconnect kills the `claude -p` child instead of
			// letting it run to completion unobserved.
			signal: req.signal,
		});
		// Author finished but the client already bailed — skip the (now pointless)
		// render rather than burning it for a dead connection.
		if (req.signal.aborted) {
			return new NextResponse(null, { status: 499 });
		}
		const { videoPath, compDir } = await renderCompDir({ compId, fps });
		const bytes = await readFile(videoPath);
		return new NextResponse(new Uint8Array(bytes), {
			headers: {
				"content-type": "video/webm",
				"x-framecut-comp-id": path.basename(compDir),
				"x-framecut-tokens": String(
					usage ? usage.inputTokens + usage.outputTokens : 0,
				),
			},
		});
	} catch (e) {
		// An abort surfaces here as the "Cancelled" rejection from authorComposition.
		// The client has already torn down its fetch, so there's no body to read —
		// return a terse 499 and don't log it as a failure.
		if (req.signal.aborted) {
			return new NextResponse(null, { status: 499 });
		}
		return NextResponse.json(
			{ error: `Author failed: ${e instanceof Error ? e.message : String(e)}` },
			{ status: 500 },
		);
	}
}
