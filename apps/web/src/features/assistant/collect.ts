/**
 * Collecting the live editor into an assistant turn's context (T17.1).
 *
 * `snapshot.ts` is deliberately store-free, so something has to bridge it to the
 * real read paths. That is this module, split so the decision logic stays pure:
 * `readAssistantTranscript` takes a plain source object, and
 * `editorTranscriptSource` is the one function that knows about the lineage and
 * the transcript cache. The toolbar toggles are passed in by the caller because
 * they live in a persisted zustand store that belongs to the UI layer.
 *
 * TRANSCRIPT PRECEDENCE. The T16.1 lineage comes first: it survives edits, so
 * after a cut it still describes the words that are on the timeline NOW. The
 * plain transcript cache is the fallback for projects with a transcript but no
 * lineage yet. Neither path ever starts a transcription: an assistant prompt
 * must not block on Whisper.
 */

import type { EditorCore } from "@/core";
import { readTranscriptLineage } from "@/features/transcription/lineage";
import { getCachedWords } from "@/features/transcription/transcript-cache";
import {
	serializeAssistantContext,
	type AssistantContext,
	type AssistantContextOptions,
} from "./context";
import {
	buildTimelineSnapshot,
	type AssistantSnapshotEditor,
	type SnapshotProtectedSpan,
	type SnapshotTranscript,
	type TimelineSnapshot,
} from "./snapshot";

/** A word as both transcript read paths report it: SECONDS, not ticks. */
export interface TranscriptSourceWord {
	start: number;
	end: number;
	text: string;
}

/** The two transcript reads, as plain thunks so the chooser below stays pure. */
export interface AssistantTranscriptSource {
	readLineageWords: () => {
		status: string;
		words: TranscriptSourceWord[];
	} | null;
	readCachedWords: () => TranscriptSourceWord[];
}

/** Bind the real read paths to an editor. The only store-aware function here. */
export function editorTranscriptSource(
	editor: EditorCore,
): AssistantTranscriptSource {
	return {
		readLineageWords: () => readTranscriptLineage({ editor }),
		readCachedWords: () => getCachedWords(editor),
	};
}

/**
 * The words currently on the timeline: lineage when it explains the timeline,
 * cache otherwise, nothing if neither has anything. A throwing read path is
 * treated as "no transcript" rather than as an error, because a missing
 * transcript must never break a prompt.
 */
export function readAssistantTranscript(
	source: AssistantTranscriptSource,
): SnapshotTranscript {
	try {
		const view = source.readLineageWords();
		if (view && view.status === "explained" && view.words.length > 0) {
			return { source: "lineage", words: view.words.map(toSnapshotWord) };
		}
	} catch {
		// Fall through to the cache.
	}
	try {
		const cached = source.readCachedWords();
		if (cached.length > 0) {
			return { source: "cache", words: cached.map(toSnapshotWord) };
		}
	} catch {
		// No transcript is a valid state.
	}
	return { source: "none", words: [] };
}

function toSnapshotWord(word: TranscriptSourceWord) {
	return { startSec: word.start, endSec: word.end, text: word.text };
}

/**
 * One call for the whole read side of a turn: snapshot the timeline, read the
 * transcript, serialize the context. Returns BOTH, because T17.2 needs the
 * snapshot (to re-validate at execute time) and the route needs the context.
 */
export function collectAssistantContext({
	editor,
	transcriptSource,
	toggles,
	protectedSpans,
	options,
}: {
	editor: AssistantSnapshotEditor;
	transcriptSource: AssistantTranscriptSource;
	toggles: {
		magnetEnabled: boolean;
		rippleEditingEnabled: boolean;
		snappingEnabled: boolean;
	};
	protectedSpans?: SnapshotProtectedSpan[];
	options?: AssistantContextOptions;
}): { snapshot: TimelineSnapshot; context: AssistantContext } {
	const snapshot = buildTimelineSnapshot({
		editor,
		transcript: readAssistantTranscript(transcriptSource),
		toggles,
		...(protectedSpans ? { protectedSpans } : {}),
	});
	return { snapshot, context: serializeAssistantContext({ snapshot, options }) };
}
