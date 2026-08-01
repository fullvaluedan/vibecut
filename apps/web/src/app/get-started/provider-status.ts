/**
 * T21.1: pure key-state derivation for the /get-started "Connect your AI"
 * provider cards, and reused by the home page's "Set up AI" warning dot.
 *
 * Four possible states, not every provider produces every one:
 *  - "device-key": a key is saved in this browser's local storage (BYO).
 *  - "server-key": Groq only - the deployment has a GROQ_API_KEY configured,
 *    so cloud transcription works without a pasted key (see
 *    `probeServerGroqKey` in features/ai-generate/store.ts).
 *  - "claude-code": Anthropic only - `authMode: "claude-code"` uses the
 *    local Claude Code subscription, no key needed at all. There is no
 *    server-side probe for a deployment-wide Anthropic key (the task rule
 *    for T21.1 is to reuse existing plumbing only, never add new server
 *    plumbing), so Anthropic's derivation never returns "server-key".
 *  - "missing": nothing usable is configured; the card shows plain-language
 *    "where to get a key" guidance.
 *
 * Both derivations are pure functions over plain data (no store reads), so
 * the caller decides how fresh the inputs need to be (a store selector, a
 * cached probe, whatever).
 */

import type { AiAuthMode } from "@/features/ai-generate/store";

export type ProviderId = "anthropic" | "groq";
export type ProviderKeyState = "device-key" | "server-key" | "claude-code" | "missing";

export interface ProviderStatus {
	provider: ProviderId;
	state: ProviderKeyState;
}

/** Anthropic (LLM: powers AI Cut's Director today, the Assistant next). */
export function deriveAnthropicStatus({
	authMode,
	anthropicApiKey,
}: {
	authMode: AiAuthMode;
	anthropicApiKey: string;
}): ProviderStatus {
	if (authMode === "claude-code") {
		return { provider: "anthropic", state: "claude-code" };
	}
	if (authMode === "api-key" && anthropicApiKey.trim().length > 0) {
		return { provider: "anthropic", state: "device-key" };
	}
	return { provider: "anthropic", state: "missing" };
}

/**
 * Groq (transcription). Local (in-browser) Whisper always works as a
 * fallback regardless of this state - callers should phrase "missing" as
 * optional-but-recommended, not an error. See ai-settings.tsx's
 * `useServerGroqKeyDetected` for how `serverKeyDetected` is normally probed.
 */
export function deriveGroqStatus({
	groqApiKey,
	serverKeyDetected,
}: {
	groqApiKey: string;
	serverKeyDetected: boolean;
}): ProviderStatus {
	if (groqApiKey.trim().length > 0) {
		return { provider: "groq", state: "device-key" };
	}
	if (serverKeyDetected) {
		return { provider: "groq", state: "server-key" };
	}
	return { provider: "groq", state: "missing" };
}

/** True when no transcription-capable cloud path exists (Groq is "missing"). */
export function needsAiSetupWarning({
	groqApiKey,
	serverKeyDetected,
}: {
	groqApiKey: string;
	serverKeyDetected: boolean;
}): boolean {
	return deriveGroqStatus({ groqApiKey, serverKeyDetected }).state === "missing";
}
