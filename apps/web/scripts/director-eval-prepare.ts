/**
 * Golden-footage fixture prep (EV4): turn a raw/final video pair into an eval
 * fixture JSON. Audio is extracted locally with ffmpeg (16kHz mono opus, ~5MB
 * per hour) and transcribed word-level by Groq whisper-large-v3 — the highest
 * quality transcript available to us, which is exactly what ground-truth
 * labels should be built from. No video ever leaves the machine, only the
 * compressed audio goes to Groq (same as the app's cloud-transcription path).
 *
 *   cd apps/web
 *   GROQ_API_KEY=gsk_... bun scripts/director-eval-prepare.ts \
 *     --raw "D:\footage\tutorial-raw.mp4" \
 *     --final "D:\exports\tutorial-final.mp4" \
 *     --name tutorial-01
 *
 * Dan's real projects are a FOLDER of OBS clips, not one file — pass the
 * folder and every .mp4 in it (sorted by name = filming order) becomes one
 * concatenated raw timeline with offset timestamps:
 *
 *   bun scripts/director-eval-prepare.ts \
 *     --raw-dir "C:\Users\danom\Videos\0708 Google Omni" \
 *     --final "D:\Hermes\remotion-v2\public\google-omni.mp4" \
 *     --name google-omni
 *
 * Writes eval-fixtures/<name>.json (gitignored — Dan's content stays local),
 * ready for: bun scripts/director-eval.ts
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

function extractAudio(videoPath: string, outPath: string): void {
	const ffmpeg = process.env.FFMPEG ?? "ffmpeg";
	const result = spawnSync(
		ffmpeg,
		[
			"-y", "-i", videoPath,
			"-vn", "-ac", "1", "-ar", "16000",
			"-c:a", "libopus", "-b:a", "12k",
			outPath,
		],
		{ stdio: "pipe" },
	);
	if (result.status !== 0 || !fs.existsSync(outPath)) {
		throw new Error(
			`ffmpeg failed on ${videoPath}:\n${result.stderr?.toString().slice(-400)}`,
		);
	}
}

/** Media duration in seconds via ffprobe (lives next to ffmpeg). */
function mediaDuration(mediaPath: string): number {
	const ffmpeg = process.env.FFMPEG ?? "ffmpeg";
	const ffprobe =
		process.env.FFPROBE ?? ffmpeg.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");
	const result = spawnSync(
		ffprobe,
		[
			"-v", "error",
			"-show_entries", "format=duration",
			"-of", "csv=p=0",
			mediaPath,
		],
		{ stdio: "pipe" },
	);
	const seconds = Number.parseFloat(result.stdout?.toString().trim() ?? "");
	if (!Number.isFinite(seconds)) {
		throw new Error(`ffprobe could not read duration of ${mediaPath}`);
	}
	return seconds;
}

interface GroqWord {
	word: string;
	start: number;
	end: number;
}
interface GroqSegment {
	text: string;
	start: number;
	end: number;
}

async function transcribe(
	audioPath: string,
	apiKey: string,
): Promise<{ words: GroqWord[]; segments: GroqSegment[] }> {
	for (let attempt = 1; ; attempt++) {
		const form = new FormData();
		form.append(
			"file",
			new Blob([fs.readFileSync(audioPath)]),
			path.basename(audioPath),
		);
		form.append("model", "whisper-large-v3");
		form.append("response_format", "verbose_json");
		form.append("timestamp_granularities[]", "word");
		form.append("timestamp_granularities[]", "segment");

		const res = await fetch(GROQ_URL, {
			method: "POST",
			headers: { authorization: `Bearer ${apiKey}` },
			body: form,
		});
		if (res.status === 429 && attempt <= 4) {
			const wait = Number(res.headers.get("retry-after")) || 15;
			console.log(`      rate limited, retrying in ${wait}s...`);
			await new Promise((r) => setTimeout(r, wait * 1000));
			continue;
		}
		if (!res.ok) {
			throw new Error(
				`Groq ${res.status}: ${(await res.text()).slice(0, 400)}`,
			);
		}
		const data = (await res.json()) as {
			words?: GroqWord[];
			segments?: GroqSegment[];
		};
		if (!data.words || data.words.length === 0) {
			throw new Error(
				`Groq returned no word timestamps for ${path.basename(audioPath)} — silent or corrupt audio?`,
			);
		}
		return { words: data.words, segments: data.segments ?? [] };
	}
}

/** Extract + transcribe ONE media file, timestamps offset by `offsetSec`. */
async function transcribeMedia(
	mediaPath: string,
	tmpDir: string,
	apiKey: string,
	offsetSec: number,
): Promise<{ words: GroqWord[]; segments: GroqSegment[] }> {
	const audioPath = path.join(
		tmpDir,
		`${path.basename(mediaPath).replace(/[^\w.-]+/g, "_")}.ogg`,
	);
	extractAudio(mediaPath, audioPath);
	const t = await transcribe(audioPath, apiKey);
	fs.rmSync(audioPath, { force: true });
	return {
		words: t.words.map((w) => ({
			...w,
			start: w.start + offsetSec,
			end: w.end + offsetSec,
		})),
		segments: t.segments.map((s) => ({
			...s,
			start: s.start + offsetSec,
			end: s.end + offsetSec,
		})),
	};
}

async function main(): Promise<void> {
	const rawPath = arg("raw");
	const rawDir = arg("raw-dir");
	const finalPath = arg("final");
	const apiKey = arg("key") ?? process.env.GROQ_API_KEY;
	if ((!rawPath && !rawDir) || !finalPath) {
		console.error(
			'Usage: GROQ_API_KEY=gsk_... bun scripts/director-eval-prepare.ts (--raw "<raw.mp4>" | --raw-dir "<folder of clips>") --final "<final.mp4>" [--name x] [--out dir]',
		);
		process.exit(2);
	}
	if (!apiKey) {
		console.error(
			"Set GROQ_API_KEY (console.groq.com -> API keys, free tier works) or pass --key.",
		);
		process.exit(2);
	}

	// One raw file, or a folder of clips sorted by name (= filming order for
	// OBS timestamps) concatenated into one raw timeline.
	const rawFiles: string[] = [];
	if (rawDir) {
		if (!fs.existsSync(rawDir)) {
			console.error(`Folder not found: ${rawDir}`);
			process.exit(2);
		}
		rawFiles.push(
			...fs
				.readdirSync(rawDir)
				.filter((f) => /\.(mp4|mov|mkv|webm)$/i.test(f))
				.sort()
				.map((f) => path.join(rawDir, f)),
		);
		if (rawFiles.length === 0) {
			console.error(`No video files in ${rawDir}`);
			process.exit(2);
		}
	} else {
		rawFiles.push(rawPath!);
	}
	for (const p of [...rawFiles, finalPath]) {
		if (!fs.existsSync(p)) {
			console.error(`File not found: ${p}`);
			process.exit(2);
		}
	}

	const name =
		arg("name") ??
		path.basename(rawDir ?? rawFiles[0]).replace(/\.[^.]+$/, "");
	const outDir = path.resolve(arg("out") ?? "eval-fixtures");
	fs.mkdirSync(outDir, { recursive: true });
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "director-eval-"));

	try {
		const rawWords: GroqWord[] = [];
		const rawSegments: GroqSegment[] = [];
		let offset = 0;
		for (let i = 0; i < rawFiles.length; i++) {
			const file = rawFiles[i];
			console.log(
				`[raw ${i + 1}/${rawFiles.length}] ${path.basename(file)} (offset ${offset.toFixed(0)}s)`,
			);
			const t = await transcribeMedia(file, tmp, apiKey, offset);
			rawWords.push(...t.words);
			rawSegments.push(...t.segments);
			console.log(`      ${t.words.length} words`);
			offset += mediaDuration(file);
		}

		console.log(`[final] ${path.basename(finalPath)}`);
		const finalT = await transcribeMedia(finalPath, tmp, apiKey, 0);
		console.log(`      ${finalT.words.length} words`);

		const fixture = {
			name,
			rawWords: rawWords.map((w) => ({
				text: w.word,
				start: w.start,
				end: w.end,
			})),
			finalWords: finalT.words.map((w) => ({
				text: w.word,
				start: w.start,
				end: w.end,
			})),
			rawSegments: rawSegments.map((s) => ({
				text: s.text.trim(),
				start: s.start,
				end: s.end,
			})),
		};
		const outPath = path.join(outDir, `${name}.json`);
		fs.writeFileSync(outPath, JSON.stringify(fixture));
		console.log(
			`\nFixture written: ${outPath} (${rawWords.length} raw words / ${finalT.words.length} final words)`,
		);
		console.log(`Score it with:   bun scripts/director-eval.ts`);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

void main().catch((e) => {
	console.error(e instanceof Error ? e.message : e);
	process.exit(1);
});
