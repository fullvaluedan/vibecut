/**
 * VAD service (Plan A / U3) — a thin singleton that runs the Silero VAD worker and
 * resolves {speech, gaps}. Mirrors `services/transcription/service.ts`. The worker
 * is lazily spawned; one call per Director run.
 */
import type { Interval } from "./intervals";
import type { VadWorkerMessage, VadWorkerResponse } from "./worker";

export interface SpeechGaps {
	speech: Interval[];
	gaps: Interval[];
}

class VadService {
	private worker: Worker | null = null;

	/** Decoded 16kHz mono audio → speech intervals + their non-speech gaps. */
	detectSpeechGaps({
		samples,
		sampleRate,
		totalSec,
	}: {
		samples: Float32Array;
		sampleRate: number;
		totalSec: number;
	}): Promise<SpeechGaps> {
		const worker = this.ensureWorker();
		return new Promise((resolve, reject) => {
			const handle = (event: MessageEvent<VadWorkerResponse>) => {
				const response = event.data;
				if (response.type === "vad-complete") {
					worker.removeEventListener("message", handle);
					resolve({ speech: response.speech, gaps: response.gaps });
				} else if (response.type === "vad-error") {
					worker.removeEventListener("message", handle);
					reject(new Error(response.error));
				}
			};
			worker.addEventListener("message", handle);
			worker.postMessage({
				type: "detect",
				samples,
				sampleRate,
				totalSec,
			} satisfies VadWorkerMessage);
		});
	}

	private ensureWorker(): Worker {
		if (!this.worker) {
			this.worker = new Worker(new URL("./worker.ts", import.meta.url), {
				type: "module",
			});
		}
		return this.worker;
	}

	terminate() {
		this.worker?.terminate();
		this.worker = null;
	}
}

export const vadService = new VadService();
