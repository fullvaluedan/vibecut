import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { findHyperframesPackageDir, resolveClaude } from "./renderer";

export interface DoctorReport {
	node: { ok: boolean; detail: string };
	hyperframes: { ok: boolean; detail: string };
	ffmpeg: { ok: boolean; detail: string };
	claudeCli: { ok: boolean; detail: string };
}

function probe(command: string, args: string[], useShell = true): Promise<{ ok: boolean; detail: string }> {
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			shell: useShell,
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
		const pkgDir = findHyperframesPackageDir();
		const pkg = JSON.parse(
			readFileSync(path.join(pkgDir, "package.json"), "utf8"),
		) as { version: string };
		hyperframes = { ok: true, detail: `hyperframes ${pkg.version} (pinned)` };
	} catch (e) {
		hyperframes = { ok: false, detail: `not installed: ${String(e).slice(0, 80)}` };
	}

	const claude = resolveClaude();
	const [ffmpeg, claudeCli] = await Promise.all([
		probe("ffmpeg", ["-version"]),
		probe(claude.command, ["--version"], claude.useShell),
	]);

	return { node, hyperframes, ffmpeg, claudeCli };
}
