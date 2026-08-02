import { describe, expect, test } from "bun:test";
import {
	countTranscriptWords,
	deriveTranscriptReadyState,
} from "../transcript-ready-state";

describe("deriveTranscriptReadyState", () => {
	test("loading with no known percent", () => {
		expect(
			deriveTranscriptReadyState({
				loadStatus: "loading",
				wordCount: 0,
				stale: false,
				timelineChanged: false,
			}),
		).toEqual({ tone: "transcribing", label: "Transcribing..." });
	});

	test("loading with a known percent (model download phase)", () => {
		expect(
			deriveTranscriptReadyState({
				loadStatus: "loading",
				progressPercent: 0.42,
				wordCount: 0,
				stale: false,
				timelineChanged: false,
			}),
		).toEqual({ tone: "transcribing", label: "Transcribing... 42%" });
	});

	test("error", () => {
		expect(
			deriveTranscriptReadyState({
				loadStatus: "error",
				wordCount: 0,
				stale: false,
				timelineChanged: false,
			}).tone,
		).toBe("error");
	});

	test("empty (no speech found)", () => {
		expect(
			deriveTranscriptReadyState({
				loadStatus: "empty",
				wordCount: 0,
				stale: false,
				timelineChanged: false,
			}).tone,
		).toBe("idle");
	});

	test("ready with a word count, singular", () => {
		expect(
			deriveTranscriptReadyState({
				loadStatus: "ready",
				wordCount: 1,
				stale: false,
				timelineChanged: false,
			}),
		).toEqual({ tone: "ready", label: "Transcript ready - 1 word" });
	});

	test("ready with a word count, plural", () => {
		expect(
			deriveTranscriptReadyState({
				loadStatus: "ready",
				wordCount: 240,
				stale: false,
				timelineChanged: false,
			}),
		).toEqual({ tone: "ready", label: "Transcript ready - 240 words" });
	});

	test("stale local preview after a manual delete", () => {
		expect(
			deriveTranscriptReadyState({
				loadStatus: "ready",
				wordCount: 10,
				stale: true,
				timelineChanged: false,
			}).tone,
		).toBe("stale");
	});

	test("timelineChanged takes priority over a plain stale preview", () => {
		const state = deriveTranscriptReadyState({
			loadStatus: "ready",
			wordCount: 10,
			stale: true,
			timelineChanged: true,
		});
		expect(state.tone).toBe("stale");
		expect(state.label).toBe("Timeline changed - refresh needed");
	});
});

describe("countTranscriptWords", () => {
	test("word granularity counts items directly", () => {
		expect(
			countTranscriptWords({
				granularity: "word",
				words: [{ text: "hi" }, { text: "there" }],
				segments: [{ text: "hi there" }],
			}),
		).toBe(2);
	});

	test("segment granularity splits text on whitespace", () => {
		expect(
			countTranscriptWords({
				granularity: "segment",
				words: [],
				segments: [{ text: "hello world" }, { text: "one  two   three" }],
			}),
		).toBe(5);
	});

	test("segment granularity handles empty text", () => {
		expect(
			countTranscriptWords({
				granularity: "segment",
				words: [],
				segments: [{ text: "" }, { text: "   " }],
			}),
		).toBe(0);
	});
});
