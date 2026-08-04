import { beforeEach, describe, expect, test } from "bun:test";
import { resolveAiAuth } from "../resolve-ai-auth";

// Silence the benign zustand-persist "storage unavailable" line under Bun.
const isZustandPersistNoise = (args: unknown[]): boolean =>
	typeof args[0] === "string" &&
	args[0].includes("[zustand persist middleware]");
for (const method of ["error", "warn", "log"] as const) {
	const original = console[method];
	console[method] = (...args: unknown[]) => {
		if (isZustandPersistNoise(args)) return;
		original(...args);
	};
}

const { useAiSettingsStore, buildAiAuthHeaders } = await import("../store");

beforeEach(() => {
	useAiSettingsStore.setState({
		authMode: "claude-code",
		anthropicApiKey: "",
		customBaseUrl: "",
		customApiKey: "",
		customModel: "",
		openaiApiKey: "",
		openaiModel: "",
		xaiGrokApiKey: "",
		xaiGrokModel: "",
		groqLlmApiKey: "",
		groqLlmModel: "",
		directorProvider: "default",
		assistantProvider: "default",
		hyperframesProvider: "default",
	});
});

const req = (headers: Record<string, string>): Request =>
	new Request("http://localhost/api/x", { headers });

describe("buildAiAuthHeaders — client → server contract", () => {
	test("claude-code: just the mode, no key headers", () => {
		const h = buildAiAuthHeaders();
		expect(h["x-framecut-auth-mode"]).toBe("claude-code");
		expect(h["x-framecut-anthropic-key"]).toBeUndefined();
		expect(h["x-framecut-custom-base-url"]).toBeUndefined();
	});

	test("api-key: sends the anthropic key when present", () => {
		useAiSettingsStore.setState({ authMode: "api-key", anthropicApiKey: "sk-ant-xyz" });
		const h = buildAiAuthHeaders();
		expect(h["x-framecut-auth-mode"]).toBe("api-key");
		expect(h["x-framecut-anthropic-key"]).toBe("sk-ant-xyz");
	});

	test("api-key: omits the key header when blank", () => {
		useAiSettingsStore.setState({ authMode: "api-key", anthropicApiKey: "" });
		expect(buildAiAuthHeaders()["x-framecut-anthropic-key"]).toBeUndefined();
	});

	test("custom: sends base-url + model + optional key", () => {
		useAiSettingsStore.setState({
			authMode: "custom",
			customBaseUrl: "http://localhost:11434/v1",
			customModel: "hermes-3",
			customApiKey: "local-key",
		});
		const h = buildAiAuthHeaders();
		expect(h["x-framecut-auth-mode"]).toBe("custom");
		expect(h["x-framecut-custom-base-url"]).toBe("http://localhost:11434/v1");
		expect(h["x-framecut-custom-model"]).toBe("hermes-3");
		expect(h["x-framecut-custom-key"]).toBe("local-key");
	});

	test("custom: omits the key header when blank (local servers)", () => {
		useAiSettingsStore.setState({
			authMode: "custom",
			customBaseUrl: "http://localhost:1234/v1",
			customModel: "qwen",
			customApiKey: "",
		});
		const h = buildAiAuthHeaders();
		expect(h["x-framecut-custom-base-url"]).toBe("http://localhost:1234/v1");
		expect(h["x-framecut-custom-key"]).toBeUndefined();
	});

	test("named providers: key + optional model headers (T21.2)", () => {
		useAiSettingsStore.setState({ authMode: "openai", openaiApiKey: "sk-o" });
		let h = buildAiAuthHeaders();
		expect(h["x-framecut-auth-mode"]).toBe("openai");
		expect(h["x-framecut-openai-key"]).toBe("sk-o");
		expect(h["x-framecut-openai-model"]).toBeUndefined();

		useAiSettingsStore.setState({
			authMode: "xai-grok",
			xaiGrokApiKey: "xai-k",
			xaiGrokModel: "grok-mini",
		});
		h = buildAiAuthHeaders();
		expect(h["x-framecut-xai-grok-key"]).toBe("xai-k");
		expect(h["x-framecut-xai-grok-model"]).toBe("grok-mini");

		useAiSettingsStore.setState({
			authMode: "groq-llm",
			groqLlmApiKey: "gsk",
		});
		h = buildAiAuthHeaders();
		expect(h["x-framecut-groq-llm-key"]).toBe("gsk");
		// A named provider never leaks another mode's headers.
		expect(h["x-framecut-anthropic-key"]).toBeUndefined();
		expect(h["x-framecut-custom-base-url"]).toBeUndefined();
	});
});

describe("buildAiAuthHeaders - per-feature provider picks (T21.2)", () => {
	test("a pinned feature uses its own provider; unpinned features follow the global mode", () => {
		useAiSettingsStore.setState({
			authMode: "claude-code",
			assistantProvider: "openai",
			openaiApiKey: "sk-o",
		});
		expect(buildAiAuthHeaders("assistant")["x-framecut-auth-mode"]).toBe(
			"openai",
		);
		expect(buildAiAuthHeaders("assistant")["x-framecut-openai-key"]).toBe(
			"sk-o",
		);
		// Director and HyperFrames stay on the global connection.
		expect(buildAiAuthHeaders("director")["x-framecut-auth-mode"]).toBe(
			"claude-code",
		);
		expect(buildAiAuthHeaders("hyperframes")["x-framecut-auth-mode"]).toBe(
			"claude-code",
		);
		// No feature argument = the global mode (pre-T21.2 behavior).
		expect(buildAiAuthHeaders()["x-framecut-auth-mode"]).toBe("claude-code");
	});

	test('"default" picks resolve to the global mode byte-identically', () => {
		useAiSettingsStore.setState({
			authMode: "api-key",
			anthropicApiKey: "sk-ant-1",
			directorProvider: "default",
		});
		expect(buildAiAuthHeaders("director")).toEqual(buildAiAuthHeaders());
	});

	test("a pinned claude-code feature emits just the mode", () => {
		useAiSettingsStore.setState({
			authMode: "openai",
			openaiApiKey: "sk-o",
			hyperframesProvider: "claude-code",
		});
		const h = buildAiAuthHeaders("hyperframes");
		expect(h).toEqual({ "x-framecut-auth-mode": "claude-code" });
	});
});

describe("resolveAiAuth — server header → auth", () => {
	test("no mode / unknown mode falls back to claude-code", () => {
		expect(resolveAiAuth(req({}))).toEqual({ mode: "claude-code" });
		expect(resolveAiAuth(req({ "x-framecut-auth-mode": "claude-code" }))).toEqual({
			mode: "claude-code",
		});
	});

	test("api-key requires the key", () => {
		expect(
			resolveAiAuth(req({ "x-framecut-auth-mode": "api-key" })),
		).toBeNull();
		expect(
			resolveAiAuth(
				req({
					"x-framecut-auth-mode": "api-key",
					"x-framecut-anthropic-key": "sk-ant-1",
				}),
			),
		).toEqual({ mode: "api-key", apiKey: "sk-ant-1" });
	});

	test("custom requires base-url AND model", () => {
		expect(
			resolveAiAuth(
				req({
					"x-framecut-auth-mode": "custom",
					"x-framecut-custom-base-url": "http://localhost:11434/v1",
				}),
			),
		).toBeNull(); // missing model
		expect(
			resolveAiAuth(
				req({
					"x-framecut-auth-mode": "custom",
					"x-framecut-custom-model": "hermes-3",
				}),
			),
		).toBeNull(); // missing base url
	});

	test("custom resolves with base-url + model, key optional", () => {
		expect(
			resolveAiAuth(
				req({
					"x-framecut-auth-mode": "custom",
					"x-framecut-custom-base-url": "http://localhost:11434/v1",
					"x-framecut-custom-model": "hermes-3",
				}),
			),
		).toEqual({
			mode: "custom",
			baseUrl: "http://localhost:11434/v1",
			model: "hermes-3",
			apiKey: undefined,
		});
		expect(
			resolveAiAuth(
				req({
					"x-framecut-auth-mode": "custom",
					"x-framecut-custom-base-url": "http://localhost:11434/v1",
					"x-framecut-custom-model": "hermes-3",
					"x-framecut-custom-key": "k",
				}),
			),
		).toMatchObject({ mode: "custom", apiKey: "k" });
	});

	test("named providers require their key; the model is optional (T21.2)", () => {
		for (const mode of ["openai", "xai-grok", "groq-llm"] as const) {
			expect(
				resolveAiAuth(req({ "x-framecut-auth-mode": mode })),
			).toBeNull();
			expect(
				resolveAiAuth(
					req({
						"x-framecut-auth-mode": mode,
						[`x-framecut-${mode}-key`]: "k",
					}),
				),
			).toEqual({ mode, apiKey: "k", model: undefined });
			expect(
				resolveAiAuth(
					req({
						"x-framecut-auth-mode": mode,
						[`x-framecut-${mode}-key`]: "k",
						[`x-framecut-${mode}-model`]: "m1",
					}),
				),
			).toEqual({ mode, apiKey: "k", model: "m1" });
		}
	});

	test("header round-trip: buildAiAuthHeaders -> resolveAiAuth for every mode", () => {
		useAiSettingsStore.setState({
			anthropicApiKey: "sk-ant-1",
			customBaseUrl: "http://localhost:11434/v1",
			customModel: "hermes-3",
			openaiApiKey: "sk-o",
			openaiModel: "gpt-x",
			xaiGrokApiKey: "xai-k",
			groqLlmApiKey: "gsk",
		});
		const modes = [
			"claude-code",
			"api-key",
			"custom",
			"openai",
			"xai-grok",
			"groq-llm",
		] as const;
		for (const mode of modes) {
			useAiSettingsStore.setState({ authMode: mode });
			const auth = resolveAiAuth(req(buildAiAuthHeaders()));
			expect(auth?.mode).toBe(mode);
		}
		// Spot-check the full resolved shapes for the new providers.
		useAiSettingsStore.setState({ authMode: "openai" });
		expect(resolveAiAuth(req(buildAiAuthHeaders()))).toEqual({
			mode: "openai",
			apiKey: "sk-o",
			model: "gpt-x",
		});
		useAiSettingsStore.setState({ authMode: "groq-llm" });
		expect(resolveAiAuth(req(buildAiAuthHeaders()))).toEqual({
			mode: "groq-llm",
			apiKey: "gsk",
			model: undefined,
		});
	});
});
