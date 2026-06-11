import { NextResponse } from "next/server";
import { runDoctor } from "@framecut/hf-bridge";

export const runtime = "nodejs";

export async function GET() {
	try {
		const report = await runDoctor();
		return NextResponse.json(report);
	} catch (e) {
		return NextResponse.json(
			{ error: e instanceof Error ? e.message : String(e) },
			{ status: 500 },
		);
	}
}
