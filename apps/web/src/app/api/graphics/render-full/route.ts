import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import { approveFlagPath, jobFilePath } from "@/features/graphics/graphics-config";

export const runtime = "nodejs";

/**
 * Release the proof-ready gate: the worker is polling for this flag and starts the
 * full (~2hr) render once it appears. Body: `{ id }`.
 */
export async function POST(req: NextRequest) {
	const { id } = (await req.json().catch(() => ({}))) as { id?: string };
	if (!id) return NextResponse.json({ error: "missing id" }, { status: 400 });
	if (!fs.existsSync(jobFilePath(id))) {
		return NextResponse.json({ error: "job not found" }, { status: 404 });
	}
	try {
		fs.writeFileSync(approveFlagPath(id), String(Date.now()));
	} catch (e) {
		return NextResponse.json(
			{ error: e instanceof Error ? e.message : String(e) },
			{ status: 500 },
		);
	}
	return NextResponse.json({ ok: true });
}
