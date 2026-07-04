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
});
