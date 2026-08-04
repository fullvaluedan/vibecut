import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 600;

/**
 * Proxy to the local ClearVoice service (`services/audio-enhance`), which runs
 * the ClearerVoice-Studio PyTorch models - the browser cannot run them. The
 * service URL is configurable so a hosted deployment can point at a sidecar;
 * loopback is the dev default.
 */
const SERVICE_URL = process.env.CLEARVOICE_SERVICE_URL ?? "http://127.0.0.1:8760";
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const TASKS = new Set(["denoise", "super_resolution", "separate"]);

export async function GET() {
	try {
		const res = await fetch(`${SERVICE_URL}/health`, {
			signal: AbortSignal.timeout(3000),
		});
		return NextResponse.json({ available: res.ok });
	} catch {
		return NextResponse.json({ available: false });
	}
}

export async function POST(req: NextRequest) {
	const form = await req.formData().catch(() => null);
	if (!form) {
		return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
	}
	const task = form.get("task");
	if (typeof task !== "string" || !TASKS.has(task)) {
		return NextResponse.json(
			{ error: `Unsupported task: ${String(task ?? "(none)")}` },
			{ status: 400 },
		);
	}
	const audio = form.get("audio");
	if (!(audio instanceof Blob)) {
		return NextResponse.json({ error: "Missing audio upload." }, { status: 400 });
	}
	if (audio.size > MAX_AUDIO_BYTES) {
		return NextResponse.json(
			{ error: "Audio is too large to enhance (25 MB limit)." },
			{ status: 413 },
		);
	}

	const upstream = new FormData();
	upstream.set("task", task);
	upstream.set("audio", audio, "input.wav");

	try {
		const res = await fetch(`${SERVICE_URL}/enhance`, {
			method: "POST",
			body: upstream,
			signal: req.signal,
		});
		if (!res.ok) {
			const detail = await res.text().catch(() => "");
			return NextResponse.json(
				{
					error: `ClearVoice service error (${res.status})${
						detail ? `: ${detail.slice(0, 300)}` : ""
					}`,
				},
				{ status: 502 },
			);
		}
		const buffer = await res.arrayBuffer();
		return new NextResponse(new Uint8Array(buffer), {
			headers: {
				"content-type": res.headers.get("content-type") ?? "audio/wav",
				"content-length": String(buffer.byteLength),
				"x-framecut-enhance-task": task,
			},
		});
	} catch {
		return NextResponse.json(
			{
				error:
					"The ClearVoice service isn't running. Start it with services/audio-enhance/start.ps1.",
			},
			{ status: 503 },
		);
	}
}
