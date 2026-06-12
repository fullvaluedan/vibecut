import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

// HeyGen serves audio from its own CDNs — only those hosts may be proxied
// (the proxy exists because the browser can't decodeAudioData cross-origin).
const ALLOWED_HOST_SUFFIXES = [
	".heygen.com",
	".heygen.ai",
	".amazonaws.com",
	".cloudfront.net",
];

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
	const hostOk =
		parsed.protocol === "https:" &&
		ALLOWED_HOST_SUFFIXES.some((suffix) => parsed.hostname.endsWith(suffix));
	if (!hostOk) {
		return NextResponse.json(
			{ error: "Host not allowed for audio proxy" },
			{ status: 403 },
		);
	}
	const upstream = await fetch(parsed.toString());
	if (!upstream.ok || !upstream.body) {
		return NextResponse.json(
			{ error: `Audio fetch failed (${upstream.status})` },
			{ status: 502 },
		);
	}
	return new NextResponse(upstream.body, {
		headers: {
			"content-type":
				upstream.headers.get("content-type") ?? "application/octet-stream",
			"cache-control": "private, max-age=3600",
		},
	});
}
