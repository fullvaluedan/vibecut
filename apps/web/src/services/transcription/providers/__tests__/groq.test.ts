import { describe, expect, it } from "bun:test";
import { normalizeGroqVerboseJson } from "@/services/transcription/providers/groq";

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
