import { NextRequest, NextResponse } from "next/server";
import { Agent, fetch as undiciFetch } from "undici";

export const runtime = "nodejs";
export const maxDuration = 600;

/**
 * Proxy to the local ClearVoice service (`services/audio-enhance`), which runs
 * the ClearerVoice-Studio PyTorch models - the browser cannot run them. The
 * service URL is configurable so a hosted deployment can point at a sidecar;
 * loopback is the dev default.
 */
const SERVICE_URL = process.env.CLEARVOICE_SERVICE_URL ?? "http://127.0.0.1:8760";
// ClearVoice itself has no upload cap; this guard only protects the dev
// machine's memory. 256 MB of 16 kHz mono WAV is roughly 2h13m of audio,
// comfortably covering a 2-hour project. Override with CLEARVOICE_MAX_AUDIO_BYTES.
const MAX_AUDIO_BYTES = (() => {
	const raw = Number(process.env.CLEARVOICE_MAX_AUDIO_BYTES);
	const fallback = 256 * 1024 * 1024;
	if (!Number.isFinite(raw) || raw <= 0) return fallback;
	return Math.min(Math.max(raw, 1024 * 1024), 1024 * 1024 * 1024);
})();
const TASKS = new Set(["denoise", "super_resolution", "separate"]);
const MAX_AUDIO_MB = Math.round(MAX_AUDIO_BYTES / (1024 * 1024));

// Long footage on CPU takes hours; undici's default 5-minute
// response-header timeout would abort the fetch mid-job. Give the upstream a
// long window and let the client's AbortSignal remain the only real cancel.
const LONG_JOB_DISPATCHER = new Agent({
	headersTimeout: 8 * 3600 * 1000,
	bodyTimeout: 8 * 3600 * 1000,
	connectTimeout: 10_000,
});

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

	try {
		const res = await undiciFetch(
			`${SERVICE_URL}/enhance?task=${task}`,
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
