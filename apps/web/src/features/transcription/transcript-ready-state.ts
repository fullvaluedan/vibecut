/**
 * T16.3: the transcript panel header's ambient status - what the user sees
 * without opening the tab body. Today a `wantWords: true` load can block for a
 * while with no signal in the header at all; this derives ONE honest label
 * from the load status, the live progress broadcast, and the local-preview /
 * stale flags already computed in assets-view.tsx, so that blocking pass is
 * always announced.
 */

export type TranscriptReadyTone =
	| "idle"
	| "transcribing"
	| "ready"
	| "stale"
	| "error";

export interface TranscriptReadyState {
	tone: TranscriptReadyTone;
	label: string;
}

export function deriveTranscriptReadyState({
	loadStatus,
	progressPercent,
	wordCount,
	stale,
	timelineChanged,
}: {
	loadStatus: "loading" | "ready" | "empty" | "error";
	/** 0..1, only known during phases with a real percentage (e.g. model download). */
	progressPercent?: number | null;
	wordCount: number;
	/** A local post-delete preview is showing (KTD-stale). */
	stale: boolean;
	/** The live timeline diverged from the local preview's coords. */
	timelineChanged: boolean;
}): TranscriptReadyState {
	if (loadStatus === "loading") {
		const pct =
			progressPercent != null ? ` ${Math.round(progressPercent * 100)}%` : "";
		return { tone: "transcribing", label: `Transcribing...${pct}` };
	}
	if (loadStatus === "error") {
		return { tone: "error", label: "Transcript failed to load" };
	}
	if (loadStatus === "empty") {
		return { tone: "idle", label: "No speech detected" };
	}
	// loadStatus === "ready" from here.
	if (timelineChanged) {
		return { tone: "stale", label: "Timeline changed - refresh needed" };
	}
	if (stale) {
		return {
			tone: "stale",
			label: "Local preview - refresh for the live transcript",
		};
	}
	return {
		tone: "ready",
		label: `Transcript ready - ${wordCount} word${wordCount === 1 ? "" : "s"}`,
	};
}

/**
 * Word count for the "M words" label. Direct item count in word granularity;
 * a whitespace split of segment text in the degraded segment-only fallback
 * (KTD4), so the header still reports something honest without word timing.
 */
export function countTranscriptWords({
	granularity,
	words,
	segments,
}: {
	granularity: "word" | "segment";
	words: readonly { text: string }[];
	segments: readonly { text: string }[];
}): number {
	if (granularity === "word") return words.length;
	return segments.reduce(
		(total, segment) =>
			total + segment.text.trim().split(/\s+/).filter(Boolean).length,
		0,
	);
}
