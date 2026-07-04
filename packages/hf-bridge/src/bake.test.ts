import { afterEach, describe, expect, it } from "bun:test";
import { bakeRegistryItem } from "./bake";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

const BASE = "https://example.test/registry";

describe("bakeRegistryItem — pre-render guards (no CLI)", () => {
	it("rejects a traversal name before any fetch or write", async () => {
		await expect(
			bakeRegistryItem({
				name: "../../etc/passwd",
				type: "hyperframes:block",
				fps: 30,
				registryBase: BASE,
			}),
		).rejects.toThrow(/Invalid registry item name/);
	});

	it("rejects an unknown type", async () => {
		await expect(
			bakeRegistryItem({
				name: "ok-name",
				type: "hyperframes:evil",
				fps: 30,
				registryBase: BASE,
			}),
		).rejects.toThrow(/Invalid registry item type/);
	});

	it("throws a clear error for a snippet-only component (no composition file)", async () => {
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({
					name: "caption-x",
					type: "hyperframes:component",
					files: [{ path: "snippet.tsx", type: "hyperframes:snippet" }],
				}),
				{ status: 200 },
			)) as typeof fetch;
		await expect(
			bakeRegistryItem({
				name: "caption-x",
				type: "hyperframes:component",
				fps: 30,
				registryBase: BASE,
			}),
		).rejects.toThrow(/no composition file/);
	});
});
