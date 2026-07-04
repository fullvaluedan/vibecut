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
	DEFAULT_TRANSCRIPTION_SAMPLE_RATE,
} from "@/transcription/audio";
import { leadingWindow, WORD_PROBE_WINDOW_SECONDS } from "@/transcription/probe";

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
			/**
			 * True when word timestamps were requested but this model's ONNX
			 * export can't produce them (no cross-attention) — we degraded to
			 * segment-level so the run still completes.
			 */
			wordsUnavailable?: boolean;
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
/**
 * Set once the loaded model is proven unable to emit word-level timestamps
 * (its ONNX decoder lacks the cross-attention outputs DTW needs). We then skip
 * the doomed word-mode decode on every later run this session and go straight
 * to segment-level. Reset on init because a different model may support it.
 */
let wordTimestampsUnsupported = false;
const fileBytes = new Map<string, { loaded: number; total: number }>();

/** The cross-attention export some Whisper ONNX builds lack (word DTW needs it). */
function isWordTimestampUnsupported(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /cross att|output_attentions/i.test(message);
}

/** Probe length in samples (window seconds × the fixed transcription rate). */
const WORD_PROBE_WINDOW_SAMPLES = Math.round(
	WORD_PROBE_WINDOW_SECONDS * DEFAULT_TRANSCRIPTION_SAMPLE_RATE,
);

function warnWordTimestampsDegraded(): void {
	console.warn(
		"[transcription] This model can't produce word-level timestamps; " +
			"falling back to segment-level. Word-based Director detectors " +
			"(duplicate words, filler, dead-air) will be skipped.",
	);
}

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
	wordTimestampsUnsupported = false;
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

/** One decode pass at the requested timestamp granularity. */
async function decode({
	audio,
	language,
	mode,
}: {
	audio: Float32Array;
	language: string;
	mode: "word" | "segment";
}): Promise<AutomaticSpeechRecognitionOutput> {
	if (!transcriber) throw new Error("Model not initialized");
	const rawResult = await transcriber(audio, {
		chunk_length_s: DEFAULT_CHUNK_LENGTH_SECONDS,
		stride_length_s: DEFAULT_STRIDE_SECONDS,
		language: language === "auto" ? undefined : language,
		return_timestamps: mode === "word" ? "word" : true,
	});
	return Array.isArray(rawResult) ? rawResult[0] : rawResult;
}

/**
 * In word mode the chunks ARE words; ship them (with chunk-boundary ends
 * repaired) for the Director's duplicate-word detector.
 */
function wordsFromResult(
	result: AutomaticSpeechRecognitionOutput,
): TranscriptionWord[] {
	const words: TranscriptionWord[] = [];
	const chunks = result.chunks ?? [];
	for (let i = 0; i < chunks.length; i++) {
		const chunk = chunks[i];
		if (!chunk.timestamp || chunk.timestamp.length < 2) continue;
		const start = chunk.timestamp[0] ?? 0;
		const rawEnd = chunk.timestamp[1];
		let end = start;
		if (Number.isFinite(rawEnd)) {
			end = rawEnd;
		} else {
			// At each 30s chunk boundary transformers.js emits a word with a
			// null end. Don't collapse it to start (a zero-length point the
			// duplicate detector would drop and which breaks gap math) —
			// infer the end from the next word's start.
			const nextStart = chunks[i + 1]?.timestamp?.[0];
			end = nextStart != null && nextStart > start ? nextStart : start + 0.1;
		}
		words.push({ text: chunk.text, start, end });
	}
	return words;
}

/** Phrase-level segments straight from a segment-mode decode. */
function segmentsFromResult(
	result: AutomaticSpeechRecognitionOutput,
): TranscriptionSegment[] {
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
	return segments;
}

/**
 * Learn whether the loaded model can emit word timestamps WITHOUT paying for a
 * full word-mode pass: decode a short leading slice in word mode. If it throws
 * the cross-attention error, memoize that and the caller goes straight to
 * segment-level for the full audio (no doubled transcription on long sources).
 * Any other probe outcome is inconclusive — the caller's full pass stays
 * authoritative, so the probe can never make a run WORSE than no probe.
 */
async function probeWordCapability({
	audio,
	language,
}: {
	audio: Float32Array;
	language: string;
}): Promise<void> {
	const probe = leadingWindow({
		samples: audio,
		windowSamples: WORD_PROBE_WINDOW_SAMPLES,
	});
	// Nothing saved if the whole clip is already <= the probe window.
	if (probe.length >= audio.length) return;
	try {
		await decode({ audio: probe, language, mode: "word" });
		// Succeeded (model is word-capable) or produced nothing (silent opening,
		// inconclusive) — either way let the full word pass decide.
	} catch (error) {
		if (isWordTimestampUnsupported(error)) {
			wordTimestampsUnsupported = true;
			warnWordTimestampsDegraded();
		}
		// A non-capability probe error is inconclusive; swallow it and let the
		// full pass surface any real failure.
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

	// Flip the UI off "Initializing speech model" the moment real decoding starts
	// (the model is already loaded by now). Without this the elapsed-ticker in
	// transcript-cache never learns transcription began and mislabels the whole
	// (multi-minute, on long video) decode as initialization.
	self.postMessage({
		type: "transcribe-progress",
		progress: 0,
	} satisfies WorkerResponse);

	try {
		// Word mode: probe a short slice first so a model that can't emit word
		// timestamps (the "Model outputs must contain cross attentions" /
		// output_attentions error) is caught from a ~20s decode rather than a full
		// word pass that throws — no doubled transcription on long sources. The
		// word-level detectors then simply yield nothing while AI Director still
		// runs. `wordTimestampsUnsupported` memoizes it across runs this session.
		if (wordTimestamps && !wordTimestampsUnsupported) {
			await probeWordCapability({ audio, language });
			if (cancelled) return;
		}

		if (wordTimestamps && !wordTimestampsUnsupported) {
			try {
				const result = await decode({ audio, language, mode: "word" });
				if (cancelled) return;
				const words = wordsFromResult(result);
				self.postMessage({
					type: "transcribe-complete",
					text: result.text,
					segments: segmentsFromWords(words),
					words,
				} satisfies WorkerResponse);
				return;
			} catch (error) {
				if (cancelled) return;
				if (!isWordTimestampUnsupported(error)) throw error;
				wordTimestampsUnsupported = true;
				warnWordTimestampsDegraded();
			}
		}

		const result = await decode({ audio, language, mode: "segment" });
		if (cancelled) return;
		self.postMessage({
			type: "transcribe-complete",
			text: result.text,
			segments: segmentsFromResult(result),
			// Words were asked for but this model can't give them — tell the cache
			// so it stops re-transcribing on every word-level request.
			wordsUnavailable: wordTimestamps,
		} satisfies WorkerResponse);
	} catch (error) {
		if (cancelled) return;
		self.postMessage({
			type: "transcribe-error",
			error: error instanceof Error ? error.message : "Transcription failed",
		} satisfies WorkerResponse);
	}
}
