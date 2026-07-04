import { NextResponse } from "next/server";

export const runtime = "nodejs";

const REGISTRY_BASE =
	"https://raw.githubusercontent.com/heygen-com/hyperframes/main/registry";
const CACHE_MS = 60 * 60 * 1000;

export interface RegistryAsset {
	name: string;
	type: string;
	title: string;
	description: string;
	previewVideo: string | null;
	previewPoster: string | null;
	durationSec: number | null;
	/** Registry tags (e.g. "transition", "shader", "data") — used to route each
	 *  asset to the right mechanism (overlay-droppable vs transition vs effect). */
	tags: string[];
	/** True when the item has a composition file, so it can bake to a droppable clip. */
	renderable: boolean;
}

let cache: { at: number; items: RegistryAsset[] } | null = null;

async function fetchJson(url: string): Promise<unknown | null> {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	}
}

async function enrich(item: {
	name: string;
	type: string;
}): Promise<RegistryAsset> {
	const kind = item.type.split(":")[1] ?? item.type;
	const detail = (await fetchJson(
		`${REGISTRY_BASE}/${kind}s/${item.name}/registry-item.json`,
	)) as {
		title?: string;
		description?: string;
		duration?: number;
		tags?: string[];
		files?: { type?: string }[];
		preview?: { video?: string; poster?: string };
	} | null;
	return {
		name: item.name,
		type: item.type,
		title: detail?.title ?? item.name,
		description: detail?.description ?? "",
		previewVideo: detail?.preview?.video ?? null,
		previewPoster: detail?.preview?.poster ?? null,
		durationSec: detail?.duration ?? null,
		tags: Array.isArray(detail?.tags) ? detail.tags : [],
		// Bakeable to a droppable clip = has a composition file AND is not a whole-
		// video example. Examples reference sub-compositions + a video placeholder,
		// so they cannot render standalone (verified) — they are used via RUN
		// HYPERFRAMES instead. Components are snippets with no composition file.
		renderable:
			item.type !== "hyperframes:example" &&
			Array.isArray(detail?.files) &&
			detail.files.some((f) => f?.type === "hyperframes:composition"),
	};
}

/**
 * Lists every asset in the official HyperFrames registry, enriched with
 * titles, descriptions, and hosted preview media (cached 1h).
 */
export async function GET() {
	if (cache && Date.now() - cache.at < CACHE_MS) {
		return NextResponse.json({ items: cache.items });
	}
	const index = (await fetchJson(`${REGISTRY_BASE}/registry.json`)) as {
		items?: { name: string; type: string }[];
	} | null;
	if (!index?.items) {
		return NextResponse.json({
			items: [],
			error: "Could not reach the HyperFrames registry.",
		});
	}
	const valid = index.items.filter(
		(item) => typeof item?.name === "string" && typeof item?.type === "string",
	);
	const items = await Promise.all(valid.map(enrich));
	cache = { at: Date.now(), items };
	return NextResponse.json({ items });
}
