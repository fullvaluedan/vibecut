/**
 * Groq cloud transcription provider (whisper-large-v3-turbo).
 *
 * OpenAI-compatible REST: one synchronous POST to /audio/transcriptions with
 * `response_format=verbose_json` returns segments AND word timestamps, so the
 * Director's word-level detectors (duplicate/filler/dead-air) re-arm without
 * the in-browser `_timestamped` model. Runs server-side only (in the
 * /api/transcribe route) — the browser can't call Groq directly (CORS) and the
 * key must never reach the browser STT call.
 *
 * `normalizeGroqVerboseJson` is a PURE function (no fetch/wasm) so it is
 * bun-testable; `transcribeWithGroq` does the upload and delegates to it.
 */

import type {
	TranscriptionResult,
	TranscriptionSegment,
	TranscriptionWord,
} from "@/transcription/types";

const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_MODEL = "whisper-large-v3-turbo";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

/**
 * Map Groq's Whisper `verbose_json` to the app's `TranscriptionResult`. Groq
 * reports start/end in SECONDS (same units the in-browser path produces), so
 * segments map straight through; words carry their text under `word`. Malformed
 * entries are dropped rather than throwing.
 */
export function normalizeGroqVerboseJson(raw: unknown): TranscriptionResult {
	if (!isRecord(raw)) {
		return { text: "", segments: [], language: "" };
	}

	const segments: TranscriptionSegment[] = [];
	for (const entry of asArray(raw.segments)) {
		if (!isRecord(entry)) continue;
		const { start, end } = entry;
		const text = entry.text;
		if (
			typeof start === "number" &&
			typeof end === "number" &&
			typeof text === "string"
		) {
			segments.push({ start, end, text });
		}
	}

	const words: TranscriptionWord[] = [];
	for (const entry of asArray(raw.words)) {
		if (!isRecord(entry)) continue;
		const { start, end } = entry;
		// Whisper verbose_json names the token `word`; tolerate `text` too.
		const text = typeof entry.word === "string" ? entry.word : entry.text;
		if (
			typeof start === "number" &&
			typeof end === "number" &&
			typeof text === "string"
		) {
			words.push({ start, end, text });
		}
	}

	const text =
		typeof raw.text === "string"
			? raw.text
			: segments.map((segment) => segment.text).join("");
	const language = typeof raw.language === "string" ? raw.language : "";

	return {
		text,
		segments,
		words: words.length > 0 ? words : undefined,
		language,
	};
}

/** Upload audio to Groq and return the normalized transcript. Server-side. */
export async function transcribeWithGroq({
	audio,
	filename,
	apiKey,
	signal,
}: {
	audio: Blob;
	filename: string;
	apiKey: string;
	signal?: AbortSignal;
}): Promise<TranscriptionResult> {
	const form = new FormData();
	form.append("file", audio, filename);
	form.append("model", GROQ_MODEL);
	form.append("response_format", "verbose_json");
	form.append("timestamp_granularities[]", "segment");
	form.append("timestamp_granularities[]", "word");

	const response = await fetch(GROQ_URL, {
		method: "POST",
		headers: { Authorization: `Bearer ${apiKey}` },
		body: form,
		signal,
	});

	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		throw new Error(
			`Groq transcription failed (${response.status}): ${detail.slice(0, 300)}`,
		);
	}

	const json: unknown = await response.json();
	return normalizeGroqVerboseJson(json);
}
