import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export interface DoctorReport {
	node: { ok: boolean; detail: string };
	hyperframes: { ok: boolean; detail: string };
	ffmpeg: { ok: boolean; detail: string };
	claudeCli: { ok: boolean; detail: string };
}

function probe(command: string, args: string[]): Promise<{ ok: boolean; detail: string }> {
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			shell: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		child.stdout.on("data", (d) => (out += d.toString()));
		child.stderr.on("data", (d) => (out += d.toString()));
		child.on("error", (e) => resolve({ ok: false, detail: String(e) }));
		child.on("close", (code) =>
			resolve({
				ok: code === 0,
				detail: out.split(/\r?\n/)[0]?.slice(0, 120) ?? "",
			}),
		);
	});
}

export async function runDoctor(): Promise<DoctorReport> {
	const major = Number(process.versions.node.split(".")[0]);
	const node = {
		ok: major >= 22,
		detail: `node ${process.versions.node} (need ≥ 22)`,
	};

	let hyperframes: { ok: boolean; detail: string };
	try {
		const pkg = require("hyperframes/package.json") as { version: string };
		hyperframes = { ok: true, detail: `hyperframes ${pkg.version} (pinned)` };
	} catch (e) {
		hyperframes = { ok: false, detail: `not installed: ${String(e).slice(0, 80)}` };
	}

	const [ffmpeg, claudeCli] = await Promise.all([
		probe("ffmpeg", ["-version"]),
		probe("claude", ["--version"]),
	]);

	return { node, hyperframes, ffmpeg, claudeCli };
}
