import {
	pipeline,
	type AutomaticSpeechRecognitionPipeline,
	type AutomaticSpeechRecognitionOutput,
} from "@huggingface/transformers";
import type {
	TranscriptionSegment,
	TranscriptionWord,
} from "@/transcription/types";
import {
	DEFAULT_CHUNK_LENGTH_SECONDS,
	DEFAULT_STRIDE_SECONDS,
} from "@/transcription/audio";

export type WorkerMessage =
	| { type: "init"; modelId: string }
	| {
			type: "transcribe";
			audio: Float32Array;
			language: string;
			/** Opt-in: emit per-word timestamps (+ segments rebuilt from them). */
			wordTimestamps?: boolean;
	  }
	| { type: "cancel" };

export type WorkerResponse =
	| { type: "init-progress"; progress: number }
	| { type: "init-complete" }
	| { type: "init-error"; error: string }
	| { type: "transcribe-progress"; progress: number }
	| {
			type: "transcribe-complete";
			text: string;
			segments: TranscriptionSegment[];
			/** Present only when `wordTimestamps` was requested. */
			words?: TranscriptionWord[];
	  }
	| { type: "transcribe-error"; error: string }
	| { type: "cancelled" };

/** Word ends a phrase when it carries sentence-final punctuation. */
const SENTENCE_END = /[.!?]["')\]]?\s*$/;
/** A silence longer than this between words starts a new segment. */
const SEGMENT_GAP_SECONDS = 0.6;

/**
 * Rebuild phrase-level segments from word timing so word mode still satisfies
 * every segment consumer. Groups words until sentence-final punctuation or a
 * pause; faithful enough to stand in for Whisper's native chunking.
 */
function segmentsFromWords(
	words: TranscriptionWord[],
): TranscriptionSegment[] {
	const segments: TranscriptionSegment[] = [];
	let text = "";
	let start = 0;
	let open = false;
	for (let i = 0; i < words.length; i++) {
		const word = words[i];
		if (!open) {
			text = word.text;
			start = word.start;
			open = true;
		} else {
			text += word.text;
		}
		const next = words[i + 1];
		const gapToNext = next ? next.start - word.end : Infinity;
		if (SENTENCE_END.test(word.text) || gapToNext > SEGMENT_GAP_SECONDS) {
			const trimmed = text.trim();
			if (trimmed) segments.push({ text: trimmed, start, end: word.end });
			open = false;
		}
	}
	return segments;
}

let transcriber: AutomaticSpeechRecognitionPipeline | null = null;
let cancelled = false;
let lastReportedProgress = -1;
const fileBytes = new Map<string, { loaded: number; total: number }>();

self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
	const message = event.data;

	switch (message.type) {
		case "init":
			await handleInit({ modelId: message.modelId });
			break;
		case "transcribe":
			await handleTranscribe({
				audio: message.audio,
				language: message.language,
				wordTimestamps: message.wordTimestamps ?? false,
			});
			break;
		case "cancel":
			cancelled = true;
			self.postMessage({ type: "cancelled" } satisfies WorkerResponse);
			break;
	}
};

async function handleInit({ modelId }: { modelId: string }) {
	lastReportedProgress = -1;
	fileBytes.clear();

	try {
		transcriber = (await pipeline("automatic-speech-recognition", modelId, {
			dtype: "q4",
			device: "auto",
			progress_callback: (progressInfo: {
				status?: string;
				file?: string;
				loaded?: number;
				total?: number;
			}) => {
				const file = progressInfo.file;
				if (!file) return;

				const loaded = progressInfo.loaded ?? 0;
				const total = progressInfo.total ?? 0;

				if (progressInfo.status === "progress" && total > 0) {
					fileBytes.set(file, { loaded, total });
				} else if (progressInfo.status === "done") {
					const existing = fileBytes.get(file);
					if (existing) {
						fileBytes.set(file, {
							loaded: existing.total,
							total: existing.total,
						});
					}
				}

				// sum all bytes
				let totalLoaded = 0;
				let totalSize = 0;
				for (const { loaded, total } of fileBytes.values()) {
					totalLoaded += loaded;
					totalSize += total;
				}

				if (totalSize === 0) return;

				const overallProgress = (totalLoaded / totalSize) * 100;
				const roundedProgress = Math.floor(overallProgress);

				if (roundedProgress !== lastReportedProgress) {
					lastReportedProgress = roundedProgress;
					self.postMessage({
						type: "init-progress",
						progress: roundedProgress,
					} satisfies WorkerResponse);
				}
			},
		})) as unknown as AutomaticSpeechRecognitionPipeline;

		self.postMessage({ type: "init-complete" } satisfies WorkerResponse);
	} catch (error) {
		self.postMessage({
			type: "init-error",
			error: error instanceof Error ? error.message : "Failed to load model",
		} satisfies WorkerResponse);
	}
}

async function handleTranscribe({
	audio,
	language,
	wordTimestamps,
}: {
	audio: Float32Array;
	language: string;
	wordTimestamps: boolean;
}) {
	if (!transcriber) {
		self.postMessage({
			type: "transcribe-error",
			error: "Model not initialized",
		} satisfies WorkerResponse);
		return;
	}

	cancelled = false;

	try {
		const rawResult = await transcriber(audio, {
			chunk_length_s: DEFAULT_CHUNK_LENGTH_SECONDS,
			stride_length_s: DEFAULT_STRIDE_SECONDS,
			language: language === "auto" ? undefined : language,
			return_timestamps: wordTimestamps ? "word" : true,
		});

		if (cancelled) return;

		const result: AutomaticSpeechRecognitionOutput = Array.isArray(rawResult)
			? rawResult[0]
			: rawResult;

		if (wordTimestamps) {
			// In word mode the chunks ARE words; rebuild phrase segments from them
			// so segment consumers are unaffected, and ship the words for the
			// Director's duplicate-word detector.
			const words: TranscriptionWord[] = [];
			if (result.chunks) {
				for (const chunk of result.chunks) {
					if (chunk.timestamp && chunk.timestamp.length >= 2) {
						words.push({
							text: chunk.text,
							start: chunk.timestamp[0] ?? 0,
							end: chunk.timestamp[1] ?? chunk.timestamp[0] ?? 0,
						});
					}
				}
			}
			self.postMessage({
				type: "transcribe-complete",
				text: result.text,
				segments: segmentsFromWords(words),
				words,
			} satisfies WorkerResponse);
			return;
		}

		const segments: TranscriptionSegment[] = [];

		if (result.chunks) {
			for (const chunk of result.chunks) {
				if (chunk.timestamp && chunk.timestamp.length >= 2) {
					segments.push({
						text: chunk.text,
						start: chunk.timestamp[0] ?? 0,
						end: chunk.timestamp[1] ?? chunk.timestamp[0] ?? 0,
					});
				}
			}
		}

		self.postMessage({
			type: "transcribe-complete",
			text: result.text,
			segments,
		} satisfies WorkerResponse);
	} catch (error) {
		if (cancelled) return;
		self.postMessage({
			type: "transcribe-error",
			error: error instanceof Error ? error.message : "Transcription failed",
		} satisfies WorkerResponse);
	}
}
