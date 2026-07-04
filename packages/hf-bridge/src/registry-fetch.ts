/**
 * Kind-agnostic HyperFrames registry fetch: pull any registry item's composition
 * + asset files (block / component / example) so both the bake path and the
 * Authored reference path consume ONE fetcher instead of two divergent ones.
 *
 * Mirrors the registry route's kind convention: kind = type.split(":")[1], and
 * items live under `${base}/${kind}s/${name}/`. No CLI/wasm import → bun-testable
 * with a mock registryBase.
 */

const REGISTRY_BASE =
	"https://raw.githubusercontent.com/heygen-com/hyperframes/main/registry";

/** Registry item kinds VibeCut understands (drives the `${kind}s/` directory). */
export const KNOWN_REGISTRY_KINDS = ["block", "example", "component"] as const;

/**
 * A registry item name must be a simple slug. Rejecting anything else stops a
 * crafted name (e.g. "../", an absolute path, URL injection) from traversing the
 * fetch URL path OR the bake directory it is later interpolated into.
 */
export function isValidRegistryName(name: string): boolean {
	return /^[a-z0-9][a-z0-9-]*$/i.test(name);
}

/** A type must be `hyperframes:<known-kind>` so the fetched `${kind}s/` dir is bounded. */
export function isValidRegistryType(type: string): boolean {
	const kind = type.split(":")[1] ?? "";
	return (
		type.startsWith("hyperframes:") &&
		(KNOWN_REGISTRY_KINDS as readonly string[]).includes(kind)
	);
}

export interface RegistryCompositionFile {
	path: string;
	target?: string;
	type?: string;
}

export interface RegistryItemMeta {
	name: string;
	type: string;
	title?: string;
	description?: string;
	duration?: number;
	dimensions?: { width?: number; height?: number };
	files?: RegistryCompositionFile[];
}

export interface RegistryComposition {
	item: RegistryItemMeta;
	/** The hyperframes:composition file, or null when the item has none (snippet-only). */
	compFile: RegistryCompositionFile | null;
	/** The composition HTML; "" when there is no composition file. */
	compHtml: string;
	/** All registry files (composition + assets). */
	files: RegistryCompositionFile[];
	title: string;
	width: number;
	height: number;
	durationSec: number;
}

/** Plural registry directory for a type: "hyperframes:block" -> "blocks". */
export function registryKindDir(type: string): string {
	const kind = type.split(":")[1] ?? type;
	return `${kind}s`;
}

async function fetchOk(url: string): Promise<Response> {
	const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
	if (!res.ok) {
		throw new Error(`Could not fetch ${url} (${res.status})`);
	}
	return res;
}

/**
 * Fetch a registry item's metadata + composition HTML for ANY kind. The caller
 * passes the item `type` (known from the registry listing) so the right
 * `${kind}s/` directory is used. When the item has no composition file (a
 * snippet-only component), `compFile` is null and `compHtml` is "" — the caller
 * decides whether that is renderable.
 */
export async function fetchRegistryComposition({
	name,
	type,
	registryBase = REGISTRY_BASE,
}: {
	name: string;
	type: string;
	registryBase?: string;
}): Promise<RegistryComposition> {
	if (!isValidRegistryName(name)) {
		throw new Error(`Invalid registry item name: ${JSON.stringify(name)}`);
	}
	if (!isValidRegistryType(type)) {
		throw new Error(`Invalid registry item type: ${JSON.stringify(type)}`);
	}
	const dir = registryKindDir(type);
	const item = (await (
		await fetchOk(`${registryBase}/${dir}/${name}/registry-item.json`)
	).json()) as RegistryItemMeta;

	const files = item.files ?? [];
	const compFile =
		files.find((f) => f.type === "hyperframes:composition") ?? null;
	const width = item.dimensions?.width ?? 1920;
	const height = item.dimensions?.height ?? 1080;
	const durationSec = item.duration ?? 5;
	const compHtml = compFile
		? await (
				await fetchOk(`${registryBase}/${dir}/${name}/${compFile.path}`)
			).text()
		: "";

	return {
		item,
		compFile,
		compHtml,
		files,
		title: item.title ?? name,
		width,
		height,
		durationSec,
	};
}
