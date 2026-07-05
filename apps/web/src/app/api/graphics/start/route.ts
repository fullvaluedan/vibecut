import { NextRequest, NextResponse } from "next/server";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
	REMOTION_PROJECT_DIR,
	TEMP_ROOT,
	jobDir,
	jobFilePath,
	resolveWorkerScript,
} from "@/features/graphics/graphics-config";
import type { GraphicsJob } from "@/features/graphics/job-types";

export const runtime = "nodejs";
export const maxDuration = 60; // just staging + spawn; the worker runs detached

/**
 * Stage the source video + transcript into the engine project and spawn the detached
 * graphics worker. Body is multipart: `video` (File), `transcript` (JSON string),
 * `engine` ("remotion" | "hyperframes"). Returns `{ id }`; the client then polls
 * /api/graphics/status.
 */
export async function POST(req: NextRequest) {
	let form: FormData;
	try {
		form = await req.formData();
	} catch {
		return NextResponse.json({ error: "expected multipart form-data" }, { status: 400 });
	}
	const video = form.get("video");
	const transcript = form.get("transcript");
	const engine = String(form.get("engine") ?? "remotion");
	if (!(video instanceof File)) {
		return NextResponse.json({ error: "missing video file" }, { status: 400 });
	}
	if (engine !== "remotion" && engine !== "hyperframes") {
		return NextResponse.json({ error: "invalid engine" }, { status: 400 });
	}

	// Deterministic id from the request time (no Math.random in this env for the worker,
	// but here a timestamp id is fine and readable).
	const id = `gfx-${engine}-${Date.now()}`;
	const dir = jobDir(id);
	fs.mkdirSync(dir, { recursive: true });

	// Stage inputs into the engine project's public/ (the dan-video skill's convention).
	const publicDir = path.join(REMOTION_PROJECT_DIR, "public");
	try {
		fs.mkdirSync(publicDir, { recursive: true });
		const bytes = Buffer.from(await video.arrayBuffer());
		fs.writeFileSync(path.join(publicDir, "source.mp4"), bytes);
		// Keep a copy alongside the job for provenance / re-runs.
		fs.writeFileSync(path.join(dir, "source.mp4"), bytes);
		if (typeof transcript === "string" && transcript.trim()) {
			fs.writeFileSync(path.join(publicDir, "transcript.json"), transcript);
			fs.writeFileSync(path.join(dir, "transcript.json"), transcript);
		}
	} catch (e) {
		return NextResponse.json(
			{ error: `failed to stage inputs: ${e instanceof Error ? e.message : String(e)}` },
			{ status: 500 },
		);
	}

	const now = Date.now();
	const job: GraphicsJob = {
		id,
		engine,
		phase: "extracting",
		progress: 0,
		message: "Staged inputs. Starting the generator...",
		log: [{ t: now, text: "Job created", level: "info" }],
		heartbeatAt: now,
		createdAt: now,
	};
	fs.writeFileSync(jobFilePath(id), JSON.stringify(job, null, 2));

	// Spawn the worker DETACHED so a ~2hr render outlives this request + page reloads.
	try {
		const worker = spawn("node", [resolveWorkerScript(), id, engine], {
			detached: true,
			stdio: "ignore",
			env: {
				...process.env,
				GRAPHICS_TEMP_ROOT: TEMP_ROOT,
				GRAPHICS_REMOTION_DIR: REMOTION_PROJECT_DIR,
			},
		});
		worker.unref();
	} catch (e) {
		return NextResponse.json(
			{ error: `failed to start worker: ${e instanceof Error ? e.message : String(e)}` },
			{ status: 500 },
		);
	}

	return NextResponse.json({ id });
}
