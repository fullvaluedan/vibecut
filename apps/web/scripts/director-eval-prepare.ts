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
 * Writes eval-fixtures/tutorial-01.json (gitignored — Dan's content stays
 * local), ready for: bun scripts/director-eval.ts
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
		{ stdio: "pipe", shell: process.platform === "win32" },
	);
	if (result.status !== 0 || !fs.existsSync(outPath)) {
		throw new Error(
			`ffmpeg failed on ${videoPath}:\n${result.stderr?.toString().slice(-400)}`,
		);
	}
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
	if (!res.ok) {
		throw new Error(`Groq ${res.status}: ${(await res.text()).slice(0, 400)}`);
	}
	const data = (await res.json()) as {
		words?: GroqWord[];
		segments?: GroqSegment[];
	};
	if (!data.words || data.words.length === 0) {
		throw new Error(
			"Groq returned no word timestamps — is the audio silent or the file corrupt?",
		);
	}
	return { words: data.words, segments: data.segments ?? [] };
}

async function main(): Promise<void> {
	const rawPath = arg("raw");
	const finalPath = arg("final");
	const apiKey = arg("key") ?? process.env.GROQ_API_KEY;
	if (!rawPath || !finalPath) {
		console.error(
			'Usage: GROQ_API_KEY=gsk_... bun scripts/director-eval-prepare.ts --raw "<raw.mp4>" --final "<final.mp4>" [--name x] [--out dir]',
		);
		process.exit(2);
	}
	if (!apiKey) {
		console.error(
			"Set GROQ_API_KEY (console.groq.com -> API keys, free tier works) or pass --key.",
		);
		process.exit(2);
	}
	for (const p of [rawPath, finalPath]) {
		if (!fs.existsSync(p)) {
			console.error(`File not found: ${p}`);
			process.exit(2);
		}
	}

	const name =
		arg("name") ?? path.basename(rawPath).replace(/\.[^.]+$/, "");
	const outDir = path.resolve(arg("out") ?? "eval-fixtures");
	fs.mkdirSync(outDir, { recursive: true });
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "director-eval-"));

	try {
		console.log(`[1/4] extracting audio from raw: ${rawPath}`);
		const rawAudio = path.join(tmp, "raw.ogg");
		extractAudio(rawPath, rawAudio);

		console.log(`[2/4] extracting audio from final: ${finalPath}`);
		const finalAudio = path.join(tmp, "final.ogg");
		extractAudio(finalPath, finalAudio);

		console.log("[3/4] transcribing raw (Groq whisper-large-v3)...");
		const raw = await transcribe(rawAudio, apiKey);
		console.log(
			`      ${raw.words.length} words, ${raw.segments.length} segments`,
		);

		console.log("[4/4] transcribing final...");
		const finalT = await transcribe(finalAudio, apiKey);
		console.log(`      ${finalT.words.length} words`);

		const fixture = {
			name,
			rawWords: raw.words.map((w) => ({
				text: w.word,
				start: w.start,
				end: w.end,
			})),
			finalWords: finalT.words.map((w) => ({
				text: w.word,
				start: w.start,
				end: w.end,
			})),
			rawSegments: raw.segments.map((s) => ({
				text: s.text.trim(),
				start: s.start,
				end: s.end,
			})),
		};
		const outPath = path.join(outDir, `${name}.json`);
		fs.writeFileSync(outPath, JSON.stringify(fixture));
		console.log(`\nFixture written: ${outPath}`);
		console.log(`Score it with:   bun scripts/director-eval.ts`);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

void main().catch((e) => {
	console.error(e instanceof Error ? e.message : e);
	process.exit(1);
});
