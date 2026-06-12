import { NextRequest, NextResponse } from "next/server";
import {
	planRepeatCuts,
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
		mode?: "repeats" | "cleanup" | "youtube";
		preferences?: string[];
	};
	if (!Array.isArray(body.segments)) {
		return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
	}
	try {
		const cuts = await planRepeatCuts({
			segments: body.segments,
			auth,
			mode:
				body.mode === "cleanup" || body.mode === "youtube"
					? body.mode
					: "repeats",
			preferences: Array.isArray(body.preferences)
				? body.preferences
						.filter((p) => typeof p === "string")
						.slice(0, 20)
				: undefined,
		});
		return NextResponse.json({ cuts });
	} catch (e) {
		return NextResponse.json(
			{ error: `Cut planning failed: ${e instanceof Error ? e.message : String(e)}` },
			{ status: 500 },
		);
	}
}
