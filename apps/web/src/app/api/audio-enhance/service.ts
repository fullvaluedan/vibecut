import { Agent, fetch as undiciFetch } from "undici";

/** Shared plumbing for the ClearVoice job proxy routes. */
export const CLEARVOICE_SERVICE_URL =
	process.env.CLEARVOICE_SERVICE_URL ?? "http://127.0.0.1:8760";

// ClearVoice itself has no upload cap; this guard only protects the dev
// machine's memory. 256 MB of 16 kHz mono WAV is roughly 2h13m of audio,
// comfortably covering a 2-hour project. Override with CLEARVOICE_MAX_AUDIO_BYTES.
export const MAX_AUDIO_BYTES = (() => {
	const raw = Number(process.env.CLEARVOICE_MAX_AUDIO_BYTES);
	const fallback = 256 * 1024 * 1024;
	if (!Number.isFinite(raw) || raw <= 0) return fallback;
	return Math.min(Math.max(raw, 1024 * 1024), 1024 * 1024 * 1024);
})();

export const MAX_AUDIO_MB = Math.round(MAX_AUDIO_BYTES / (1024 * 1024));

// Long footage on CPU takes hours; undici's default 5-minute
// response-header timeout would abort the fetch mid-job. Give the upstream a
// long window and let the client's AbortSignal remain the only real cancel.
export const LONG_JOB_DISPATCHER = new Agent({
	headersTimeout: 8 * 3600 * 1000,
	bodyTimeout: 8 * 3600 * 1000,
	connectTimeout: 10_000,
});

export { undiciFetch };
