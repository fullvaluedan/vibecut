/**
 * A word-level caller that joined an already in-flight transcription still needs its
 * OWN run only when that run produced no words AND wasn't flagged words-unavailable
 * (i.e. a plain segment-only run). When words are present, or the model already
 * declared it can't produce them, re-running would just repeat the same work.
 *
 * Pure and dependency-free so the join / upgrade decision behind the
 * two-concurrent-extractions fix is unit-testable without loading the transcription
 * pipeline (mediabunny / Whisper workers).
 */
export function needsWordUpgrade({
	wantWords,
	result,
}: {
	wantWords: boolean;
	result: { words?: unknown[]; wordsUnavailable?: boolean };
}): boolean {
	return wantWords && !result.words && !result.wordsUnavailable;
}
