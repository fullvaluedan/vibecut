import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 600;

interface OverlaySpec {
	/** Form field name holding the overlay file (e.g. "overlay_0"). */
	field: string;
	startSec: number;
	durationSec: number;
	trimStartSec: number;
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
			const trimmed = `[${inputIndex}:v]trim=start=${spec.trimStartSec}:duration=${spec.durationSec},setpts=PTS-STARTPTS+${start}/TB[ov${inputIndex}]`;
			const outLabel = `[v${inputIndex}]`;
			filters.push(trimmed);
			filters.push(
				`${prevLabel}[ov${inputIndex}]overlay=eof_action=pass:enable='between(t,${start},${end})'${outLabel}`,
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
		args.push(
			"-filter_complex",
			filters.join(";"),
			"-map",
			prevLabel,
			"-map",
			"0:a?",
			"-c:v",
			"libx264",
			"-preset",
			"veryfast",
			"-crf",
			"18",
			"-pix_fmt",
			"yuv420p",
			"-c:a",
			"aac",
			"-movflags",
			"+faststart",
			outPath,
		);

		const result = await new Promise<{ code: number; log: string }>(
			(resolve, reject) => {
				const child = spawn("ffmpeg", args, {
					stdio: ["ignore", "pipe", "pipe"],
				});
				let log = "";
				child.stdout.on("data", (d) => (log += d.toString()));
				child.stderr.on("data", (d) => (log += d.toString()));
				child.on("error", reject);
				child.on("close", (code) => resolve({ code: code ?? 1, log }));
			},
		);
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
