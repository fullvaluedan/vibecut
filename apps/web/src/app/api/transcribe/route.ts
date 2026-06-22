import { NextRequest, NextResponse } from "next/server";
import { transcribeWithGroq } from "@/services/transcription/providers/groq";

export const runtime = "nodejs";
export const maxDuration = 300;

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
	const apiKey = req.headers.get("x-framecut-transcribe-key");

	if (!apiKey) {
		return NextResponse.json(
			{ error: "Add your transcription API key in Settings → AI." },
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

	try {
		const result = await transcribeWithGroq({
			audio,
			filename: "timeline.wav",
			apiKey,
			signal: req.signal,
		});
		return NextResponse.json(result);
	} catch (e) {
		return NextResponse.json(
			{
				error: `Transcription failed: ${e instanceof Error ? e.message : String(e)}`,
			},
			{ status: 500 },
		);
	}
}
