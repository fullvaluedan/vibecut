import { NextRequest, NextResponse } from "next/server";
import { planRepeatCuts, type TranscriptSegment } from "@framecut/hf-bridge";
import { resolveAiAuth } from "@/features/ai-generate/resolve-ai-auth";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
	const auth = resolveAiAuth(req);
	if (!auth) {
		return NextResponse.json(
			{ error: "Your AI connection isn't fully configured. Check Settings → AI." },
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
