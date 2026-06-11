import { spawn } from "node:child_process";
import { describeTemplateCatalog, getTemplate } from "./templates/index";
import type {
	ClaudeAuth,
	EffectPlan,
	EffectPlanItem,
	TranscriptSegment,
} from "./types";

const PLAN_SCHEMA = {
	type: "object",
	properties: {
		items: {
			type: "array",
			items: {
				type: "object",
				properties: {
					templateId: { type: "string" },
					startSec: { type: "number" },
					durationSec: { type: "number" },
					variables: { type: "object", additionalProperties: true },
					reason: { type: "string" },
				},
				required: ["templateId", "startSec", "durationSec", "variables", "reason"],
				additionalProperties: false,
			},
		},
	},
	required: ["items"],
	additionalProperties: false,
} as const;

function buildPlannerPrompt({
	segments,
	totalDurationSec,
}: {
	segments: TranscriptSegment[];
	totalDurationSec: number;
}): string {
	const catalog = describeTemplateCatalog();
	const transcript = segments
		.map((s) => `[${s.start.toFixed(1)}–${s.end.toFixed(1)}] ${s.text.trim()}`)
		.join("\n");

	return `You are the motion-graphics director for a video editor. Below is the transcript of a video (${totalDurationSec.toFixed(1)}s total), with timestamps in seconds, and a catalog of overlay templates.

Pick the moments that deserve a motion-graphic overlay and plan one effect per moment.

Rules:
- Quality over quantity: roughly one effect per 10–20 seconds of video. A 60s video should get 3–6 effects, never more than 8.
- Effects must NOT overlap each other in time.
- durationSec must be within the template's min/max. Snap startSec near the start of the spoken moment it supports.
- "variables" must use exactly the variable ids the template declares. Keep all text SHORT (titles ≤ 5 words, pills ≤ 6 words). Never paraphrase numbers — copy them exactly as spoken.
- Use kinetic-title and section-break sparingly (at most one each per minute) — they take over the whole frame.
- Use the template's whenToUse guidance. If nothing in the transcript fits a template, don't use it.
- Leave the accent variable out unless a color is clearly implied; defaults are fine.

TEMPLATE CATALOG (JSON):
${JSON.stringify(catalog, null, 1)}

TRANSCRIPT:
${transcript}

Respond with ONLY a JSON object: {"items": [{"templateId", "startSec", "durationSec", "variables", "reason"}, ...]}. The "reason" is one short sentence.`;
}

function extractJson(text: string): unknown {
	const direct = text.trim();
	try {
		return JSON.parse(direct);
	} catch {
		const start = direct.indexOf("{");
		const end = direct.lastIndexOf("}");
		if (start >= 0 && end > start) {
			return JSON.parse(direct.slice(start, end + 1));
		}
		throw new Error("Planner returned no parseable JSON");
	}
}

async function planViaApiKey(prompt: string, apiKey: string): Promise<unknown> {
	const res = await fetch("https://api.anthropic.com/v1/messages", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-api-key": apiKey,
			"anthropic-version": "2023-06-01",
		},
		body: JSON.stringify({
			model: "claude-opus-4-8",
			max_tokens: 8000,
			thinking: { type: "adaptive" },
			output_config: {
				format: { type: "json_schema", schema: PLAN_SCHEMA },
			},
			messages: [{ role: "user", content: prompt }],
		}),
	});
	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Anthropic API error ${res.status}: ${body.slice(0, 500)}`);
	}
	const data = (await res.json()) as {
		content: { type: string; text?: string }[];
	};
	const text = data.content.find((b) => b.type === "text")?.text ?? "";
	return extractJson(text);
}

function planViaClaudeCode(prompt: string): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const child = spawn("claude", ["-p", "--output-format", "json"], {
			shell: true,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, NO_COLOR: "1" },
		});
		let out = "";
		let err = "";
		child.stdout.on("data", (d) => (out += d.toString()));
		child.stderr.on("data", (d) => (err += d.toString()));
		child.on("error", reject);
		child.on("close", (code) => {
			if (code !== 0) {
				reject(new Error(`claude CLI exited ${code}: ${err.slice(0, 800)}`));
				return;
			}
			try {
				const wrapper = JSON.parse(out) as { result?: string };
				const text = typeof wrapper.result === "string" ? wrapper.result : out;
				resolve(extractJson(text));
			} catch (e) {
				reject(new Error(`Could not parse claude CLI output: ${String(e)}`));
			}
		});
		child.stdin.write(prompt);
		child.stdin.end();
	});
}

/** Validates + normalizes the raw plan against the template registry. */
function sanitizePlan(raw: unknown, totalDurationSec: number): EffectPlan {
	const items = (raw as { items?: unknown[] })?.items;
	if (!Array.isArray(items)) {
		throw new Error("Plan has no items array");
	}
	const cleaned: EffectPlanItem[] = [];
	for (const entry of items) {
		const it = entry as Record<string, unknown>;
		const template = getTemplate(String(it.templateId));
		if (!template) continue;
		const startSec = Number(it.startSec);
		let durationSec = Number(it.durationSec);
		if (!Number.isFinite(startSec) || !Number.isFinite(durationSec)) continue;
		durationSec = Math.min(
			Math.max(durationSec, template.minDurationSec),
			template.maxDurationSec,
		);
		if (startSec < 0 || startSec >= totalDurationSec) continue;
		const allowedVars = new Set(template.variables.map((v) => v.id));
		const variables: EffectPlanItem["variables"] = {};
		for (const [k, v] of Object.entries(
			(it.variables as Record<string, unknown>) ?? {},
		)) {
			if (allowedVars.has(k) && ["string", "number", "boolean"].includes(typeof v)) {
				variables[k] = v as string | number | boolean;
			}
		}
		cleaned.push({
			id: `${template.id}-${cleaned.length}-${Math.round(startSec * 10)}`,
			templateId: template.id,
			startSec: Math.round(startSec * 100) / 100,
			durationSec: Math.round(durationSec * 100) / 100,
			variables,
			reason: String(it.reason ?? "").slice(0, 200),
		});
	}
	// Drop overlaps, keeping earlier items (sorted by start).
	cleaned.sort((a, b) => a.startSec - b.startSec);
	const nonOverlapping: EffectPlanItem[] = [];
	let lastEnd = -1;
	for (const item of cleaned) {
		if (item.startSec >= lastEnd) {
			nonOverlapping.push(item);
			lastEnd = item.startSec + item.durationSec;
		}
	}
	return { items: nonOverlapping.slice(0, 8) };
}

export async function planEffects({
	segments,
	totalDurationSec,
	auth,
}: {
	segments: TranscriptSegment[];
	totalDurationSec: number;
	auth: ClaudeAuth;
}): Promise<EffectPlan> {
	if (!segments.length) {
		return { items: [] };
	}
	const prompt = buildPlannerPrompt({ segments, totalDurationSec });
	const raw =
		auth.mode === "api-key"
			? await planViaApiKey(prompt, auth.apiKey)
			: await planViaClaudeCode(prompt);
	return sanitizePlan(raw, totalDurationSec);
}
