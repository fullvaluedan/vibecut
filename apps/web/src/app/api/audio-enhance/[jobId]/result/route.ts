import { NextRequest, NextResponse } from "next/server";
import {
	CLEARVOICE_SERVICE_URL,
	LONG_JOB_DISPATCHER,
	undiciFetch,
} from "../../service";

export const runtime = "nodejs";
export const maxDuration = 600;

/** GET /api/audio-enhance/[jobId]/result - the enhanced WAV when done. */
// eslint-disable-next-line opencut/prefer-object-params -- framework contract
export async function GET(
	_req: NextRequest,
	{ params }: { params: Promise<{ jobId: string }> },
) {
	const { jobId } = await params;
	try {
		const res = await undiciFetch(
			`${CLEARVOICE_SERVICE_URL}/enhance/${encodeURIComponent(jobId)}/result`,
			{ dispatcher: LONG_JOB_DISPATCHER, signal: AbortSignal.timeout(60_000) },
		);
		if (!res.ok) {
			const detail = await res.text().catch(() => "");
			return NextResponse.json(
				{
					error:
						detail.slice(0, 200) ||
						`The enhanced audio is not ready yet (${res.status}).`,
				},
				{ status: res.status === 409 ? 409 : 502 },
			);
		}
		const buffer = await res.arrayBuffer();
		return new NextResponse(new Uint8Array(buffer), {
			headers: {
				"content-type": res.headers.get("content-type") ?? "audio/wav",
				"content-length": String(buffer.byteLength),
			},
		});
	} catch {
		return NextResponse.json(
			{ error: "The ClearVoice service isn't running." },
			{ status: 503 },
		);
	}
}
