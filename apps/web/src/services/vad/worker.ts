/**
 * VAD Web Worker (Plan A / U3) — runs Silero VAD (`@ricky0123/vad-web`, onnxruntime-
 * web) over decoded 16kHz mono audio OFF the main thread, then post-processes the
 * raw speech intervals through the tested `refineSpeechIntervals` into {speech,
 * gaps}. Browser-only → LIVE-VERIFIED, never under bun. The library loads its WASM
 * + Silero model from its default CDN, so no local asset serving is required.
 */
import { NonRealTimeVAD } from "@ricky0123/vad-web";
import { OFFLINE_VAD_OPTIONS, refineSpeechIntervals, type Interval } from "./intervals";

export type VadWorkerMessage = {
	type: "detect";
	samples: Float32Array;
	sampleRate: number;
	totalSec: number;
};

export type VadWorkerResponse =
	| { type: "vad-complete"; speech: Interval[]; gaps: Interval[] }
	| { type: "vad-error"; error: string };

self.onmessage = async (event: MessageEvent<VadWorkerMessage>) => {
	const message = event.data;
	if (message.type !== "detect") return;
	try {
		// Offline-tuned (U6): raised minSpeechMs + explicit redemptionMs so this
		// finds cut-worthy silences over a whole recording, not mic-stream speech.
		const vad = await NonRealTimeVAD.new(OFFLINE_VAD_OPTIONS);
		const raw: Interval[] = [];
		// run() yields speech segments with start/end in MILLISECONDS.
		for await (const segment of vad.run(message.samples, message.sampleRate)) {
			raw.push({ startSec: segment.start / 1000, endSec: segment.end / 1000 });
		}
		const { speech, gaps } = refineSpeechIntervals({ raw, totalSec: message.totalSec });
		self.postMessage({ type: "vad-complete", speech, gaps } satisfies VadWorkerResponse);
	} catch (error) {
		self.postMessage({
			type: "vad-error",
			error: error instanceof Error ? error.message : String(error),
		} satisfies VadWorkerResponse);
	}
};
