import { NextRequest, NextResponse } from "next/server";
import {
	CLEARVOICE_SERVICE_URL,
	LONG_JOB_DISPATCHER,
	MAX_AUDIO_BYTES,
	MAX_AUDIO_MB,
	undiciFetch,
} from "./service";

export const runtime = "nodejs";
export const maxDuration = 600;

/**
 * Proxy to the local ClearVoice service (`services/audio-enhance`), which runs
 * the ClearerVoice-Studio PyTorch models - the browser cannot run them. The
 * service URL is configurable so a hosted deployment can point at a sidecar;
 * loopback is the dev default.
 */
const TASKS = new Set([
	"denoise",
	"super_resolution",
	"separate",
	"balance",
]);

export async function GET() {
	try {
		const res = await fetch(`${CLEARVOICE_SERVICE_URL}/health`, {
			signal: AbortSignal.timeout(3000),
		});
		return NextResponse.json({ available: res.ok });
	} catch {
		return NextResponse.json({ available: false });
	}
}

export async function POST(req: NextRequest) {
	const url = new URL(req.url);
	const task = url.searchParams.get("task");
	if (typeof task !== "string" || !TASKS.has(task)) {
		return NextResponse.json(
			{ error: `Unsupported task: ${String(task ?? "(none)")}` },
			{ status: 400 },
		);
	}
	const audio = await req.arrayBuffer().catch(() => null);
	if (!audio || audio.byteLength === 0) {
		return NextResponse.json(
			{ error: "Missing audio upload." },
			{ status: 400 },
		);
	}
	if (audio.byteLength > MAX_AUDIO_BYTES) {
		return NextResponse.json(
			{
				error: `Audio is too large to enhance in one pass (${MAX_AUDIO_MB} MB limit, about 2 hours of footage). Split the project into shorter sections and try again.`,
			},
			{ status: 413 },
		);
	}

	// Create the enhancement job on the service (the service runs it on a
	// worker thread and reports per-chunk progress via /enhance/{jobId}).
	try {
		const res = await undiciFetch(
			`${CLEARVOICE_SERVICE_URL}/enhance?task=${task}`,
			{
				method: "POST",
				headers: { "content-type": "audio/wav" },
				body: new Uint8Array(audio),
				signal: req.signal,
				dispatcher: LONG_JOB_DISPATCHER,
			},
		);
		if (!res.ok) {
			const detail = await res.text().catch(() => "");
			return NextResponse.json(
				{
					error: `ClearVoice service error (${res.status})${
						detail ? `: ${detail.slice(0, 300)}` : ""
					}`,
				},
				{ status: res.status === 409 ? 409 : 502 },
			);
		}
		return NextResponse.json(await res.json());
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
