import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { jobDir, jobFilePath } from "@/features/graphics/graphics-config";

export const runtime = "nodejs";

/**
 * Stream a job's rendered output back to the browser so the client can wrap it in a File
 * and drop it on the timeline. `?id=<jobId>&kind=proof|full`. The path is taken from the
 * job's own job.json (proofPath/fullPath) and confirmed to sit inside the job dir, so a
 * crafted id/kind can never read outside the job's own folder.
 */
export async function GET(req: NextRequest) {
	const id = req.nextUrl.searchParams.get("id");
	const kind = req.nextUrl.searchParams.get("kind") === "proof" ? "proof" : "full";
	if (!id) return NextResponse.json({ error: "missing id" }, { status: 400 });

	let job: { proofPath?: string; fullPath?: string };
	try {
		job = JSON.parse(fs.readFileSync(jobFilePath(id), "utf8"));
	} catch {
		return NextResponse.json({ error: "job not found" }, { status: 404 });
	}

	const target = kind === "proof" ? job.proofPath : job.fullPath;
	if (!target) {
		return NextResponse.json({ error: `no ${kind} render yet` }, { status: 404 });
	}

	// Containment check: the resolved file must live inside this job's dir.
	const resolved = path.resolve(target);
	const base = path.resolve(jobDir(id));
	if (resolved !== base && !resolved.startsWith(base + path.sep)) {
		return NextResponse.json({ error: "invalid path" }, { status: 400 });
	}
	if (!fs.existsSync(resolved)) {
		return NextResponse.json({ error: "render file missing" }, { status: 404 });
	}

	const stat = fs.statSync(resolved);
	const stream = Readable.toWeb(fs.createReadStream(resolved)) as unknown as ReadableStream;
	return new Response(stream, {
		headers: {
			"content-type": "video/mp4",
			"content-length": String(stat.size),
			"cache-control": "no-store",
			"content-disposition": `inline; filename="${id}-${kind}.mp4"`,
		},
	});
}
