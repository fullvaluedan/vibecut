import { afterEach, describe, expect, it } from "bun:test";
import {
	classifyGroqStatus,
	describeGroqFailure,
	GroqTranscriptionError,
	normalizeGroqVerboseJson,
	transcribeWithGroq,
} from "@/services/transcription/providers/groq";

/**
 * Groq returns OpenAI Whisper `verbose_json` (seconds, words under `word`). The
 * normalizer maps it to the app's `TranscriptionResult` so the cloud transcript
 * flows through the exact same {segments, words} pipe as the in-browser path.
 */
describe("normalizeGroqVerboseJson", () => {
	it("maps segments and words (seconds, word->text)", () => {
		const result = normalizeGroqVerboseJson({
			task: "transcribe",
			language: "english",
			duration: 3.5,
			text: " hello world",
			segments: [{ id: 0, start: 0, end: 1.5, text: " hello world" }],
			words: [
				{ word: "hello", start: 0, end: 0.5 },
				{ word: "world", start: 0.6, end: 1.5 },
			],
		});
		expect(result).toEqual({
			text: " hello world",
			language: "english",
			segments: [{ start: 0, end: 1.5, text: " hello world" }],
			words: [
				{ start: 0, end: 0.5, text: "hello" },
				{ start: 0.6, end: 1.5, text: "world" },
			],
		});
	});

	it("returns words: undefined when there are none", () => {
		const result = normalizeGroqVerboseJson({
			language: "english",
			text: "hi",
			segments: [{ start: 0, end: 1, text: "hi" }],
		});
		expect(result.words).toBeUndefined();
		expect(result.segments).toEqual([{ start: 0, end: 1, text: "hi" }]);
	});

	it("drops malformed segment/word entries instead of throwing", () => {
		const result = normalizeGroqVerboseJson({
			text: "ok",
			language: "english",
			segments: [
				{ start: 0, end: 1, text: "ok" },
				{ start: "bad", end: 2, text: "skip" },
				null,
			],
			words: [{ start: 0, end: 1 /* no word */ }, { word: "x", start: 1, end: 2 }],
		});
		expect(result.segments).toEqual([{ start: 0, end: 1, text: "ok" }]);
		expect(result.words).toEqual([{ start: 1, end: 2, text: "x" }]);
	});

	it("derives text from segments when top-level text is missing", () => {
		const result = normalizeGroqVerboseJson({
			language: "english",
			segments: [
				{ start: 0, end: 1, text: "a" },
				{ start: 1, end: 2, text: "b" },
			],
		});
		expect(result.text).toBe("ab");
	});

	it("is defensive against a non-object payload", () => {
		expect(normalizeGroqVerboseJson(null)).toEqual({
			text: "",
			segments: [],
			language: "",
		});
	});
});

/**
 * T16.3 G6 reopen: a failed Groq request used to flatten to a raw
 * "(500)" the panel showed verbatim, with no way to tell an invalid key from
 * a rate limit from Groq being down. These map every real status Groq (or
 * the proxy route) can return to a plain-language reason.
 */
describe("classifyGroqStatus", () => {
	it("maps 401 and 403 to unauthorized", () => {
		expect(classifyGroqStatus(401)).toBe("unauthorized");
		expect(classifyGroqStatus(403)).toBe("unauthorized");
	});

	it("maps 429 to rate-limited", () => {
		expect(classifyGroqStatus(429)).toBe("rate-limited");
	});

	it("maps 413 to payload-too-large", () => {
		expect(classifyGroqStatus(413)).toBe("payload-too-large");
	});

	it("maps anything else (500, 503, an unexpected 4xx) to server-error", () => {
		expect(classifyGroqStatus(500)).toBe("server-error");
		expect(classifyGroqStatus(503)).toBe("server-error");
		expect(classifyGroqStatus(418)).toBe("server-error");
	});
});

describe("describeGroqFailure", () => {
	it("gives an actionable message per failure kind", () => {
		expect(
			describeGroqFailure({ status: 401, kind: "unauthorized" }),
		).toBe("Groq key rejected - check your key.");
		expect(
			describeGroqFailure({ status: 429, kind: "rate-limited" }),
		).toBe("Groq rate limit hit - wait a moment and try again.");
		expect(
			describeGroqFailure({ status: 413, kind: "payload-too-large" }),
		).toBe("This recording is too large for Groq's cloud upload limit.");
	});

	it("includes the real HTTP status for the generic server-error case", () => {
		expect(describeGroqFailure({ status: 503, kind: "server-error" })).toBe(
			"Groq's transcription service returned an error (HTTP 503).",
		);
	});

	it("never contains a raw stack trace or JSON blob", () => {
		const message = describeGroqFailure({ status: 500, kind: "server-error" });
		expect(message).not.toMatch(/at .*\(.*:\d+:\d+\)/);
		expect(message).not.toMatch(/^\s*[{[]/);
	});
});

describe("transcribeWithGroq", () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	function stubFetch(impl: typeof fetch) {
		globalThis.fetch = impl as typeof globalThis.fetch;
	}

	it("throws a GroqTranscriptionError carrying the real status on a 401", async () => {
		stubFetch(async () =>
			new Response("invalid_api_key", { status: 401 }),
		);
		await expect(
			transcribeWithGroq({
				audio: new Blob(["x"]),
				filename: "a.wav",
				apiKey: "bad-key",
			}),
		).rejects.toMatchObject({
			name: "GroqTranscriptionError",
			status: 401,
			kind: "unauthorized",
			message: "Groq key rejected - check your key.",
		});
	});

	it("throws with the mapped message + status on a 429", async () => {
		stubFetch(async () => new Response("", { status: 429 }));
		const promise = transcribeWithGroq({
			audio: new Blob(["x"]),
			filename: "a.wav",
			apiKey: "k",
		});
		await expect(promise).rejects.toBeInstanceOf(GroqTranscriptionError);
		await expect(promise).rejects.toMatchObject({ status: 429 });
	});

	it("gives a plain 'could not reach Groq' message when fetch itself throws (offline)", async () => {
		stubFetch(async () => {
			throw new TypeError("Failed to fetch");
		});
		await expect(
			transcribeWithGroq({
				audio: new Blob(["x"]),
				filename: "a.wav",
				apiKey: "k",
			}),
		).rejects.toThrow(/Could not reach Groq/);
	});

	it("resolves normally on a 200", async () => {
		stubFetch(async () =>
			Response.json({
				text: "hi",
				language: "english",
				segments: [{ start: 0, end: 1, text: "hi" }],
			}),
		);
		const result = await transcribeWithGroq({
			audio: new Blob(["x"]),
			filename: "a.wav",
			apiKey: "k",
		});
		expect(result.text).toBe("hi");
		expect(result.segments).toEqual([{ start: 0, end: 1, text: "hi" }]);
	});
});
