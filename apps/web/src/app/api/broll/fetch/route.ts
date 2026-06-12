import { NextRequest, NextResponse } from "next/server";
import { isIP } from "node:net";

export const runtime = "nodejs";

/**
 * Downloads a b-roll image server-side (browsers can't read cross-origin
 * image bytes). Only https + public hostnames + image content types pass.
 */
export async function GET(req: NextRequest) {
	const url = req.nextUrl.searchParams.get("url");
	if (!url) {
		return NextResponse.json({ error: "Missing url" }, { status: 400 });
	}
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return NextResponse.json({ error: "Invalid url" }, { status: 400 });
	}
	const host = parsed.hostname.toLowerCase();
	if (
		parsed.protocol !== "https:" ||
		isIP(host) !== 0 ||
		host === "localhost" ||
		host.endsWith(".local") ||
		host.endsWith(".internal")
	) {
		return NextResponse.json({ error: "Host not allowed" }, { status: 403 });
	}
	const upstream = await fetch(parsed.toString(), {
		headers: { accept: "image/*" },
	});
	const contentType = upstream.headers.get("content-type") ?? "";
	if (!upstream.ok || !upstream.body || !contentType.startsWith("image/")) {
		return NextResponse.json(
			{ error: `Image fetch failed (${upstream.status}, ${contentType || "no type"})` },
			{ status: 502 },
		);
	}
	return new NextResponse(upstream.body, {
		headers: {
			"content-type": contentType,
			"cache-control": "private, max-age=3600",
		},
	});
}
