import { NextRequest, NextResponse } from "next/server";
import {
	loadRevalidatedManifest,
	saveRunManifest,
	RUN_ID_PATTERN,
	type RunManifest,
} from "@framecut/hf-bridge";

export const runtime = "nodejs";

/**
 * Run-manifest checkpoint for the chunked authored engine (probe-render-first
 * + resume guards). GET loads + revalidates a run's chunk states against the
 * comp dirs on disk; POST upserts the manifest after client-side transitions.
 */
export async function GET(req: NextRequest) {
	const runId = req.nextUrl.searchParams.get("runId") ?? "";
	if (!RUN_ID_PATTERN.test(runId)) {
		return NextResponse.json({ error: "Invalid runId" }, { status: 400 });
	}
	const manifest = await loadRevalidatedManifest(runId);
	return NextResponse.json({ manifest });
}

export async function POST(req: NextRequest) {
	let body: { manifest?: RunManifest };
	try {
		body = await req.json();
	} catch {
		return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	const m = body.manifest;
	if (
		!m ||
		typeof m.runId !== "string" ||
		!RUN_ID_PATTERN.test(m.runId) ||
		!Array.isArray(m.chunks) ||
		typeof m.approved !== "boolean"
	) {
		return NextResponse.json({ error: "Invalid manifest" }, { status: 400 });
	}
	await saveRunManifest(m);
	return NextResponse.json({ ok: true });
}
