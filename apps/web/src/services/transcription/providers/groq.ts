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
 * Coarse bucket for a failed Groq request, used to pick a plain-language
 * message (T16.3 G6: a raw "(401)" status was not actionable). Anything not
 * recognized falls into "server-error" and still carries the real status.
 */
export type GroqFailureKind =
	| "unauthorized"
	| "rate-limited"
	| "payload-too-large"
	| "server-error";

export function classifyGroqStatus(status: number): GroqFailureKind {
	if (status === 401 || status === 403) return "unauthorized";
	if (status === 429) return "rate-limited";
	if (status === 413) return "payload-too-large";
	return "server-error";
}

/**
 * Plain-language message for a failed Groq request. No raw stack traces or
 * upstream JSON bodies - just what happened and, for the generic case, the
 * HTTP status so a report is still traceable.
 */
export function describeGroqFailure({
	status,
	kind,
}: {
	status: number;
	kind: GroqFailureKind;
}): string {
	switch (kind) {
		case "unauthorized":
			return "Groq key rejected - check your key.";
		case "rate-limited":
			return "Groq rate limit hit - wait a moment and try again.";
		case "payload-too-large":
			return "This recording is too large for Groq's cloud upload limit.";
		case "server-error":
			return `Groq's transcription service returned an error (HTTP ${status}).`;
	}
}

/**
 * A failed Groq request, carrying the real HTTP status + failure bucket so
 * the API route can return the same status instead of flattening every
 * failure to a generic 500 (the route previously did this, which is why the
 * client only ever saw "Cloud transcription failed (500)" regardless of the
 * real cause - see route.ts).
 */
export class GroqTranscriptionError extends Error {
	readonly status: number;
	readonly kind: GroqFailureKind;

	constructor(status: number, kind: GroqFailureKind, message: string) {
		super(message);
		this.name = "GroqTranscriptionError";
		this.status = status;
		this.kind = kind;
	}
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

	let response: Response;
	try {
		response = await fetch(GROQ_URL, {
			method: "POST",
			headers: { Authorization: `Bearer ${apiKey}` },
			body: form,
			signal,
		});
	} catch (networkError) {
		// The SERVER couldn't reach Groq at all (DNS, TLS, Groq is down) - distinct
		// from a Groq-returned status, so it carries no `.status`; route.ts maps
		// this to 502.
		throw new Error(
			`Could not reach Groq: ${networkError instanceof Error ? networkError.message : String(networkError)}`,
		);
	}

	if (!response.ok) {
		// Groq's raw body is logged server-side ONLY (never shown to the user -
		// it can be a verbose JSON blob, not a plain-language message).
		const detail = await response.text().catch(() => "");
		if (detail) {
			console.error(`[groq] request failed (${response.status}): ${detail.slice(0, 500)}`);
		}
		const kind = classifyGroqStatus(response.status);
		throw new GroqTranscriptionError(
			response.status,
			kind,
			describeGroqFailure({ status: response.status, kind }),
		);
	}

	const json: unknown = await response.json();
	return normalizeGroqVerboseJson(json);
}
