import { NextRequest, NextResponse } from "next/server";
import {
	GroqTranscriptionError,
	transcribeWithGroq,
} from "@/services/transcription/providers/groq";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * True when the deployment has a server-side Groq key configured (Round 21
 * groundwork). Read fresh each call rather than cached at module load so a
 * test (or a platform that hot-swaps env) sees the current value.
 */
function hasServerGroqKey(): boolean {
	return typeof process.env.GROQ_API_KEY === "string" && process.env.GROQ_API_KEY.length > 0;
}

/**
 * Lets the client know whether cloud transcription is available WITHOUT a
 * device-local key, so it can attempt the cloud path even when the user never
 * pasted a Groq key into Settings → AI. Reveals nothing else, never the key
 * itself, never its length or shape.
 */
export async function GET() {
	return NextResponse.json({ groqServerKey: hasServerGroqKey() });
}

/**
 * Cloud transcription proxy. The browser can't call Groq/Deepgram/etc. directly
 * (CORS) and the BYO key must never reach the browser STT call, so the editor
 * POSTs the extracted timeline audio (a WAV blob) here with the provider + key
 * in headers — the same shape as the AI-auth proxy for the Director. Returns the
 * normalized `TranscriptionResult` ({ text, segments, words?, language }) the
 * in-browser path already produces, so everything downstream is unchanged.
 *
 * v1 = Groq only. The provider switch is where Deepgram/AssemblyAI drop in.
 */
export async function POST(req: NextRequest) {
	const provider = req.headers.get("x-framecut-transcribe-provider");
	// The device-local (BYO) key from Settings → AI wins when present; otherwise
	// fall back to a server-configured GROQ_API_KEY (Round 21 groundwork) so a
	// deployment can offer cloud transcription without every user pasting their
	// own key. Neither key is ever echoed back in a response body or a log line.
	const headerKey = req.headers.get("x-framecut-transcribe-key");
	const apiKey = headerKey || process.env.GROQ_API_KEY || "";

	if (!apiKey) {
		return NextResponse.json(
			{
				error:
					"No Groq key configured - add one in Settings or set GROQ_API_KEY.",
			},
			{ status: 401 },
		);
	}
	if (provider !== "groq") {
		return NextResponse.json(
			{ error: `Unsupported transcription provider: ${provider ?? "(none)"}.` },
			{ status: 400 },
		);
	}

	const form = await req.formData().catch(() => null);
	const audio = form?.get("audio");
	if (!(audio instanceof Blob)) {
		return NextResponse.json(
			{ error: "Missing audio upload." },
			{ status: 400 },
		);
	}

	// Forward the uploaded filename so Groq detects the codec from its extension
	// (.webm/.m4a/.wav). The client compresses before upload; default keeps the
	// legacy WAV name if a plain Blob (no name) arrives.
	const uploadedName =
		typeof File !== "undefined" && audio instanceof File ? audio.name : "";
	const filename = uploadedName.length > 0 ? uploadedName : "timeline.wav";

	try {
		const result = await transcribeWithGroq({
			audio,
			filename,
			apiKey,
			signal: req.signal,
		});
		return NextResponse.json(result);
	} catch (e) {
		// A GroqTranscriptionError carries the REAL upstream status (401/403/429/
		// 413/...) so the client can tell "key rejected" from "rate limited" from
		// "Groq is down" instead of every failure flattening to a generic 500
		// (T16.3 G6 - that flattening is why the client only ever saw
		// "Cloud transcription failed (500)" no matter the real cause).
		if (e instanceof GroqTranscriptionError) {
			return NextResponse.json({ error: e.message }, { status: e.status });
		}
		// Anything else (network failure reaching Groq, a bad audio decode, an
		// unexpected throw) is an upstream problem, not the client's - 502.
		console.error("[transcribe] unexpected failure:", e);
		return NextResponse.json(
			{
				error: `Transcription failed: ${e instanceof Error ? e.message : String(e)}`,
			},
			{ status: 502 },
		);
	}
}
