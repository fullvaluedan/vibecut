import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import { jobFilePath } from "@/features/graphics/graphics-config";
import type { GraphicsJob } from "@/features/graphics/job-types";

export const runtime = "nodejs";

/** Poll a job's current state (the worker keeps job.json fresh + heartbeats it). */
export async function GET(req: NextRequest) {
	const id = req.nextUrl.searchParams.get("id");
	if (!id) return NextResponse.json({ error: "missing id" }, { status: 400 });
	try {
		const raw = fs.readFileSync(jobFilePath(id), "utf8");
		const job = JSON.parse(raw) as GraphicsJob;
		return NextResponse.json({ job });
	} catch {
		return NextResponse.json({ error: "job not found" }, { status: 404 });
	}
}
