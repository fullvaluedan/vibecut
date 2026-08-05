import { NextRequest, NextResponse } from "next/server";
import {
	CLEARVOICE_SERVICE_URL,
	LONG_JOB_DISPATCHER,
	undiciFetch,
} from "../service";

export const runtime = "nodejs";
export const maxDuration = 600;

type JobRouteContext = { params: Promise<{ jobId: string }> };

/** GET /api/audio-enhance/[jobId] - job progress/status. */
// Next.js route handlers receive (request, context) positionally; the repo's
// object-params rule cannot apply to this framework contract.
// eslint-disable-next-line opencut/prefer-object-params
export async function GET(_req: NextRequest, { params }: JobRouteContext) {
	const { jobId } = await params;
	try {
		const res = await undiciFetch(
			`${CLEARVOICE_SERVICE_URL}/enhance/${encodeURIComponent(jobId)}`,
			{ dispatcher: LONG_JOB_DISPATCHER, signal: AbortSignal.timeout(10_000) },
		);
		return NextResponse.json(await res.json(), { status: res.status });
	} catch {
		return NextResponse.json(
			{ error: "The ClearVoice service isn't running." },
			{ status: 503 },
		);
	}
}
