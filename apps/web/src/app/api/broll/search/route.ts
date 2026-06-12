import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export interface BrollResult {
	title: string;
	imageUrl: string;
	thumbnailUrl: string;
	sourcePage: string;
}

/**
 * "Find b-roll" backend: SerpAPI Google Images search. Returns direct image
 * URLs the client can import into the media bin (stills work as b-roll with
 * motion applied; video b-roll needs a stock-footage provider later).
 */
export async function POST(req: NextRequest) {
	const apiKey = req.headers.get("x-framecut-serpapi-key");
	if (!apiKey) {
		return NextResponse.json(
			{ error: "No SerpAPI key. Add one in Settings → AI → Integrations." },
			{ status: 401 },
		);
	}
	const body = (await req.json()) as { query?: string; limit?: number };
	const query = typeof body.query === "string" ? body.query.trim() : "";
	if (!query) {
		return NextResponse.json({ error: "Empty search query" }, { status: 400 });
	}
	const params = new URLSearchParams({
		engine: "google_images",
		q: query.slice(0, 300),
		imgsz: "l",
		safe: "active",
		api_key: apiKey,
	});
	const res = await fetch(`https://serpapi.com/search.json?${params}`);
	if (!res.ok) {
		const text = await res.text();
		return NextResponse.json(
			{ error: `SerpAPI failed (${res.status}): ${text.slice(0, 300)}` },
			{ status: res.status === 401 ? 401 : 502 },
		);
	}
	const data = (await res.json()) as {
		images_results?: {
			title?: string;
			original?: string;
			thumbnail?: string;
			link?: string;
		}[];
	};
	const limit = Math.min(Math.max(body.limit ?? 6, 1), 20);
	const results: BrollResult[] = (data.images_results ?? [])
		.filter((r) => typeof r.original === "string" && r.original.startsWith("https://"))
		.slice(0, limit)
		.map((r) => ({
			title: r.title ?? query,
			imageUrl: r.original as string,
			thumbnailUrl: r.thumbnail ?? (r.original as string),
			sourcePage: r.link ?? "",
		}));
	return NextResponse.json({ results });
}
