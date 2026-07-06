import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Generate the synthetic test media once per machine: a short colour-bars +
 * tone mp4 (real h264+aac, so the whole decode/waveform/thumbnail pipeline is
 * exercised). Needs ffmpeg on PATH (or FFMPEG env override) — same
 * requirement the app itself has for export burn-ins.
 */
export const FIXTURE_DIR = path.join(__dirname, "fixtures", ".generated");
export const FIXTURE_MP4 = path.join(FIXTURE_DIR, "e2e-sample.mp4");

export default function globalSetup(): void {
	if (fs.existsSync(FIXTURE_MP4)) return;
	fs.mkdirSync(FIXTURE_DIR, { recursive: true });
	const ffmpeg = process.env.FFMPEG ?? "ffmpeg";
	const result = spawnSync(
		ffmpeg,
		[
			"-y",
			"-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=5",
			"-f", "lavfi", "-i", "sine=frequency=440:duration=5",
			"-shortest", "-pix_fmt", "yuv420p",
			"-c:v", "libx264", "-c:a", "aac",
			FIXTURE_MP4,
		],
		{ stdio: "pipe", shell: process.platform === "win32" },
	);
	if (result.status !== 0 || !fs.existsSync(FIXTURE_MP4)) {
		throw new Error(
			`Could not generate the e2e media fixture (is ffmpeg installed?):\n${result.stderr?.toString().slice(-500)}`,
		);
	}
}
