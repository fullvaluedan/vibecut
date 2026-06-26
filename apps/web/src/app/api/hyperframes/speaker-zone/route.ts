import { NextRequest, NextResponse } from "next/server";
import {
	detectSpeakerZonesFromFrames,
	type MultimodalImageMediaType,
	type SpeakerDetectFrame,
} from "@framecut/hf-bridge";
import { resolveAiAuth } from "@/features/ai-generate/resolve-ai-auth";

export const runtime = "nodejs";
export const maxDuration = 120;

const IMAGE_MEDIA_TYPES = new Set<string>([
	"image/jpeg",
	"image/png",
	"image/gif",
	"image/webp",
]);

function isImageMediaType(value: string): value is MultimodalImageMediaType {
	return IMAGE_MEDIA_TYPES.has(value);
}

/** Parse the wire `frames` into typed detect frames, dropping malformed entries. */
function parseFrames(raw: unknown): SpeakerDetectFrame[] | null {
	if (!Array.isArray(raw)) return null;
	const out: SpeakerDetectFrame[] = [];
	for (const entry of raw) {
		const mediaType: unknown = entry?.mediaType;
		const dataBase64: unknown = entry?.dataBase64;
		if (
			typeof mediaType === "string" &&
			isImageMediaType(mediaType) &&
			typeof dataBase64 === "string" &&
			dataBase64.length > 0
		) {
			out.push({ mediaType, dataBase64 });
		}
	}
	return out;
}

/**
 * Locate the speaker across sampled clip frames so HyperFrames placement can keep
 * clear of them (and where they move). Returns the movement-aware SafeZone, or
 * `degraded: true` when the backend can't see images (claude-code) — the caller
 * then falls back to the robust lower-third default.
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
	const frames = parseFrames(body?.frames);
	if (frames === null) {
		return NextResponse.json({ error: "Invalid frames" }, { status: 400 });
	}

	try {
		const safeZone = await detectSpeakerZonesFromFrames({
			frames,
			auth,
			signal: req.signal,
		});
		return NextResponse.json({ safeZone, degraded: safeZone === null });
	} catch (e) {
		return NextResponse.json(
			{
				error: `Speaker detection failed: ${e instanceof Error ? e.message : String(e)}`,
			},
			{ status: 500 },
		);
	}
}
