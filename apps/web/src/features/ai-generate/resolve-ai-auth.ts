import type { ClaudeAuth } from "@framecut/hf-bridge";

/**
 * Resolve the device-local AI connection from a request's headers (the ones set
 * by buildAiAuthHeaders on the client). One source of truth shared by every AI
 * route — author, plan, cuts, assistant — so adding a mode happens in one place.
 *
 * Returns null when the selected mode is missing its required config (e.g.
 * "api-key" with no key, "custom" with no base URL/model); the caller turns
 * that into a 401 pointing at Settings → AI.
 *
 * T21.2: the named OpenAI-compatible providers (openai / xai-grok / groq-llm)
 * resolve from their own key headers; the model header is optional (hf-bridge
 * applies the provider's default model when it is absent). The pre-existing
 * modes' header contract is byte-stable - the eval disk cache keys on it.
 */
export function resolveAiAuth(req: Request): ClaudeAuth | null {
	const mode = req.headers.get("x-framecut-auth-mode");
	if (mode === "api-key") {
		const apiKey = req.headers.get("x-framecut-anthropic-key");
		if (!apiKey) return null;
		return { mode: "api-key", apiKey };
	}
	if (mode === "custom") {
		const baseUrl = req.headers.get("x-framecut-custom-base-url");
		const model = req.headers.get("x-framecut-custom-model");
		if (!baseUrl || !model) return null;
		const apiKey = req.headers.get("x-framecut-custom-key") ?? undefined;
		return { mode: "custom", baseUrl, model, apiKey };
	}
	if (mode === "openai" || mode === "xai-grok" || mode === "groq-llm") {
		const apiKey = req.headers.get(`x-framecut-${mode}-key`);
		if (!apiKey) return null;
		const model = req.headers.get(`x-framecut-${mode}-model`) ?? undefined;
		return { mode, apiKey, model };
	}
	return { mode: "claude-code" };
}
