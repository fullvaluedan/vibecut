import { NextRequest, NextResponse } from "next/server";
import {
	planDirector,
	planDirectorVision,
	type DirectorAssetSummary,
	type DirectorVisionFrame,
	type MultimodalImageMediaType,
} from "@framecut/hf-bridge";
import { resolveAiAuth } from "@/features/ai-generate/resolve-ai-auth";

export const runtime = "nodejs";
export const maxDuration = 300;

const IMAGE_MEDIA_TYPES = new Set<string>([
	"image/jpeg",
	"image/png",
	"image/gif",
	"image/webp",
]);

/** Type-predicate guard (no `as` narrowing) for an accepted image media type. */
function isImageMediaType(value: string): value is MultimodalImageMediaType {
	return IMAGE_MEDIA_TYPES.has(value);
}

/**
 * Parse the wire `frames` array into typed `DirectorVisionFrame[]`, dropping any
 * malformed entry. Returns `null` when `frames` is absent (the text-only path);
 * an empty/all-malformed array yields `[]`, which also routes text-only.
 */
function parseVisionFrames(raw: unknown): DirectorVisionFrame[] | null {
	if (raw === undefined || raw === null) return null;
	if (!Array.isArray(raw)) return null;
	const frames: DirectorVisionFrame[] = [];
	for (const entry of raw) {
		const segmentIndex: unknown = entry?.segmentIndex;
		const mediaType: unknown = entry?.mediaType;
		const dataBase64: unknown = entry?.dataBase64;
		if (
			typeof segmentIndex === "number" &&
			Number.isInteger(segmentIndex) &&
			segmentIndex >= 0 &&
			typeof mediaType === "string" &&
			isImageMediaType(mediaType) &&
			typeof dataBase64 === "string" &&
			dataBase64.length > 0
		) {
			frames.push({ segmentIndex, mediaType, dataBase64 });
		}
	}
	return frames;
}

/**
 * Parse the wire `catalog` array into typed `DirectorAssetSummary[]`, dropping any
 * malformed entry. Returns `undefined` when absent (single-clip / no catalog), so
 * the prompt path is unchanged. Malformed-but-present yields the valid subset.
 */
function parseCatalog(raw: unknown): DirectorAssetSummary[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const out: DirectorAssetSummary[] = [];
	for (const entry of raw) {
		const name: unknown = entry?.name;
		const durationSec: unknown = entry?.durationSec;
		const segmentCount: unknown = entry?.segmentCount;
		const firstLine: unknown = entry?.firstLine;
		const lastLine: unknown = entry?.lastLine;
		if (
			typeof name === "string" &&
			typeof durationSec === "number" &&
			Number.isFinite(durationSec) &&
			typeof segmentCount === "number" &&
			Number.isFinite(segmentCount) &&
			typeof firstLine === "string" &&
			typeof lastLine === "string"
		) {
			out.push({ name, durationSec, segmentCount, firstLine, lastLine });
		}
	}
	return out.length > 0 ? out : undefined;
}

/**
 * The Director planner endpoint: a fused-signal table + total duration + the
 * learned taste note in; a sanitized typed-op `DirectorPlan` + token usage out.
 * Optional `frames` route the request through the VISION planner; absent frames
 * keep the text-only path (works on every auth mode). Mirrors the cuts route.
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
	const tasteNote = typeof taste === "string" ? taste : undefined;
	const catalog = parseCatalog(body?.catalog);
	// Compression target (U3/KTD4): an optional numeric; a non-number is silently
	// dropped (field absent = today's behavior). Out-of-range values are clamped by
	// the prompt builder, so only the finiteness gate lives here.
	const compressionTargetRaw: unknown = body?.compressionTarget;
	const compressionTarget =
		typeof compressionTargetRaw === "number" && Number.isFinite(compressionTargetRaw)
			? compressionTargetRaw
			: undefined;
	// Second-pass flag (round 14 U1): a truthy `secondPass` adds the assembled-cut
	// re-read preamble to the plan prompt. Only a strict `true` engages it; anything
	// else keeps the first-pass prompt byte-identical.
	const secondPass = body?.secondPass === true;

	// `frames: <non-array>` is a malformed request; `frames` absent or `[]` is the
	// text-only path. Only a populated, well-formed array engages vision.
	const frames = parseVisionFrames(body?.frames);
	if (body?.frames !== undefined && frames === null) {
		return NextResponse.json({ error: "Invalid frames" }, { status: 400 });
	}

	try {
		if (frames && frames.length > 0) {
			const { plan, usage, degraded } = await planDirectorVision({
				segments,
				totalSec,
				taste: tasteNote,
				catalog,
				frames,
				auth,
				signal: req.signal,
			});
			return NextResponse.json({ plan, usage, degraded });
		}
		const { plan, usage } = await planDirector({
			segments,
			totalSec,
			taste: tasteNote,
			catalog,
			compressionTarget,
			secondPass,
			auth,
		});
		return NextResponse.json({ plan, usage, degraded: false });
	} catch (e) {
		return NextResponse.json(
			{ error: `Director planning failed: ${e instanceof Error ? e.message : String(e)}` },
			{ status: 500 },
		);
	}
}
