import type { ClaudeAuth } from "@framecut/hf-bridge";

/**
 * Resolve the device-local AI connection from a request's headers (the ones set
 * by buildAiAuthHeaders on the client). One source of truth shared by every AI
 * route — author, plan, cuts, assistant — so adding a mode happens in one place.
 *
 * Returns null when the selected mode is missing its required config (e.g.
 * "api-key" with no key, "custom" with no base URL/model) or when the mode
 * string is unknown (an old server process that predates a newer client's
 * mode — previously this silently degraded to claude-code, which produced
 * baffling "claude CLI not signed in" errors for Codex users; a 401 pointing
 * at Settings → AI / a server restart is the honest answer). The caller turns
 * null into a 401.
 */
export function resolveAiAuth(req: Request): ClaudeAuth | null {
	const mode = req.headers.get("x-framecut-auth-mode");
	if (mode === "api-key") {
		const apiKey = req.headers.get("x-framecut-anthropic-key");
		if (!apiKey) return null;
		return { mode: "api-key", apiKey };
	}
	if (mode === "codex") {
		// ChatGPT login: credentials live in the Codex CLI's own auth store on
		// the server machine; nothing is transported per-request. An optional
		// model override rides along.
		const model = req.headers.get("x-framecut-codex-model") ?? undefined;
		return { mode: "codex", ...(model ? { model } : {}) };
	}
	if (mode === "custom") {
		const baseUrl = req.headers.get("x-framecut-custom-base-url");
		const model = req.headers.get("x-framecut-custom-model");
		if (!baseUrl || !model) return null;
		const apiKey = req.headers.get("x-framecut-custom-key") ?? undefined;
		return { mode: "custom", baseUrl, model, apiKey };
	}
	if (mode === "claude-code") {
		return { mode: "claude-code" };
	}
	return null;
}
