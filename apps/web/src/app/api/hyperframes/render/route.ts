import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { renderTemplateJob, type RenderJob } from "@framecut/hf-bridge";

export const runtime = "nodejs";
export const maxDuration = 600;

export async function POST(req: NextRequest) {
	const job = (await req.json()) as RenderJob;
	if (
		typeof job?.templateId !== "string" ||
		!Number.isFinite(job?.durationSec) ||
		!Number.isFinite(job?.fps) ||
		!Number.isFinite(job?.width) ||
		!Number.isFinite(job?.height)
	) {
		return NextResponse.json({ error: "Invalid render job" }, { status: 400 });
	}
	try {
		const { videoPath, compDir } = await renderTemplateJob(job);
		const bytes = await readFile(videoPath);
		return new NextResponse(new Uint8Array(bytes), {
			headers: {
				"content-type": "video/webm",
				"x-framecut-comp-id": path.basename(compDir),
			},
		});
	} catch (e) {
		return NextResponse.json(
			{ error: `Render failed: ${e instanceof Error ? e.message : String(e)}` },
			{ status: 500 },
		);
	}
}
