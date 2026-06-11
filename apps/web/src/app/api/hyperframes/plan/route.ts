import { NextRequest, NextResponse } from "next/server";
import {
	planEffects,
	type ClaudeAuth,
	type TranscriptSegment,
} from "@framecut/hf-bridge";

export const runtime = "nodejs";
export const maxDuration = 300;

function resolveAuth(req: NextRequest): ClaudeAuth | null {
	const mode = req.headers.get("x-framecut-auth-mode");
	if (mode === "api-key") {
		const apiKey = req.headers.get("x-framecut-anthropic-key");
		if (!apiKey) return null;
		return { mode: "api-key", apiKey };
	}
	return { mode: "claude-code" };
}

export async function POST(req: NextRequest) {
	const auth = resolveAuth(req);
	if (!auth) {
		return NextResponse.json(
			{ error: "API key mode selected but no key provided. Add one in Settings → AI." },
			{ status: 401 },
		);
	}
	const body = (await req.json()) as {
		segments: TranscriptSegment[];
		totalDurationSec: number;
		allowedTemplateIds?: string[];
	};
	if (!Array.isArray(body.segments) || !Number.isFinite(body.totalDurationSec)) {
		return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
	}
	const allowedTemplateIds = Array.isArray(body.allowedTemplateIds)
		? body.allowedTemplateIds.filter((id) => typeof id === "string")
		: undefined;
	try {
		const plan = await planEffects({
			segments: body.segments,
			totalDurationSec: body.totalDurationSec,
			auth,
			allowedTemplateIds,
		});
		return NextResponse.json(plan);
	} catch (e) {
		return NextResponse.json(
			{ error: `Planning failed: ${e instanceof Error ? e.message : String(e)}` },
			{ status: 500 },
		);
	}
}
