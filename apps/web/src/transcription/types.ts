import type { LanguageCode } from "./languages";

export type TranscriptionLanguage = LanguageCode | "auto";

export interface TranscriptionSegment {
	text: string;
	start: number;
	end: number;
}

/** One word with its own timing — only produced in word-timestamp mode. */
export interface TranscriptionWord {
	text: string;
	start: number;
	end: number;
}

export interface TranscriptionResult {
	text: string;
	segments: TranscriptionSegment[];
	/** Present only when transcription was requested with word timestamps. */
	words?: TranscriptionWord[];
	/**
	 * True when word timestamps were requested but this model's ONNX export
	 * can't produce them — the result degraded to segment-level only.
	 */
	wordsUnavailable?: boolean;
	language: string;
}

export type TranscriptionStatus =
	| "idle"
	| "loading-model"
	| "transcribing"
	| "complete"
	| "error";

export interface TranscriptionProgress {
	status: TranscriptionStatus;
	progress: number;
	message?: string;
}

export type TranscriptionModelId =
	| "whisper-tiny"
	| "whisper-small"
	| "whisper-medium"
	| "whisper-large-v3-turbo"
	// Word-timestamp-capable exports (cross-attention) for the Director/analysis
	// path so the word-level detectors can run. `whisper-tiny-timestamped` is
	// VERIFIED to emit word timestamps in our transformers.js (U1 spike,
	// 2026-06-24); base/medium remain unverified candidates (base failed a
	// headless load — confirm in-app before adopting).
	| "whisper-tiny-timestamped"
	| "whisper-base-timestamped"
	| "whisper-medium-en-timestamped";

export interface TranscriptionModel {
	id: TranscriptionModelId;
	name: string;
	huggingFaceId: string;
	description: string;
}

export interface CaptionChunk {
	text: string;
	startTime: number;
	duration: number;
}
