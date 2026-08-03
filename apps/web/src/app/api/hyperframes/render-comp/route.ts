import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { renderCompDir, renderProbe } from "@framecut/hf-bridge";

export const runtime = "nodejs";
export const maxDuration = 600;

/**
 * Re-renders an existing comp dir exactly as it is on disk (including any
 * edits made in HyperFrames Studio) and streams the WebM back. With `probeSec`
 * it streams the short PROBE render instead (first ~probeSec seconds; used to
 * re-pull a cached probe when a run resumes from its manifest).
 */
export async function POST(req: NextRequest) {
	const body = (await req.json()) as {
		compId?: string;
		fps?: number;
		probeSec?: number;
	};
	if (typeof body?.compId !== "string" || !/^[\w-]+$/.test(body.compId)) {
		return NextResponse.json({ error: "Invalid compId" }, { status: 400 });
	}
	const probeSec = Number.isFinite(body.probeSec)
		? Math.min(Math.max(Number(body.probeSec), 1), 30)
		: undefined;
	try {
		const { videoPath, compDir } = probeSec
			? await renderProbe({
					compId: body.compId,
					fps: Number.isFinite(body.fps) ? body.fps : undefined,
					probeSec,
				})
			: await renderCompDir({
					compId: body.compId,
					fps: Number.isFinite(body.fps) ? body.fps : undefined,
				});
		const bytes = await readFile(videoPath);
		return new NextResponse(new Uint8Array(bytes), {
			headers: {
				"content-type": "video/webm",
				"x-framecut-comp-id": path.basename(compDir),
				...(probeSec ? { "x-framecut-probe": "1" } : {}),
			},
		});
	} catch (e) {
		return NextResponse.json(
			{ error: `Render failed: ${e instanceof Error ? e.message : String(e)}` },
			{ status: 500 },
		);
	}
}
