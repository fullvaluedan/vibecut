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

/** A wedged VAD worker (CDN WASM never loads, onnxruntime aborts the thread)
 * must not hang the caller forever — bound every run. */
const VAD_TIMEOUT_MS = 60_000;

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
			let settled = false;
			const cleanup = () => {
				clearTimeout(timer);
				worker.removeEventListener("message", onMessage);
				worker.removeEventListener("error", onError);
				worker.removeEventListener("messageerror", onError);
			};
			// A WORKER-LEVEL failure (module-load throw, WASM init abort, timeout)
			// surfaces as 'error'/'messageerror' or never settles — NOT a posted
			// vad-error. Handle those too, else the promise hangs and the caller's
			// try/catch (which only catches a rejection) can't degrade. Terminate so
			// a half-initialized worker isn't reused next run (mirrors transcription).
			const fail = (message: string) => {
				if (settled) return;
				settled = true;
				cleanup();
				this.terminate();
				reject(new Error(message));
			};
			const onMessage = (event: MessageEvent<VadWorkerResponse>) => {
				const response = event.data;
				if (response.type === "vad-complete") {
					if (settled) return;
					settled = true;
					cleanup();
					resolve({ speech: response.speech, gaps: response.gaps });
				} else if (response.type === "vad-error") {
					fail(response.error);
				}
			};
			const onError = () => fail("VAD worker failed");
			const timer = setTimeout(() => fail("VAD timed out"), VAD_TIMEOUT_MS);
			worker.addEventListener("message", onMessage);
			worker.addEventListener("error", onError);
			worker.addEventListener("messageerror", onError);
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
