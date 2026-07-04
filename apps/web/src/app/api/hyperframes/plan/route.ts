import { NextRequest, NextResponse } from "next/server";
import { planEffects, type TranscriptSegment } from "@framecut/hf-bridge";
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
		totalDurationSec: number;
		allowedTemplateIds?: string[];
		direction?: string;
		preferences?: string[];
		look?: { name?: string; description?: string };
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
			direction:
				typeof body.direction === "string"
					? body.direction.slice(0, 2000)
					: undefined,
			preferences: Array.isArray(body.preferences)
				? body.preferences
						.filter((p) => typeof p === "string")
						.slice(0, 20)
				: undefined,
			look:
				body.look && typeof body.look.name === "string"
					? {
							name: body.look.name.slice(0, 60),
							description:
								typeof body.look.description === "string"
									? body.look.description.slice(0, 200)
									: "",
						}
					: undefined,
		});
		return NextResponse.json(plan);
	} catch (e) {
		return NextResponse.json(
			{ error: `Planning failed: ${e instanceof Error ? e.message : String(e)}` },
			{ status: 500 },
		);
	}
}
