import type {
	TranscriptionLanguage,
	TranscriptionResult,
	TranscriptionProgress,
	TranscriptionModelId,
} from "@/transcription/types";
import {
	DEFAULT_TRANSCRIPTION_MODEL,
	TRANSCRIPTION_MODELS,
} from "@/transcription/models";
import type { WorkerMessage, WorkerResponse } from "./worker";

type ProgressCallback = (progress: TranscriptionProgress) => void;

class TranscriptionService {
	private worker: Worker | null = null;
	private currentModelId: TranscriptionModelId | null = null;
	private isInitialized = false;
	private isInitializing = false;

	async transcribe({
		audioData,
		language = "auto",
		modelId = DEFAULT_TRANSCRIPTION_MODEL,
		wordTimestamps = false,
		onProgress,
	}: {
		audioData: Float32Array;
		language?: TranscriptionLanguage;
		modelId?: TranscriptionModelId;
		/** Request per-word timestamps (slower; segments are rebuilt from words). */
		wordTimestamps?: boolean;
		onProgress?: ProgressCallback;
	}): Promise<TranscriptionResult> {
		await this.ensureWorker({ modelId, onProgress });

		return new Promise((resolve, reject) => {
			if (!this.worker) {
				reject(new Error("Worker not initialized"));
				return;
			}

			const cleanup = () => {
				this.worker?.removeEventListener("message", handleMessage);
				this.worker?.removeEventListener("error", handleWorkerFailure);
				this.worker?.removeEventListener("messageerror", handleWorkerFailure);
			};

			const handleMessage = (event: MessageEvent<WorkerResponse>) => {
				const response = event.data;

				switch (response.type) {
					case "transcribe-progress":
						onProgress?.({
							status: "transcribing",
							progress: response.progress,
							message: "Transcribing audio...",
						});
						break;

					case "transcribe-complete":
						cleanup();
						resolve({
							text: response.text,
							segments: response.segments,
							words: response.words,
							wordsUnavailable: response.wordsUnavailable,
							language,
						});
						break;

					case "transcribe-error":
						cleanup();
						reject(new Error(response.error));
						break;

					case "cancelled":
						cleanup();
						reject(new Error("Transcription cancelled"));
						break;
				}
			};

			// A WORKER-LEVEL crash (an uncaught throw, an out-of-memory kill, a
			// bad postMessage payload) fires 'error'/'messageerror' on the Worker
			// object, never a posted "transcribe-error" message - so with only a
			// message listener the promise hung forever and a Director run spun
			// with a live-looking elapsed ticker (round 12 U3/R4). Mirror
			// services/vad/service.ts: reject with a plain message and terminate
			// so a broken worker is not reused on the next run.
			const handleWorkerFailure = () => {
				cleanup();
				this.terminate();
				reject(new Error("Transcription stopped working. Try running it again."));
			};

			this.worker.addEventListener("message", handleMessage);
			this.worker.addEventListener("error", handleWorkerFailure);
			this.worker.addEventListener("messageerror", handleWorkerFailure);

			this.worker.postMessage({
				type: "transcribe",
				audio: audioData,
				language,
				wordTimestamps,
			} satisfies WorkerMessage);
		});
	}

	cancel() {
		this.worker?.postMessage({ type: "cancel" } satisfies WorkerMessage);
	}

	private async ensureWorker({
		modelId,
		onProgress,
	}: {
		modelId: TranscriptionModelId;
		onProgress?: ProgressCallback;
	}): Promise<void> {
		const needsNewModel = this.currentModelId !== modelId;

		if (this.worker && this.isInitialized && !needsNewModel) {
			return;
		}

		if (this.isInitializing && !needsNewModel) {
			await this.waitForInit();
			return;
		}

		this.terminate();
		this.isInitializing = true;
		this.isInitialized = false;

		const model = TRANSCRIPTION_MODELS.find((m) => m.id === modelId);
		if (!model) {
			throw new Error(`Unknown model: ${modelId}`);
		}

		this.worker = new Worker(new URL("./worker.ts", import.meta.url), {
			type: "module",
		});

		return new Promise((resolve, reject) => {
			if (!this.worker) {
				reject(new Error("Failed to create worker"));
				return;
			}

			const cleanup = () => {
				this.worker?.removeEventListener("message", handleMessage);
				this.worker?.removeEventListener("error", handleWorkerFailure);
				this.worker?.removeEventListener("messageerror", handleWorkerFailure);
			};

			const handleMessage = (event: MessageEvent<WorkerResponse>) => {
				const response = event.data;

				switch (response.type) {
					case "init-progress":
						onProgress?.({
							status: "loading-model",
							progress: response.progress,
							message: `Loading ${model.name} model...`,
						});
						break;

					case "init-complete":
						cleanup();
						this.isInitialized = true;
						this.isInitializing = false;
						this.currentModelId = modelId;
						resolve();
						break;

					case "init-error":
						cleanup();
						this.isInitializing = false;
						this.terminate();
						reject(new Error(response.error));
						break;
				}
			};

			// Same worker-level guard as transcribe() above (round 12 U3/R4): a
			// crash while the model loads (the likeliest hang: a huge download in
			// a dying tab) must reject instead of leaving init pending forever.
			const handleWorkerFailure = () => {
				cleanup();
				this.isInitializing = false;
				this.terminate();
				reject(
					new Error("The transcription engine failed to load. Try running it again."),
				);
			};

			this.worker.addEventListener("message", handleMessage);
			this.worker.addEventListener("error", handleWorkerFailure);
			this.worker.addEventListener("messageerror", handleWorkerFailure);

			this.worker.postMessage({
				type: "init",
				modelId: model.huggingFaceId,
			} satisfies WorkerMessage);
		});
	}

	private waitForInit(): Promise<void> {
		return new Promise((resolve) => {
			const checkInit = () => {
				if (this.isInitialized) {
					resolve();
				} else if (!this.isInitializing) {
					resolve();
				} else {
					setTimeout(checkInit, 100);
				}
			};
			checkInit();
		});
	}

	terminate() {
		this.worker?.terminate();
		this.worker = null;
		this.isInitialized = false;
		this.isInitializing = false;
		this.currentModelId = null;
	}
}

export const transcriptionService = new TranscriptionService();
