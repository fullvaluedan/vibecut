import { readFile } from "node:fs/promises";
import { NextRequest, NextResponse } from "next/server";
import { bakeRegistryItem } from "@framecut/hf-bridge";

export const runtime = "nodejs";
export const maxDuration = 600;

/**
 * Bakes a HyperFrames registry block to a cached transparent WebM and streams
 * it back. Idempotent — repeat calls for the same block return the cached file
 * instantly (x-framecut-cached: 1).
 */
export async function POST(req: NextRequest) {
	const body = (await req.json()) as {
		name?: unknown;
		fps?: unknown;
		type?: unknown;
	};
	if (typeof body?.name !== "string" || !body.name) {
		return NextResponse.json({ error: "Missing asset name" }, { status: 400 });
	}
	const fps = Number.isFinite(body.fps) ? (body.fps as number) : 30;
	const type = typeof body.type === "string" ? body.type : undefined;
	try {
		const outcome = await bakeRegistryItem({ name: body.name, fps, type });
		const bytes = await readFile(outcome.videoPath);
		return new NextResponse(new Uint8Array(bytes), {
			headers: {
				"content-type": "video/webm",
				"x-framecut-bake-key": outcome.bakeKey,
				"x-framecut-title": encodeURIComponent(outcome.title),
				"x-framecut-dims": `${outcome.width}x${outcome.height}`,
				"x-framecut-duration": String(outcome.durationSec),
				"x-framecut-cached": outcome.cached ? "1" : "0",
			},
		});
	} catch (e) {
		return NextResponse.json(
			{ error: `Bake failed: ${e instanceof Error ? e.message : String(e)}` },
			{ status: 500 },
		);
	}
}
