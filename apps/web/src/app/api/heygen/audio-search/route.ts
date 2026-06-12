import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export interface HeygenSound {
	id: string;
	name: string;
	description: string;
	audioUrl: string;
	duration: number | null;
	score: number;
	type: "music" | "sound_effects";
}

/**
 * Proxies HeyGen's semantic audio search (music + sound effects).
 * https://developers.heygen.com/reference/search-audio-music-or-sound-effects
 * The key never leaves this machine — it arrives per-request from the
 * device-local settings store.
 */
export async function POST(req: NextRequest) {
	const apiKey = req.headers.get("x-framecut-heygen-key");
	if (!apiKey) {
		return NextResponse.json(
			{ error: "No HeyGen API key. Add one in Settings → AI → Integrations." },
			{ status: 401 },
		);
	}
	const body = (await req.json()) as {
		query?: string;
		type?: "music" | "sound_effects";
		limit?: number;
	};
	const query = typeof body.query === "string" ? body.query.trim() : "";
	if (!query) {
		return NextResponse.json({ error: "Empty search query" }, { status: 400 });
	}
	const params = new URLSearchParams({
		query: query.slice(0, 5000),
		type: body.type === "sound_effects" ? "sound_effects" : "music",
		limit: String(Math.min(Math.max(body.limit ?? 12, 1), 50)),
	});
	const res = await fetch(`https://api.heygen.com/v3/audio/sounds?${params}`, {
		headers: { "x-api-key": apiKey },
	});
	if (!res.ok) {
		const text = await res.text();
		return NextResponse.json(
			{ error: `HeyGen audio search failed (${res.status}): ${text.slice(0, 300)}` },
			{ status: res.status === 401 ? 401 : 502 },
		);
	}
	const data = (await res.json()) as {
		data?: {
			id: string;
			name: string;
			description?: string;
			audio_url: string;
			duration?: number | null;
			score?: number;
			type?: string;
		}[];
	};
	const sounds: HeygenSound[] = (data.data ?? []).map((s) => ({
		id: s.id,
		name: s.name,
		description: s.description ?? "",
		audioUrl: s.audio_url,
		duration: s.duration ?? null,
		score: s.score ?? 0,
		type: s.type === "sound_effects" ? "sound_effects" : "music",
	}));
	return NextResponse.json({ sounds });
}
