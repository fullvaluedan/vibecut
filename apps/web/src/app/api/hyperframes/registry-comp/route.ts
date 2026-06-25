import { NextRequest, NextResponse } from "next/server";
import { fetchRegistryComposition } from "@framecut/hf-bridge";

export const runtime = "nodejs";

/**
 * Returns a single registry item's REAL composition HTML (server-side fetch, so
 * the browser never hits raw.githubusercontent directly). Used by the Authored
 * RUN to give the model a picked asset to adapt instead of reinventing it.
 */
export async function POST(req: NextRequest) {
	const body = (await req.json()) as { name?: unknown; type?: unknown };
	if (
		typeof body?.name !== "string" ||
		!body.name ||
		typeof body?.type !== "string"
	) {
		return NextResponse.json({ error: "Missing name/type" }, { status: 400 });
	}
	try {
		const { compHtml, title } = await fetchRegistryComposition({
			name: body.name,
			type: body.type,
		});
		return NextResponse.json({ name: body.name, title, html: compHtml });
	} catch (e) {
		return NextResponse.json(
			{ error: e instanceof Error ? e.message : String(e) },
			{ status: 500 },
		);
	}
}
