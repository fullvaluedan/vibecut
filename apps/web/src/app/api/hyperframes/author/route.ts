import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import {
	authorComposition,
	renderCompDir,
	type ClaudeAuth,
} from "@framecut/hf-bridge";

export const runtime = "nodejs";
export const maxDuration = 600;

function resolveAuth(req: NextRequest): ClaudeAuth | null {
	const mode = req.headers.get("x-framecut-auth-mode");
	if (mode === "api-key") {
		const apiKey = req.headers.get("x-framecut-anthropic-key");
		if (!apiKey) return null;
		return { mode: "api-key", apiKey };
	}
	return { mode: "claude-code" };
}

/**
 * Skill-as-producer: Claude AUTHORS a custom HyperFrames composition from the
 * compiled brief (text output — it never writes files; the product does), then
 * we render it and stream the transparent WebM back, with the comp id so the
 * caller can later open it in Studio and re-render.
 */
export async function POST(req: NextRequest) {
	const auth = resolveAuth(req);
	if (!auth) {
		return NextResponse.json(
			{ error: "API key mode selected but no key provided. Add one in Settings → AI." },
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
	const durationSec = Number.isFinite(body.durationSec)
		? Math.min(Math.max(Number(body.durationSec), 1), 300)
		: 5;

	try {
		const { compId, usage } = await authorComposition({
			prompt: body.prompt.slice(0, 12000),
			fps,
			width,
			height,
			durationSec,
			auth,
		});
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
		return NextResponse.json(
			{ error: `Author failed: ${e instanceof Error ? e.message : String(e)}` },
			{ status: 500 },
		);
	}
}
