import { describe, expect, test } from "bun:test";
import {
	deriveAnthropicStatus,
	deriveGroqStatus,
	needsAiSetupWarning,
} from "../provider-status";

describe("deriveAnthropicStatus", () => {
	test("claude-code auth mode is connected, no key needed", () => {
		expect(
			deriveAnthropicStatus({ authMode: "claude-code", anthropicApiKey: "" }),
		).toEqual({ provider: "anthropic", state: "claude-code" });
	});

	test("api-key mode with a saved key is a device key", () => {
		expect(
			deriveAnthropicStatus({
				authMode: "api-key",
				anthropicApiKey: "sk-ant-abc123",
			}),
		).toEqual({ provider: "anthropic", state: "device-key" });
	});

	test("api-key mode with an empty key is missing", () => {
		expect(
			deriveAnthropicStatus({ authMode: "api-key", anthropicApiKey: "" }),
		).toEqual({ provider: "anthropic", state: "missing" });
	});

	test("api-key mode with a whitespace-only key is missing", () => {
		expect(
			deriveAnthropicStatus({ authMode: "api-key", anthropicApiKey: "   " }),
		).toEqual({ provider: "anthropic", state: "missing" });
	});

	test("custom auth mode is missing (not using Anthropic at all)", () => {
		expect(
			deriveAnthropicStatus({ authMode: "custom", anthropicApiKey: "" }),
		).toEqual({ provider: "anthropic", state: "missing" });
	});

	test("never returns server-key (no server probe exists for Anthropic)", () => {
		const states = [
			deriveAnthropicStatus({ authMode: "claude-code", anthropicApiKey: "" }),
			deriveAnthropicStatus({ authMode: "api-key", anthropicApiKey: "x" }),
			deriveAnthropicStatus({ authMode: "api-key", anthropicApiKey: "" }),
			deriveAnthropicStatus({ authMode: "custom", anthropicApiKey: "" }),
		];
		for (const status of states) {
			expect(status.state).not.toBe("server-key");
		}
	});
});

describe("deriveGroqStatus", () => {
	test("a device-local key wins even if a server key is also detected", () => {
		expect(
			deriveGroqStatus({ groqApiKey: "gsk_abc", serverKeyDetected: true }),
		).toEqual({ provider: "groq", state: "device-key" });
	});

	test("no device key but a server key is detected", () => {
		expect(
			deriveGroqStatus({ groqApiKey: "", serverKeyDetected: true }),
		).toEqual({ provider: "groq", state: "server-key" });
	});

	test("no device key, no server key: missing", () => {
		expect(
			deriveGroqStatus({ groqApiKey: "", serverKeyDetected: false }),
		).toEqual({ provider: "groq", state: "missing" });
	});

	test("a whitespace-only device key is treated as no key", () => {
		expect(
			deriveGroqStatus({ groqApiKey: "   ", serverKeyDetected: false }),
		).toEqual({ provider: "groq", state: "missing" });
	});
});

describe("needsAiSetupWarning", () => {
	test("true when neither a device nor a server Groq key exists", () => {
		expect(
			needsAiSetupWarning({ groqApiKey: "", serverKeyDetected: false }),
		).toBe(true);
	});

	test("false with a device key", () => {
		expect(
			needsAiSetupWarning({ groqApiKey: "gsk_abc", serverKeyDetected: false }),
		).toBe(false);
	});

	test("false with a server key", () => {
		expect(
			needsAiSetupWarning({ groqApiKey: "", serverKeyDetected: true }),
		).toBe(false);
	});
});
