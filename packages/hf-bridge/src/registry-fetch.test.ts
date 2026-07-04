import { afterEach, describe, expect, it } from "bun:test";
import { fetchRegistryComposition, registryKindDir } from "./registry-fetch";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

const BASE = "https://example.test/registry";

function mockRegistry(
	map: Record<string, { json?: unknown; text?: string }>,
): void {
	globalThis.fetch = (async (input: string | URL | Request) => {
		const url = String(input);
		const entry = map[url];
		if (!entry) return new Response("", { status: 404 });
		if (entry.text !== undefined) {
			return new Response(entry.text, { status: 200 });
		}
		return new Response(JSON.stringify(entry.json ?? {}), { status: 200 });
	}) as typeof fetch;
}

describe("registryKindDir", () => {
	it("pluralizes the kind from a hyperframes: type", () => {
		expect(registryKindDir("hyperframes:block")).toBe("blocks");
		expect(registryKindDir("hyperframes:example")).toBe("examples");
		expect(registryKindDir("hyperframes:component")).toBe("components");
	});
	it("falls back to the raw type when there is no colon", () => {
		expect(registryKindDir("widget")).toBe("widgets");
	});
});

describe("fetchRegistryComposition", () => {
	it("fetches a block's composition + dimensions", async () => {
		mockRegistry({
			[`${BASE}/blocks/foo/registry-item.json`]: {
				json: {
					name: "foo",
					type: "hyperframes:block",
					title: "Foo",
					duration: 7,
					dimensions: { width: 1280, height: 720 },
					files: [{ path: "comp.html", type: "hyperframes:composition" }],
				},
			},
			[`${BASE}/blocks/foo/comp.html`]: {
				text: "<!doctype html><html>FOO</html>",
			},
		});
		const r = await fetchRegistryComposition({
			name: "foo",
			type: "hyperframes:block",
			registryBase: BASE,
		});
		expect(r.compHtml).toContain("FOO");
		expect(r.width).toBe(1280);
		expect(r.height).toBe(720);
		expect(r.durationSec).toBe(7);
		expect(r.title).toBe("Foo");
		expect(r.compFile?.path).toBe("comp.html");
	});

	it("fetches an example from the examples/ path with default dims", async () => {
		mockRegistry({
			[`${BASE}/examples/swiss-grid/registry-item.json`]: {
				json: {
					name: "swiss-grid",
					type: "hyperframes:example",
					files: [{ path: "index.html", type: "hyperframes:composition" }],
				},
			},
			[`${BASE}/examples/swiss-grid/index.html`]: {
				text: "<html>SWISS</html>",
			},
		});
		const r = await fetchRegistryComposition({
			name: "swiss-grid",
			type: "hyperframes:example",
			registryBase: BASE,
		});
		expect(r.compHtml).toContain("SWISS");
		expect(r.width).toBe(1920);
		expect(r.durationSec).toBe(5);
	});

	it("returns a null compFile for a snippet-only component", async () => {
		mockRegistry({
			[`${BASE}/components/caption-x/registry-item.json`]: {
				json: {
					name: "caption-x",
					type: "hyperframes:component",
					files: [{ path: "snippet.tsx", type: "hyperframes:snippet" }],
				},
			},
		});
		const r = await fetchRegistryComposition({
			name: "caption-x",
			type: "hyperframes:component",
			registryBase: BASE,
		});
		expect(r.compFile).toBeNull();
		expect(r.compHtml).toBe("");
	});

	it("throws a clear error on a non-OK registry response", async () => {
		mockRegistry({});
		await expect(
			fetchRegistryComposition({
				name: "missing",
				type: "hyperframes:block",
				registryBase: BASE,
			}),
		).rejects.toThrow(/Could not fetch/);
	});

	it("rejects a traversal name before fetching", async () => {
		await expect(
			fetchRegistryComposition({
				name: "../../etc",
				type: "hyperframes:block",
				registryBase: BASE,
			}),
		).rejects.toThrow(/Invalid registry item name/);
	});

	it("rejects an unknown type", async () => {
		await expect(
			fetchRegistryComposition({
				name: "ok",
				type: "hyperframes:evil",
				registryBase: BASE,
			}),
		).rejects.toThrow(/Invalid registry item type/);
	});
});
