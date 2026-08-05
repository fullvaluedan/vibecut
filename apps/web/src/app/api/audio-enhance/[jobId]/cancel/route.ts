import { NextRequest, NextResponse } from "next/server";
import {
	CLEARVOICE_SERVICE_URL,
	LONG_JOB_DISPATCHER,
	undiciFetch,
} from "../../service";

export const runtime = "nodejs";
export const maxDuration = 600;

/** POST /api/audio-enhance/[jobId]/cancel - stop between chunks. */
// eslint-disable-next-line opencut/prefer-object-params -- framework contract
export async function POST(
	_req: NextRequest,
	{ params }: { params: Promise<{ jobId: string }> },
) {
	const { jobId } = await params;
	try {
		const res = await undiciFetch(
			`${CLEARVOICE_SERVICE_URL}/enhance/${encodeURIComponent(jobId)}/cancel`,
			{
				method: "POST",
				dispatcher: LONG_JOB_DISPATCHER,
				signal: AbortSignal.timeout(10_000),
			},
		);
		return NextResponse.json(await res.json(), { status: res.status });
	} catch {
		return NextResponse.json(
			{ error: "The ClearVoice service isn't running." },
			{ status: 503 },
		);
	}
}
