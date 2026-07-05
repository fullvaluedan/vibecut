/**
 * Detached graphics-generate worker. Spawned by /api/graphics/start with:
 *   node scripts/graphics-worker.mjs <jobId> <engine>
 * and env: GRAPHICS_TEMP_ROOT, GRAPHICS_REMOTION_DIR, GRAPHICS_DRY_RUN.
 *
 * It runs the phase machine (generate -> proof render -> wait for approval -> full
 * render -> import-ready), keeping <TEMP_ROOT>/<jobId>/job.json current and bumping a
 * heartbeat every 3s so the UI can prove it is alive across a ~2hr render. It never
 * touches the browser; the client polls job.json via /api/graphics/status and does the
 * timeline placement once fullPath (or proofPath) appears.
 *
 * Heavy steps (claude generation, remotion render) are real spawns, but GRAPHICS_DRY_RUN=1
 * substitutes fast fake progress so the whole pipeline is smoke-testable without a real
 * 2hr render or a claude session. Swap DRY_RUN off for live tuning of the two commands.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [jobId, engine] = process.argv.slice(2);
const TEMP_ROOT = process.env.GRAPHICS_TEMP_ROOT || "D:\\Claude\\_temp";
const REMOTION_DIR = process.env.GRAPHICS_REMOTION_DIR || "D:\\Hermes\\remotion-v2";
const DRY_RUN = process.env.GRAPHICS_DRY_RUN === "1";
const FFMPEG = process.env.GRAPHICS_FFMPEG || "ffmpeg";
// The generation step registers the composition under this id so `remotion render`
// is deterministic (no guessing what claude named it). Overridable for tuning.
const COMP_ID = process.env.GRAPHICS_REMOTION_COMP || "GraphicsMain";
const ENTRY = process.env.GRAPHICS_REMOTION_ENTRY || "src/index.ts";

const dir = path.join(TEMP_ROOT, jobId);
const jobFile = path.join(dir, "job.json");
const approveFlag = path.join(dir, "approve-full");
const cancelFlag = path.join(dir, "cancel");

// ---- job.json state (atomic write) --------------------------------------------------
let job = readJob() || {
	id: jobId,
	engine,
	phase: "extracting",
	progress: 0,
	message: "Starting...",
	log: [],
	heartbeatAt: Date.now(),
	createdAt: Date.now(),
};

function readJob() {
	try {
		return JSON.parse(fs.readFileSync(jobFile, "utf8"));
	} catch {
		return null;
	}
}
function writeJob() {
	job.heartbeatAt = Date.now();
	const tmp = jobFile + ".tmp";
	fs.writeFileSync(tmp, JSON.stringify(job, null, 2));
	fs.renameSync(tmp, jobFile); // atomic on same volume
}
function log(text, level = "info") {
	job.log.push({ t: Date.now(), text, level });
	if (job.log.length > 400) job.log = job.log.slice(-400);
	writeJob();
	console.log(`[${level}] ${text}`);
}
function setPhase(phase, message, progress = 0) {
	job.phase = phase;
	job.message = message;
	job.progress = progress;
	log(message);
}
function fail(err) {
	job.error = String(err && err.message ? err.message : err);
	setPhase("error", `Failed: ${job.error}`);
	process.exit(1);
}
function cancelled() {
	return fs.existsSync(cancelFlag);
}
function bailIfCancelled() {
	if (cancelled()) {
		setPhase("cancelled", "Cancelled by user");
		process.exit(0);
	}
}

// Heartbeat so a long render never looks frozen even between progress ticks.
const heartbeat = setInterval(() => {
	if (!isTerminal()) writeJob();
	bailIfCancelled();
}, 3000);
function isTerminal() {
	return ["done", "error", "cancelled"].includes(job.phase);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run a child process, forwarding stdout/stderr to a parser that can update progress.
 * Rejects on non-zero exit. Honors cancel by killing the child.
 */
function run(cmd, args, opts, onLine) {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env }, shell: true });
		const watch = setInterval(() => {
			if (cancelled()) {
				try { child.kill(); } catch {}
			}
		}, 1000);
		const feed = (buf) => {
			for (const line of buf.toString().split(/\r?\n/)) {
				if (line.trim()) onLine?.(line);
			}
		};
		child.stdout.on("data", feed);
		child.stderr.on("data", feed);
		child.on("error", (e) => { clearInterval(watch); reject(e); });
		child.on("close", (code) => {
			clearInterval(watch);
			if (cancelled()) return resolve({ cancelled: true });
			code === 0 ? resolve({ code }) : reject(new Error(`${cmd} exited ${code}`));
		});
	});
}

/** DRY_RUN only: synthesize a real N-second clip (colour bars + a tone) via ffmpeg so the
 *  import path has genuine video+audio to place and split. */
function makeSampleClip(outPath, seconds) {
	const args = [
		"-y",
		"-f", "lavfi", "-i", `color=c=0x1a73e8:s=1280x720:d=${seconds}`,
		"-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`,
		"-shortest", "-pix_fmt", "yuv420p",
		"-c:v", "libx264", "-c:a", "aac",
		outPath,
	];
	return run(FFMPEG, args, { cwd: dir }, () => {});
}

// ---- phase implementations ----------------------------------------------------------

async function generate() {
	setPhase("generating", "Generating the graphics composition...", 0);
	if (DRY_RUN) {
		for (let i = 1; i <= 5; i++) {
			bailIfCancelled();
			await sleep(600);
			job.progress = i / 5;
			log(`(dry-run) generation step ${i}/5`);
		}
		return;
	}
	// LIVE: a headless claude session in the engine project, loaded with the dan-video
	// skill, writes the composition. Uses the source.mp4 + transcript.json the API
	// already staged in the project. Tuned live (first real run signs off a proof clip
	// before any full render, per the skill).
	const prompt =
		"Load the dan-video skill and generate a Remotion graphics-overlay composition " +
		"for public/source.mp4 using public/transcript.json, per the skill. Reuse the " +
		`src/danL kit. Register the composition in src/Root.tsx with the exact id "${COMP_ID}" ` +
		"so `remotion render` can find it deterministically. Do NOT start a full render; " +
		"stop once the composition compiles.";
	await run(
		"claude",
		["-p", JSON.stringify(prompt), "--dangerously-skip-permissions"],
		{ cwd: REMOTION_DIR },
		(line) => log(`gen: ${line}`),
	);
}

async function render(kind /* "proof" | "full" */) {
	const isProof = kind === "proof";
	setPhase(isProof ? "proof-rendering" : "full-rendering",
		isProof ? "Rendering a proof clip..." : "Rendering the full video (this can take ~2 hours)...", 0);
	const outPath = path.join(dir, isProof ? "proof.mp4" : "full.mp4");
	if (DRY_RUN) {
		const total = isProof ? 15 : 40;
		for (let f = 1; f <= total; f++) {
			bailIfCancelled();
			await sleep(isProof ? 300 : 400);
			job.progress = f / total;
			if (f % 5 === 0) log(`(dry-run) ${kind} render frame ${f * 100}/${total * 100}`);
		}
		// Emit a REAL short clip (video + audio) so the timeline-import path is genuinely
		// exercised, not a fake byte blob. Falls back to a placeholder if ffmpeg is absent.
		await makeSampleClip(outPath, isProof ? 2 : 3).catch((e) => {
			log(`(dry-run) ffmpeg sample failed, writing placeholder: ${e.message}`, "warn");
			fs.writeFileSync(outPath, "dry-run placeholder");
		});
		return outPath;
	}
	// LIVE: remotion render. The generation step registered the composition under COMP_ID;
	// the proof caps frames to ~100s (30fps * 100 = 3000).
	const args = ["remotion", "render", ENTRY, COMP_ID, outPath];
	if (isProof) args.push("--frames=0-3000");
	await run("npx", args, { cwd: REMOTION_DIR }, (line) => {
		// Remotion prints "Rendered X/Y" progress; surface it.
		const m = line.match(/(\d+)\s*\/\s*(\d+)/);
		if (m) job.progress = Math.min(1, Number(m[1]) / Math.max(1, Number(m[2])));
		if (/error|failed/i.test(line)) log(`render: ${line}`, "warn");
		else if (m) writeJob();
	});
	return outPath;
}

async function waitForApproval() {
	setPhase("proof-ready", "Proof clip ready. Review it, then approve the full render.", 1);
	while (!fs.existsSync(approveFlag)) {
		bailIfCancelled();
		await sleep(1500);
	}
	log("Full render approved.");
}

async function main() {
	if (!jobId || !engine) fail("missing jobId/engine");
	fs.mkdirSync(dir, { recursive: true });
	writeJob();
	log(`Worker started (engine=${engine}, dryRun=${DRY_RUN})`);
	try {
		bailIfCancelled();
		await generate();
		bailIfCancelled();
		job.proofPath = await render("proof");
		writeJob();
		await waitForApproval();
		bailIfCancelled();
		job.fullPath = await render("full");
		setPhase("importing", "Render complete. Bringing it into the timeline...", 1);
		// The client sees fullPath + phase=importing and does the placement, then the
		// timeline holds the graphics pass. Mark done so the UI can finish.
		setPhase("done", "Done. Added to the timeline.", 1);
	} catch (e) {
		if (cancelled()) { setPhase("cancelled", "Cancelled by user"); process.exit(0); }
		fail(e);
	} finally {
		clearInterval(heartbeat);
	}
}

main();
