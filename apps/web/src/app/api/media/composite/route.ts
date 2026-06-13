import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 600;

/**
 * Hardware H.264 beats libx264 by 3-8x on the burn-in re-encode. Probe the
 * local ffmpeg once and remember the best encoder (NVIDIA → Intel → AMD →
 * software). A failed hardware encode falls back to libx264 per request.
 */
let cachedEncoder: { args: string[]; name: string } | null = null;
const SOFTWARE_ENCODER = {
	name: "libx264",
	args: ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18"],
};

async function resolveEncoder(): Promise<{ args: string[]; name: string }> {
	if (cachedEncoder) return cachedEncoder;
	const listed = await new Promise<string>((resolve) => {
		const child = spawn("ffmpeg", ["-hide_banner", "-encoders"], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		child.stdout.on("data", (d) => (out += d.toString()));
		child.on("error", () => resolve(""));
		child.on("close", () => resolve(out));
	});
	const candidates: Array<{ name: string; args: string[] }> = [
		{ name: "h264_nvenc", args: ["-c:v", "h264_nvenc", "-preset", "p4", "-cq", "19"] },
		{ name: "h264_qsv", args: ["-c:v", "h264_qsv", "-global_quality", "19"] },
		{ name: "h264_amf", args: ["-c:v", "h264_amf", "-quality", "balanced", "-rc", "cqp", "-qp_i", "19", "-qp_p", "21"] },
	];
	cachedEncoder =
		candidates.find((c) => listed.includes(` ${c.name} `)) ?? SOFTWARE_ENCODER;
	return cachedEncoder;
}

interface OverlaySpec {
	/** Form field name holding the overlay file (e.g. "overlay_0"). */
	field: string;
	startSec: number;
	durationSec: number;
	trimStartSec: number;
	/** Rendered rect in canvas pixels (top-left x/y + size), matching the
	 *  preview. Older callers may omit these → fall back to full-frame. */
	x?: number;
	y?: number;
	w?: number;
	h?: number;
	opacity?: number;
}

/**
 * Composites alpha-WebM overlays onto a base video with ffmpeg (libvpx-vp9
 * decodes VP9 alpha correctly, unlike browser WebCodecs). Used by export and
 * scene nesting whenever FrameCut AI clips are on the timeline.
 *
 * FormData: base (file), manifest (JSON OverlaySpec[]), overlay_<i> (files).
 */
export async function POST(req: NextRequest) {
	const form = await req.formData();
	const base = form.get("base");
	const manifestRaw = form.get("manifest");
	if (!(base instanceof File) || typeof manifestRaw !== "string") {
		return NextResponse.json({ error: "Missing base or manifest" }, { status: 400 });
	}
	let manifest: OverlaySpec[];
	try {
		manifest = JSON.parse(manifestRaw) as OverlaySpec[];
	} catch {
		return NextResponse.json({ error: "Invalid manifest" }, { status: 400 });
	}

	const dir = await mkdtemp(path.join(os.tmpdir(), "vibecut-composite-"));
	try {
		const baseExt = base.name?.endsWith(".webm") ? ".webm" : ".mp4";
		const basePath = path.join(dir, `base${baseExt}`);
		await writeFile(basePath, Buffer.from(await base.arrayBuffer()));

		const args: string[] = ["-y", "-i", basePath];
		const filters: string[] = [];
		let prevLabel = "[0:v]";
		let inputIndex = 1;
		for (const spec of manifest) {
			const file = form.get(spec.field);
			if (!(file instanceof File)) continue;
			const ovPath = path.join(dir, `ov_${inputIndex}.webm`);
			await writeFile(ovPath, Buffer.from(await file.arrayBuffer()));
			// Force libvpx-vp9 so the alpha plane is decoded.
			args.push("-c:v", "libvpx-vp9", "-i", ovPath);
			const start = Math.max(0, spec.startSec);
			const end = start + spec.durationSec;
			// Scale + position the overlay to its rendered rect so the burn-in
			// matches the preview exactly (contain-fit + transform). Omitted
			// (older callers) → native size, top-left (the previous behavior).
			const scale =
				typeof spec.w === "number" && typeof spec.h === "number"
					? `,scale=${spec.w}:${spec.h}`
					: "";
			const fade =
				typeof spec.opacity === "number" && spec.opacity < 1
					? `,format=rgba,colorchannelmixer=aa=${spec.opacity}`
					: "";
			const x = typeof spec.x === "number" ? spec.x : 0;
			const y = typeof spec.y === "number" ? spec.y : 0;
			const trimmed = `[${inputIndex}:v]trim=start=${spec.trimStartSec}:duration=${spec.durationSec},setpts=PTS-STARTPTS+${start}/TB${scale}${fade}[ov${inputIndex}]`;
			const outLabel = `[v${inputIndex}]`;
			filters.push(trimmed);
			filters.push(
				`${prevLabel}[ov${inputIndex}]overlay=${x}:${y}:eof_action=pass:enable='between(t,${start},${end})'${outLabel}`,
			);
			prevLabel = outLabel;
			inputIndex += 1;
		}

		if (inputIndex === 1) {
			// No overlays — return the base unchanged.
			const out = await readFile(basePath);
			return new NextResponse(new Uint8Array(out), {
				headers: { "content-type": baseExt === ".webm" ? "video/webm" : "video/mp4" },
			});
		}

		const outPath = path.join(dir, "out.mp4");
		const buildArgs = (encoderArgs: string[]) => [
			...args,
			"-filter_complex",
			filters.join(";"),
			"-map",
			prevLabel,
			"-map",
			"0:a?",
			...encoderArgs,
			"-pix_fmt",
			"yuv420p",
			"-c:a",
			"aac",
			"-movflags",
			"+faststart",
			outPath,
		];

		const runFfmpeg = (fullArgs: string[]) =>
			new Promise<{ code: number; log: string }>((resolve, reject) => {
				const child = spawn("ffmpeg", fullArgs, {
					stdio: ["ignore", "pipe", "pipe"],
				});
				let log = "";
				child.stdout.on("data", (d) => (log += d.toString()));
				child.stderr.on("data", (d) => (log += d.toString()));
				child.on("error", reject);
				child.on("close", (code) => resolve({ code: code ?? 1, log }));
			});

		const encoder = await resolveEncoder();
		let result = await runFfmpeg(buildArgs(encoder.args));
		if (result.code !== 0 && encoder.name !== SOFTWARE_ENCODER.name) {
			// Listed hardware encoders can still fail at runtime (driver/session
			// limits) — software is the always-works fallback.
			result = await runFfmpeg(buildArgs(SOFTWARE_ENCODER.args));
		}
		if (result.code !== 0) {
			return NextResponse.json(
				{ error: `ffmpeg composite failed: ${result.log.slice(-800)}` },
				{ status: 500 },
			);
		}
		const out = await readFile(outPath);
		return new NextResponse(new Uint8Array(out), {
			headers: { "content-type": "video/mp4" },
		});
	} catch (e) {
		return NextResponse.json(
			{ error: e instanceof Error ? e.message : String(e) },
			{ status: 500 },
		);
	} finally {
		await rm(dir, { recursive: true, force: true }).catch(() => undefined);
	}
}
