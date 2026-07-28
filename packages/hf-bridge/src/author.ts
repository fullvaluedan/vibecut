import { spawn } from "node:child_process";
import { isIP } from "node:net";
import { describeTemplateCatalog, getTemplate } from "./templates/index";
import { resolveClaude } from "./renderer";
import { stableOpId } from "./stable-op-id";
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

export interface TokenUsage {
	inputTokens: number;
	outputTokens: number;
}

/** Map an Anthropic `usage` object to our TokenUsage (null when absent). */
function normalizeAnthropicUsage(
	usage: { input_tokens?: number; output_tokens?: number } | undefined,
): TokenUsage | null {
	return usage
		? { inputTokens: usage.input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0 }
		: null;
}

/** Map an OpenAI-compatible `usage` object to our TokenUsage (null when absent). */
function normalizeOpenAiUsage(
	usage: { prompt_tokens?: number; completion_tokens?: number } | undefined,
): TokenUsage | null {
	return usage
		? {
				inputTokens: usage.prompt_tokens ?? 0,
				outputTokens: usage.completion_tokens ?? 0,
			}
		: null;
}

function buildPreferencesBlock(preferences?: string[]): string {
	if (!preferences?.length) return "";
	return `\nUSER PREFERENCES (learned from this user's past edits — respect them):\n${preferences
		.map((p) => `- ${p}`)
		.join("\n")}\n`;
}

function buildPlannerPrompt({
	segments,
	totalDurationSec,
	allowedTemplateIds,
	direction,
	preferences,
	look,
}: {
	segments: TranscriptSegment[];
	totalDurationSec: number;
	allowedTemplateIds?: string[];
	direction?: string;
	preferences?: string[];
	look?: { name: string; description: string };
}): string {
	let catalog = describeTemplateCatalog();
	if (allowedTemplateIds?.length) {
		const allowed = new Set(allowedTemplateIds);
		const filtered = catalog.filter((t) => allowed.has(t.id));
		if (filtered.length) catalog = filtered;
	}
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
${
	look?.name
		? `\nVISUAL LOOK: "${look.name}" — ${look.description}. Favor templates and pacing that fit this aesthetic (e.g. an editorial/documentary look prefers section-breaks + lower-thirds and slower, restrained effects; a loud/high-energy look leans on number-pops and kinetic titles).\n`
		: ""
}${buildPreferencesBlock(preferences)}${
	direction?.trim()
		? `\nUSER DIRECTION (the editor's own instructions — follow them even when they override the rules above):\n${direction.trim()}\n`
		: ""
}
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

async function planViaApiKeySchema(
	prompt: string,
	apiKey: string,
	schema: object,
): Promise<{ raw: unknown; usage: TokenUsage | null }> {
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
				format: { type: "json_schema", schema },
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
		usage?: { input_tokens?: number; output_tokens?: number };
	};
	const text = data.content?.find((b) => b.type === "text")?.text ?? "";
	const usage = normalizeAnthropicUsage(data.usage);
	return { raw: extractJson(text), usage };
}

/** Kill leash for the claude-code CLI spawn (round 12 U3/R4): a wedged CLI (a
 * hung network call, a login prompt waiting on a terminal that isn't there)
 * previously kept the child - and the whole Director run - alive forever. On
 * expiry the child is killed and the plan call rejects with a plain message. */
const CLAUDE_CLI_KILL_TIMEOUT_MS = 300_000;

/** Pure branch decision for the kill timer below, split out so it is
 * unit-testable without actually spawning anything. On Windows the CLI runs
 * through `shell: true` (resolveClaude in renderer.ts needs the shell to
 * resolve the bare `claude` command's `.cmd` shim via PATHEXT), which means
 * the spawned pid is cmd.exe, not the real claude/node process underneath
 * it. A plain `child.kill()` only reaps that cmd.exe wrapper and orphans the
 * real process, which keeps running the hung call. So on Windows we walk and
 * kill the whole process tree by pid instead. */
export function shouldTaskkillOnTimeout({
	platform,
	pid,
}: {
	platform: NodeJS.Platform;
	pid: number | undefined;
}): boolean {
	return platform === "win32" && pid != null;
}

function planViaClaudeCode(
	prompt: string,
): Promise<{ raw: unknown; usage: TokenUsage | null }> {
	return new Promise((resolve, reject) => {
		const { command, useShell } = resolveClaude();
		const child = spawn(command, ["-p", "--output-format", "json"], {
			shell: useShell,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, NO_COLOR: "1" },
		});
		let out = "";
		let err = "";
		// Kill timer (round 12 U3/R4, tree-kill added later): reject FIRST (so
		// the caller fails with the real reason, not a generic exit-code message
		// from the kill's close event), then kill the child. `timedOut` makes the
		// close handler a no-op after.
		let timedOut = false;
		const killTimer = setTimeout(() => {
			timedOut = true;
			reject(
				new Error(
					`The claude CLI did not respond within ${CLAUDE_CLI_KILL_TIMEOUT_MS / 60_000} minutes and was stopped. Check that the CLI works (run \`claude\` in a terminal), or switch Settings -> AI to an Anthropic API key.`,
				),
			);
			if (shouldTaskkillOnTimeout({ platform: process.platform, pid: child.pid })) {
				// Fire-and-forget: we already rejected above, so this is best-effort
				// cleanup and must never itself throw or reject anything.
				try {
					spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"]).on(
						"error",
						() => {},
					);
				} catch {
					child.kill();
				}
			} else {
				child.kill();
			}
		}, CLAUDE_CLI_KILL_TIMEOUT_MS);
		child.stdout.on("data", (d) => (out += d.toString()));
		child.stderr.on("data", (d) => (err += d.toString()));
		child.on("error", (e) => {
			clearTimeout(killTimer);
			reject(e);
		});
		child.on("close", (code) => {
			clearTimeout(killTimer);
			if (timedOut) return; // already rejected; this close came from the kill
			// claude-code `--output-format json` reports API/auth errors in the STDOUT
			// JSON (`is_error` / `api_error_status` / `result`) — typically with a
			// NON-zero exit and EMPTY stderr. Parse stdout FIRST so we surface the real
			// reason (e.g. a 401 auth failure) instead of a bare "exited 1:".
			let wrapper: {
				result?: string;
				is_error?: boolean;
				api_error_status?: number;
				usage?: { input_tokens?: number; output_tokens?: number };
			} | null = null;
			try {
				wrapper = JSON.parse(out);
			} catch {
				wrapper = null;
			}

			if (wrapper?.is_error === true) {
				const status = wrapper.api_error_status;
				const detail =
					typeof wrapper.result === "string"
						? wrapper.result
						: `claude CLI error (exit ${code})`;
				const authHint =
					status === 401 || /authenticat|invalid auth|credential/i.test(detail)
						? " — the claude CLI is not signed in. Run `claude setup-token` (or `claude` then /login) in a terminal, or switch Settings → AI to an Anthropic API key."
						: "";
				reject(
					new Error(
						`Claude planning failed${status ? ` (API ${status})` : ""}: ${detail}${authHint}`,
					),
				);
				return;
			}

			if (code !== 0) {
				// A wiped/missing CLI binary surfaces as "not recognized"/ENOENT — point
				// at the escape hatch rather than a cryptic shell error.
				const hint = /not recognized|ENOENT|not found|cannot find/i.test(err)
					? " — the claude CLI isn't runnable (a failed update may have wiped its binary). Set FRAMECUT_CLAUDE to a working claude path, or restore the CLI."
					: "";
				reject(new Error(`claude CLI exited ${code}: ${err.slice(0, 800)}${hint}`));
				return;
			}

			try {
				const text =
					typeof wrapper?.result === "string" ? wrapper.result : out;
				const usage = normalizeAnthropicUsage(wrapper?.usage);
				resolve({ raw: extractJson(text), usage });
			} catch (e) {
				reject(new Error(`Could not parse claude CLI output: ${String(e)}`));
			}
		});
		child.stdin.write(prompt);
		child.stdin.end();
	});
}

/** OpenAI-compatible chat-completions URL from a user-supplied base URL. */
export function customChatUrl(baseUrl: string): string {
	return baseUrl.replace(/\/+$/, "") + "/chat/completions";
}

/**
 * Plan via a user-supplied OpenAI-compatible endpoint (Ollama, LM Studio, a
 * self-hosted model, etc.). Asks for JSON via response_format where supported;
 * extractJson is the fallback for servers that ignore it.
 */
async function planViaCustomSchema(
	prompt: string,
	conn: { baseUrl: string; apiKey?: string; model: string },
): Promise<{ raw: unknown; usage: TokenUsage | null }> {
	const res = await fetch(customChatUrl(conn.baseUrl), {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(conn.apiKey ? { authorization: `Bearer ${conn.apiKey}` } : {}),
		},
		body: JSON.stringify({
			model: conn.model,
			messages: [{ role: "user", content: prompt }],
			temperature: 0.4,
			response_format: { type: "json_object" },
		}),
	});
	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Custom model error ${res.status}: ${body.slice(0, 500)}`);
	}
	const data = (await res.json()) as {
		choices?: { message?: { content?: string } }[];
		usage?: { prompt_tokens?: number; completion_tokens?: number };
	};
	const text = data.choices?.[0]?.message?.content ?? "";
	const usage = normalizeOpenAiUsage(data.usage);
	return { raw: extractJson(text), usage };
}

/** Route a schema-constrained JSON ask to the connected backend. */
function planDispatch(
	prompt: string,
	auth: ClaudeAuth,
	schema: object,
): Promise<{ raw: unknown; usage: TokenUsage | null }> {
	switch (auth.mode) {
		case "api-key":
			return planViaApiKeySchema(prompt, auth.apiKey, schema);
		case "custom":
			return planViaCustomSchema(prompt, auth);
		default:
			return planViaClaudeCode(prompt);
	}
}

/** Validates + normalizes the raw plan against the template registry. */
function sanitizePlan(
	raw: unknown,
	totalDurationSec: number,
	allowedTemplateIds?: string[],
): EffectPlan {
	const items = (raw as { items?: unknown[] })?.items;
	if (!Array.isArray(items)) {
		throw new Error("Plan has no items array");
	}
	const allowed = allowedTemplateIds?.length
		? new Set(allowedTemplateIds)
		: null;
	const cleaned: EffectPlanItem[] = [];
	for (const entry of items) {
		const it = entry as Record<string, unknown>;
		const template = getTemplate(String(it.templateId));
		if (!template) continue;
		if (allowed && !allowed.has(template.id)) continue;
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

/**
 * Generic schema-constrained Claude call — same auth paths as the planners.
 * Used by the assistant prompt box and any future one-shot JSON asks.
 */
export async function planJson({
	prompt,
	auth,
	schema,
}: {
	prompt: string;
	auth: ClaudeAuth;
	schema: object;
}): Promise<{ raw: unknown; usage: TokenUsage | null }> {
	return planDispatch(prompt, auth, schema);
}

// --- Director planner (v0: text+audio typed-op plan) ---
//
// The Director fuses the transcript with audio features (energy/wpm/filler),
// silence, and source-clip mapping into a per-segment signal table, then emits a
// typed-op plan the editor reviews before applying. Text-only (no frames) so it
// runs on every auth mode; the prompt mixes a Markdown reasoning table with a
// strict JSON output block. Mirrors the cuts planner above.

export type DirectorOpKind = "cut" | "keep" | "reorder" | "take_select";

/** What KIND of cut this is, for per-category taste learning. Client-assigned by
 * the deterministic detectors; absent on raw LLM ops (which default by op kind). */
export type DirectorOpCategory =
	| "duplicate"
	| "filler"
	| "pacing"
	| "reorder"
	| "take"
	| "llm"
	| "vision"
	| "repeat"
	| "deadair"
	| "noise"
	| "redundancy"
	| "context"
	| "retake"
	| "structural"
	| "speculation"
	| "join";

/** One reviewed operation. `cut`/`take_select` REMOVE [startSec,endSec); `reorder` MOVES it to `targetStartSec`; `keep` is informational. */
export interface DirectorOp {
	/** Stable id (hash of op|start|end|target) — survives re-planning of the same output. */
	id: string;
	op: DirectorOpKind;
	startSec: number;
	endSec: number;
	reason: string;
	/** Planner's confidence, 0..1. */
	confidence: number;
	/** `reorder` only: timeline-seconds destination the span should move to. */
	targetStartSec?: number;
	/** Cut category for taste learning (client-assigned; absent on raw LLM ops). */
	category?: DirectorOpCategory;
	/**
	 * For `redundancy` cuts: the id of the redundancy GROUP this take belongs to
	 * (client-assigned). Lets the review panel offer swap-to-alternate — picking a
	 * different keeper rebuilds exactly this group's cut ops. Absent on every other op.
	 */
	groupId?: string;
	/**
	 * Whether this op starts ACCEPTED in the review (client-assigned). Absent or
	 * `true` = accepted by default (the user opts out); `false` = surfaced as an
	 * opt-in row that starts unchecked, so higher-recall / lower-confidence
	 * candidates are never auto-applied.
	 */
	defaultAccept?: boolean;
}

export interface DirectorPlan {
	operations: DirectorOp[];
}

/** One fused-signal row the planner reasons over (built web-side from the audio + source-map features). */
export interface DirectorSegment {
	startSec: number;
	endSec: number;
	text: string;
	/** Source asset id under this segment (for take comparison); absent over a gap. */
	assetId?: string;
	/** Mean RMS energy (file-relative scale). */
	energy?: number;
	/** Energy as a fraction of the loudest segment, 0..1. */
	loudnessRelative?: number;
	/** Speaking rate (words/min). */
	wpm?: number;
	/** True when the segment reads as filler/false-start. */
	fillerCandidate?: boolean;
	/** Seconds of silence immediately before this segment. */
	silenceBeforeSec?: number;
	/** Take-cluster id when this row is an alternate take/restatement already flagged for de-dup. */
	clusterId?: string;
	/** Emphasis/anchor importance score 0..1 (keep-side); absent on cut-only runs. */
	importance?: number;
}

/** One source-clip summary the planner reads above the signal table (the asset catalog). */
export interface DirectorAssetSummary {
	name: string;
	durationSec: number;
	segmentCount: number;
	firstLine: string;
	lastLine: string;
}

const DIRECTOR_SCHEMA = {
	type: "object",
	properties: {
		operations: {
			type: "array",
			items: {
				type: "object",
				properties: {
					op: { type: "string", enum: ["cut", "keep", "reorder", "take_select"] },
					startSec: { type: "number" },
					endSec: { type: "number" },
					reason: { type: "string" },
					confidence: { type: "number" },
					targetStartSec: { type: "number" },
					kind: { type: "string", enum: ["speculation"] },
				},
				required: ["op", "startSec", "endSec", "reason", "confidence"],
				additionalProperties: false,
			},
		},
	},
	required: ["operations"],
	additionalProperties: false,
} as const;

/** Re-export the deterministic op-id hash for the barrel. The implementation lives
 * in ./stable-op-id (a dependency-free leaf) so client code can import it without
 * pulling this module's node:child_process graph. Used internally at planOps below. */
export { stableOpId };

/**
 * Render the per-segment signal table the planner reasons over (pipe-escaped).
 * Optional columns are added ONLY when a segment carries the field: "grp" (take
 * cluster) and "imp" (keep-side importance). With neither present the table is
 * byte-identical to the original cut-only table.
 */
export function renderSignalTable(segments: readonly DirectorSegment[]): string {
	const hasClusters = segments.some((s) => s.clusterId !== undefined);
	const hasImportance = segments.some((s) => s.importance !== undefined);

	const headers = ["time (s)", "src"];
	if (hasClusters) headers.push("grp");
	if (hasImportance) headers.push("imp");
	headers.push("text", "loudness", "wpm", "filler", "silence(s)");
	const header = `| ${headers.join(" | ")} |\n|${headers.map(() => "---").join("|")}|`;

	const rows = segments.map((s) => {
		const cells = [`${s.startSec.toFixed(1)}-${s.endSec.toFixed(1)}`, s.assetId ? s.assetId.slice(0, 6) : "-"];
		if (hasClusters) cells.push(s.clusterId ?? "-");
		if (hasImportance) cells.push(s.importance !== undefined ? s.importance.toFixed(2) : "-");
		cells.push(
			s.text.trim().replace(/\|/g, "/").slice(0, 120) || "-",
			s.loudnessRelative !== undefined ? s.loudnessRelative.toFixed(2) : (s.energy?.toFixed(3) ?? "-"),
			s.wpm !== undefined ? String(Math.round(s.wpm)) : "-",
			s.fillerCandidate ? "yes" : "-",
			s.silenceBeforeSec !== undefined ? s.silenceBeforeSec.toFixed(1) : "-",
		);
		return `| ${cells.join(" | ")} |`;
	});
	return [header, ...rows].join("\n");
}

/**
 * Render the asset catalog block — a one-line summary per source clip — that sits
 * above the signal table so the planner knows what footage it is cutting (clip
 * name, length, line count, and how each clip opens/closes).
 */
export function renderAssetCatalog(catalog: readonly DirectorAssetSummary[]): string {
	const lines = catalog.map(
		(a, i) =>
			`- Clip ${i + 1}: "${a.name}" (${a.durationSec.toFixed(1)}s, ${a.segmentCount} lines) — opens "${a.firstLine}"${a.lastLine && a.lastLine !== a.firstLine ? ` … closes "${a.lastLine}"` : ""}`,
	);
	return `ASSET CATALOG (the source clips assembled into this timeline):\n${lines.join("\n")}`;
}

/** Clamp a compression target to the sane band (fraction of words to REMOVE). A
 * value at/above 0.8 would license gutting the video; below 0 is meaningless. */
export const MAX_COMPRESSION_TARGET = 0.8;
export function clampCompressionTarget(target: number): number {
	return Math.max(0, Math.min(MAX_COMPRESSION_TARGET, target));
}

/**
 * Version of the Director plan prompt below. The eval cache keys on pass INPUT
 * only, so ANY wording change here must bump this constant; it rides the eval
 * payload (the VERIFY_PROMPT_VERSION precedent) or the eval silently replays
 * stale cached plans. v2: trailing-speculation tagging (round 9) - coherent
 * trailing musing arrives as "kind":"speculation" and is kept by default.
 */
export const DIRECTOR_PROMPT_VERSION = 2;

/**
 * Version of the SECOND-PASS preamble below (round 14 U1). The multi-pass Director
 * re-reads the ASSEMBLED result of its own first cut and hunts residual dead weight
 * / repeats; that re-read reuses this plan pass with an extra preamble, so a wording
 * change to the preamble must bump THIS constant (the eval threads it into the plan
 * cache key alongside DIRECTOR_PROMPT_VERSION, the VERIFY_PROMPT_VERSION precedent).
 * The base prompt below is shared, so DIRECTOR_PROMPT_VERSION still governs it. */
export const DIRECTOR_P2_PROMPT_VERSION = 1;

export function buildDirectorPrompt({
	segments,
	totalSec,
	taste,
	catalog,
	compressionTarget,
	secondPass,
}: {
	segments: readonly DirectorSegment[];
	totalSec: number;
	/** Compact learned-taste note injected from the user's past reviews. */
	taste?: string;
	/** Per-clip summary block; rendered only for multi-clip input. */
	catalog?: readonly DirectorAssetSummary[];
	/** Fraction of words this creator typically REMOVES (0..0.8). When present, the
	 * prompt gains an explicit compression contract; absent = byte-identical prompt. */
	compressionTarget?: number;
	/** Round 14 U1: when true this is the SECOND cut, reading the already-tightened
	 * assembled result. Prepends a preamble that reframes the task as hunting the
	 * dead weight / repeats the first cut left behind. Absent = byte-identical prompt. */
	secondPass?: boolean;
}): string {
	const hasClusters = segments.some((s) => s.clusterId !== undefined);
	const hasImportance = segments.some((s) => s.importance !== undefined);
	const catalogBlock =
		catalog && catalog.length >= 2 ? `${renderAssetCatalog(catalog)}\n\n` : "";
	const clusterRule = hasClusters
		? `\n- Rows sharing a "grp" id are alternate takes/restatements of the same line that the editor has ALREADY flagged for de-duplication — do NOT emit "cut" or "take_select" for grp rows; they are handled. Apply your own judgment only to redundancy NOT marked with a grp (e.g. the same point paraphrased in different words).`
		: "";
	const importanceRule = hasImportance
		? `\n- Each row has an "imp" score (0-1): a deterministic emphasis/anchor signal (loudness + steady delivery + content density). Lean toward KEEPING high-imp rows and cutting low-imp ones when trimming for pace — but imp measures EMPHASIS, not meaning, so never cut a load-bearing line just because its imp is low.`
		: "";
	const keepRule = hasImportance
		? `\n- Emit "keep" ops on the genuinely LOAD-BEARING spans — the thesis, the payoff, a landed joke, a surprising or pivotal line — ESPECIALLY ones the imp score underrates (a quiet but important moment imp can't detect). A "keep" op protects that span from removal; it never deletes anything.`
		: "";
	// Compression contract (U3/KTD4): when the caller supplies a measured removal
	// ratio, license whole-tangent/section drops at that aggressiveness. Conditional
	// and appended beside the taste note — absent field ⇒ byte-identical prompt.
	const compressionBlock =
		compressionTarget !== undefined && Number.isFinite(compressionTarget)
			? `\nCOMPRESSION TARGET: This creator's finished cuts remove roughly ${Math.round(
					clampCompressionTarget(compressionTarget) * 100,
				)}% of the raw spoken words. Match that ruthlessness: drop WHOLE tangents, abandoned threads, and entire low-value sections that don't serve the core point — not just word-level trims. Aim near that removal ratio rather than a timid handful of cuts. The editor reviews every cut and restores anything you over-reached, so UNDER-cutting (leaving the video bloated) wastes their time more than over-cutting.\n`
			: "";
	// Second-pass preamble (round 14 U1): this is the SECOND read, over the result
	// of the first cut already applied. The transcript below is what the video reads
	// like now - shorter and cleaner - so far-apart repeats have become adjacent and
	// leftover dead weight stands out. The task is the residue the first pass missed,
	// not a fresh full edit. Absent field => byte-identical prompt (DIRECTOR_PROMPT_VERSION).
	const secondPassBlock = secondPass
		? `SECOND PASS - you are re-reading a cut that has ALREADY been tightened once. The signal table below is the ASSEMBLED result: the silences, fillers, and obvious repeats the first pass caught are GONE, and the remaining lines now sit next to each other. Your job is the residue the first pass missed: repeats or restatements that only became adjacent once the material between them was cut, dead weight and tangents that now stand out against the tighter cut, and any stalling the first read left in. Do NOT re-cut what is already tight - propose only genuine remaining removals. Finding nothing more is a fine answer (return an empty operations list).\n\n`
		: "";
	return `${secondPassBlock}You are an expert video DIRECTOR editing a talking-head recording into a tight, high-retention cut. Below is a per-segment SIGNAL TABLE in timeline seconds: the transcript plus audio loudness (0-1, relative to the loudest segment), speaking rate (wpm), filler likelihood, leading silence, and which SOURCE CLIP (src) each line came from.

${catalogBlock}Emit a plan of typed OPERATIONS:
- "cut": remove a span [startSec,endSec) - stutters/false-starts, contentless filler runs, OFF-TOPIC TANGENTS (a detour that doesn't serve the video's core point - e.g. troubleshooting an unrelated issue, a side-story that goes nowhere), dead-weight intros/outros, and DEAD TIME where the speaker isn't advancing the point: long fumbling / "let me just..." while figuring something out, silently sitting, drinking or sipping water, fiddling with gear, checking notes, or reaching off-camera. When in doubt about a low-value stretch, CUT it - the editor reviews and can keep any cut they disagree with, so being too timid (leaving boring footage in) wastes their time more than being too aggressive. Do NOT cut for redundancy here - retakes, restarts, and repeated/restated points are handled by a separate dedicated pass; pacing beats completeness. TRAILING SPECULATION EXCEPTION: when the speaker muses about implications, predictions, or future plans AFTER the point has already landed, AND that musing is coherent (complete deliberate sentences, not fumbling), still emit the cut but add "kind":"speculation" - this editor deliberately keeps that style, so tagged cuts are offered unchecked instead of auto-applied. Incoherent rambling, abandoned threads, and trailing dead time are plain cuts, never "speculation".
- "take_select": ONLY when two DIFFERENT source clips (different src in the table) cover the SAME scripted line - the transcript text must be NEAR-IDENTICAL, not merely the same topic. Keep the stronger take (higher loudness, steadier wpm, fewer fillers); the op's [startSec,endSec) is the WEAKER take to REMOVE. If the wording differs or you are not sure they are the same line, do NOT take_select - a wrong merge deletes real content. Single-take footage has nothing to take_select - that is fine.
- "reorder": move a strong hook line earlier - [startSec,endSec) is the span to move and targetStartSec is where it should land. Use sparingly, only for a clear hook-to-front win.
- "keep": optionally mark a load-bearing span you deliberately kept.

Rules:
- Pacing beats completeness, but NEVER cut content the video's point depends on. Keep the speaker's personality; only cut what stalls the video.
- Boundaries must align with the segment timestamps. Total duration is ${totalSec.toFixed(2)}s; every startSec/endSec/targetStartSec must be within [0, ${totalSec.toFixed(2)}].
- confidence is 0..1 - be honest. If there is nothing to do, return an empty operations list.${clusterRule}${importanceRule}${keepRule}

SIGNAL TABLE:
${renderSignalTable(segments)}
${taste ? `\nEDITOR TASTE (learned from this user's past reviews - respect it):\n${taste}\n` : ""}${compressionBlock}
Respond with ONLY JSON: {"operations":[{"op","startSec","endSec","reason","confidence","targetStartSec"(reorder only),"kind"(coherent trailing speculation only)}, ...]}.`;
}

/**
 * Validate + normalize a raw Director plan: enforce start<end within [0,total],
 * sort, drop overlapping REMOVALS (cut/take_select), drop reorders with an
 * out-of-bounds target, round to 2 decimals, and assign stable op ids.
 */
export function sanitizeDirectorPlan(raw: unknown, totalSec: number): DirectorPlan {
	const ops = (raw as { operations?: unknown[] })?.operations;
	if (!Array.isArray(ops)) {
		throw new Error("Director plan has no operations array");
	}
	const valid = new Set<DirectorOpKind>(["cut", "keep", "reorder", "take_select"]);
	const round2 = (n: number) => Math.round(n * 100) / 100;

	const cleaned: Omit<DirectorOp, "id">[] = [];
	for (const entry of ops) {
		const it = entry as Record<string, unknown>;
		const op = String(it.op) as DirectorOpKind;
		if (!valid.has(op)) continue;
		const startSec = Number(it.startSec);
		const endSec = Number(it.endSec);
		if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) continue;
		const s = Math.max(0, Math.min(startSec, totalSec));
		const e = Math.max(0, Math.min(endSec, totalSec));
		if (e <= s) continue;

		let targetStartSec: number | undefined;
		if (op === "reorder") {
			const t = Number(it.targetStartSec);
			if (!Number.isFinite(t) || t < 0 || t > totalSec) continue; // invalid reorder target -> drop
			targetStartSec = round2(t);
		}

		const confidence = Number(it.confidence);
		cleaned.push({
			op,
			startSec: round2(s),
			endSec: round2(e),
			reason: String(it.reason ?? "").slice(0, 240),
			confidence: Number.isFinite(confidence)
				? Math.max(0, Math.min(1, confidence))
				: 0.5,
			...(targetStartSec !== undefined ? { targetStartSec } : {}),
			// Prompt v2: a coherent trailing-speculation cut is categorized and
			// surfaced as an unchecked opt-in row (this editor keeps that style).
			...(op === "cut" && it.kind === "speculation"
				? { category: "speculation" as const, defaultAccept: false }
				: {}),
		});
	}

	cleaned.sort((a, b) => a.startSec - b.startSec);

	// Drop overlapping REMOVALS (cut/take_select) keeping the earlier one; keep/reorder pass through.
	const removalKinds = new Set<DirectorOpKind>(["cut", "take_select"]);
	const kept: Omit<DirectorOp, "id">[] = [];
	let lastRemovalEnd = -1;
	for (const op of cleaned) {
		if (removalKinds.has(op.op)) {
			if (op.startSec >= lastRemovalEnd) {
				kept.push(op);
				lastRemovalEnd = op.endSec;
			}
		} else {
			kept.push(op);
		}
	}

	return { operations: kept.map((op) => ({ ...op, id: stableOpId(op) })) };
}

/**
 * Build the Director prompt, dispatch it text-only, and return a sanitized plan
 * plus token usage. The route wraps this; vision layers on later by swapping the
 * dispatch for `planMultimodal` with the same prompt + schema.
 */
export async function planDirector({
	segments,
	totalSec,
	taste,
	catalog,
	compressionTarget,
	secondPass,
	auth,
}: {
	segments: readonly DirectorSegment[];
	totalSec: number;
	taste?: string;
	catalog?: readonly DirectorAssetSummary[];
	/** Fraction of words to REMOVE (0..0.8); adds the compression contract (U3). */
	compressionTarget?: number;
	/** Round 14 U1: this is the second cut, reading the assembled result (adds the
	 * second-pass preamble). Absent = the ordinary first-pass prompt. */
	secondPass?: boolean;
	auth: ClaudeAuth;
}): Promise<{ plan: DirectorPlan; usage: TokenUsage | null }> {
	const prompt = buildDirectorPrompt({ segments, totalSec, taste, catalog, compressionTarget, secondPass });
	const { raw, usage } = await planJson({ prompt, auth, schema: DIRECTOR_SCHEMA });
	return { plan: sanitizeDirectorPlan(raw, totalSec), usage };
}

// --- Multimodal dispatch (U5: the Director's vision pass) ---
//
// The Director sends sampled keyframes alongside the fused-signal text so the
// model can judge shot type / B-roll / framing. Only `api-key` (Anthropic
// Messages) and a vision-capable `custom` endpoint accept inline images; the
// `claude-code` CLI cannot, so it degrades to a text-only call and flags it.

/** Image media types the Anthropic Messages API accepts. */
export type MultimodalImageMediaType =
	| "image/jpeg"
	| "image/png"
	| "image/gif"
	| "image/webp";

/** A content block for a multimodal ask: a base64 image or a text run. */
export type MultimodalBlock =
	| { type: "image"; mediaType: MultimodalImageMediaType; dataBase64: string }
	| { type: "text"; text: string };

export interface MultimodalResult {
	raw: unknown;
	usage: TokenUsage | null;
	/** True when the backend can't take images and the call ran text-only. */
	degraded: boolean;
}

/**
 * Default vision model for BULK classification (cheap). Hard calls (the Director
 * plan) pass `model: "claude-opus-4-8"`. (KTD2/KTD3.)
 */
const DEFAULT_MULTIMODAL_MODEL = "claude-sonnet-4-6";

/**
 * Max images forwarded in one request — bounds the payload and the server's
 * compute window. Excess images are truncated with a logged warning, never
 * silently dropped (the caller's tiered gate should keep counts well under this).
 */
export const MAX_MULTIMODAL_IMAGES = 20;

interface PartitionedBlocks {
	images: Array<{ mediaType: string; dataBase64: string }>;
	/** All text blocks concatenated, in order. */
	text: string;
	/** True when images were truncated to fit MAX_MULTIMODAL_IMAGES. */
	truncated: boolean;
}

/**
 * Split blocks into a capped image list + concatenated text. Over the cap,
 * truncate (keeping the first N) and log a warning — never silently drop.
 */
export function partitionMultimodalBlocks(
	blocks: readonly MultimodalBlock[],
): PartitionedBlocks {
	const allImages = blocks.filter(
		(b): b is Extract<MultimodalBlock, { type: "image" }> => b.type === "image",
	);
	const text = blocks
		.filter((b): b is Extract<MultimodalBlock, { type: "text" }> => b.type === "text")
		.map((b) => b.text)
		.join("\n\n");
	const truncated = allImages.length > MAX_MULTIMODAL_IMAGES;
	if (truncated) {
		console.warn(
			`[hf-bridge] planMultimodal: ${allImages.length} images exceeds cap ${MAX_MULTIMODAL_IMAGES}; truncating to ${MAX_MULTIMODAL_IMAGES} (no silent drop).`,
		);
	}
	const images = allImages
		.slice(0, MAX_MULTIMODAL_IMAGES)
		.map(({ mediaType, dataBase64 }) => ({ mediaType, dataBase64 }));
	return { images, text, truncated };
}

/** Anthropic Messages body: images BEFORE text, native Structured Outputs. */
export function buildAnthropicMultimodalBody({
	images,
	text,
	schema,
	model,
}: {
	images: Array<{ mediaType: string; dataBase64: string }>;
	text: string;
	schema: object;
	model?: string;
}): object {
	return {
		model: model ?? DEFAULT_MULTIMODAL_MODEL,
		max_tokens: 8000,
		thinking: { type: "adaptive" },
		output_config: { format: { type: "json_schema", schema } },
		messages: [
			{
				role: "user",
				content: [
					...images.map((img) => ({
						type: "image",
						source: {
							type: "base64",
							media_type: img.mediaType,
							data: img.dataBase64,
						},
					})),
					// Omit an empty text block — the Messages API rejects `text: ""`.
					...(text ? [{ type: "text", text }] : []),
				],
			},
		],
	};
}

/** OpenAI-compatible vision body: image_url data URIs before text. */
export function buildCustomMultimodalBody({
	images,
	text,
	model,
}: {
	images: Array<{ mediaType: string; dataBase64: string }>;
	text: string;
	model: string;
}): object {
	return {
		model,
		messages: [
			{
				role: "user",
				content: [
					...images.map((img) => ({
						type: "image_url",
						image_url: { url: `data:${img.mediaType};base64,${img.dataBase64}` },
					})),
					...(text ? [{ type: "text", text }] : []),
				],
			},
		],
		temperature: 0.4,
		response_format: { type: "json_object" },
	};
}

/**
 * SSRF guard for the user-supplied `custom` vision endpoint — the ONLY path that
 * forwards FOOTAGE FRAMES off-device, so it is the only one that needs the guard.
 * Mirrors `apps/web/.../api/broll/fetch/route.ts`: https only, no IP literals, no
 * `localhost`/`.local`/`.internal`. (Local LLM servers can't take footage frames
 * for this reason — use `api-key` for the visual Director.) Throws on reject.
 */
export function assertSafeMultimodalHost(baseUrl: string): void {
	let parsed: URL;
	try {
		parsed = new URL(baseUrl);
	} catch {
		throw new Error(`Invalid custom endpoint URL: ${baseUrl}`);
	}
	// Normalize before the checks: lowercase, strip a single trailing dot (the FQDN
	// form `localhost.`), and unwrap an IPv6 literal's brackets — `URL.hostname`
	// keeps them (e.g. `[::1]`) and `node:net` `isIP()` returns 0 for a bracketed
	// address, which would otherwise let IPv6 loopback / ULA / link-local / IPv4-
	// mapped literals slip past the IP-literal check.
	let host = parsed.hostname.toLowerCase();
	if (host.endsWith(".")) host = host.slice(0, -1);
	const ipLiteral =
		host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
	if (
		parsed.protocol !== "https:" ||
		isIP(ipLiteral) !== 0 ||
		host === "localhost" ||
		host === "localhost.localdomain" ||
		host.endsWith(".localhost") ||
		host.endsWith(".local") ||
		host.endsWith(".internal")
	) {
		throw new Error(
			`Custom vision endpoint host not allowed (must be a public https host): ${host}`,
		);
	}
}

/**
 * Dispatch a multimodal (image+text) schema-constrained ask. `api-key` and
 * `custom` send the images; `claude-code` strips them and runs text-only with
 * `degraded: true`. Accumulated `TokenUsage` rides on the result.
 */
export async function planMultimodal({
	blocks,
	auth,
	schema,
	model,
	signal,
}: {
	blocks: readonly MultimodalBlock[];
	auth: ClaudeAuth;
	schema: object;
	model?: string;
	/** Aborts the in-flight LLM request when a Director run is cancelled. */
	signal?: AbortSignal;
}): Promise<MultimodalResult> {
	if (signal?.aborted) throw new Error("Cancelled");
	const { images, text } = partitionMultimodalBlocks(blocks);

	switch (auth.mode) {
		case "api-key": {
			const res = await fetch("https://api.anthropic.com/v1/messages", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-api-key": auth.apiKey,
					"anthropic-version": "2023-06-01",
				},
				body: JSON.stringify(
					buildAnthropicMultimodalBody({ images, text, schema, model }),
				),
				signal,
			});
			if (!res.ok) {
				const body = await res.text();
				throw new Error(`Anthropic API error ${res.status}: ${body.slice(0, 500)}`);
			}
			const data = (await res.json()) as {
				content?: { type: string; text?: string }[];
				usage?: { input_tokens?: number; output_tokens?: number };
			};
			// A 200 with a missing/empty content array (overloaded / refusal / streamed
			// shapes) must surface as extractJson's typed error, not a raw TypeError.
			const out = data.content?.find((b) => b.type === "text")?.text ?? "";
			return {
				raw: extractJson(out),
				usage: normalizeAnthropicUsage(data.usage),
				degraded: false,
			};
		}
		case "custom": {
			// Guard the host BEFORE any fetch — no frame leaves until this passes.
			assertSafeMultimodalHost(auth.baseUrl);
			const res = await fetch(customChatUrl(auth.baseUrl), {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...(auth.apiKey ? { authorization: `Bearer ${auth.apiKey}` } : {}),
				},
				body: JSON.stringify(
					buildCustomMultimodalBody({ images, text, model: model ?? auth.model }),
				),
				signal,
			});
			if (!res.ok) {
				const body = await res.text();
				throw new Error(`Custom model error ${res.status}: ${body.slice(0, 500)}`);
			}
			const data = (await res.json()) as {
				choices?: { message?: { content?: string } }[];
				usage?: { prompt_tokens?: number; completion_tokens?: number };
			};
			const out = data.choices?.[0]?.message?.content ?? "";
			return {
				raw: extractJson(out),
				usage: normalizeOpenAiUsage(data.usage),
				degraded: false,
			};
		}
		default: {
			// claude-code CLI can't take inline images: strip them, run text-only.
			const { raw, usage } = await planViaClaudeCode(text);
			return { raw, usage, degraded: true };
		}
	}
}

// --- Vision Director (U2): the text+audio cut, now with eyes ---
//
// `planDirectorVision` layers sampled footage frames onto the SAME planner: same
// signal-table prompt (+ a vision addendum), same DIRECTOR_SCHEMA, same
// sanitizer — so the apply/merge/taste spine downstream is untouched. Frames are
// the planner's only new input; everything else is the shipped text path.

/** A sampled footage frame tied to the segment it depicts, ready for the vision planner. */
export interface DirectorVisionFrame {
	/** Index into the `segments` array this frame depicts (drives the prompt mapping). */
	segmentIndex: number;
	mediaType: MultimodalImageMediaType;
	dataBase64: string;
}

/** Default model for the (hard) vision Director call — the strong vision model. */
const DIRECTOR_VISION_MODEL = "claude-opus-4-8";

/**
 * Append a vision addendum + a frame→segment time map to the text-only Director
 * prompt. The frames are sent images-first (the Messages API order), so the text
 * must tell the model which frame is which segment — by the segment's time range,
 * matching the signal table's time column. No frames → the base prompt verbatim.
 */
export function buildDirectorVisionPrompt({
	segments,
	totalSec,
	taste,
	catalog,
	frames,
}: {
	segments: readonly DirectorSegment[];
	totalSec: number;
	taste?: string;
	catalog?: readonly DirectorAssetSummary[];
	frames: readonly DirectorVisionFrame[];
}): string {
	const base = buildDirectorPrompt({ segments, totalSec, taste, catalog });
	if (!frames.length) return base;
	const frameLines = frames
		.map((f, k) => {
			const seg = segments[f.segmentIndex];
			const time = seg
				? `${seg.startSec.toFixed(1)}-${seg.endSec.toFixed(1)}s`
				: "unknown";
			return `- Frame ${k + 1}: the segment at ${time}`;
		})
		.join("\n");
	return `${base}

VISION: You are ALSO given ${frames.length} sampled frame(s) from the footage, one per segment below, in THIS order:
${frameLines}

Use each frame to judge that segment's VISUAL alongside its audio and text. Beyond the audio cues, CUT a segment whose visual is dead weight — the speaker off-screen or out of frame, a frozen / black / slate frame, an accidental cutaway, or a long low-information hold that doesn't earn its place. KEEP sharp, well-framed A-roll where the speaker is present and engaged. When the visual is fine, judge by audio and text as usual — do NOT invent visual cuts. Name the visual reason in "reason" (e.g. "speaker off-screen").`;
}

/**
 * Build the multimodal blocks for a vision Director ask: the frames as image
 * blocks (in segment order), then the signal-table + vision prompt as one text
 * block. Pure (no dispatch), so the block shape is unit-testable.
 */
export function buildDirectorVisionBlocks({
	segments,
	totalSec,
	taste,
	catalog,
	frames,
}: {
	segments: readonly DirectorSegment[];
	totalSec: number;
	taste?: string;
	catalog?: readonly DirectorAssetSummary[];
	frames: readonly DirectorVisionFrame[];
}): MultimodalBlock[] {
	const imageBlocks: MultimodalBlock[] = frames.map((f) => ({
		type: "image",
		mediaType: f.mediaType,
		dataBase64: f.dataBase64,
	}));
	const text = buildDirectorVisionPrompt({ segments, totalSec, taste, catalog, frames });
	return [...imageBlocks, { type: "text", text }];
}

/**
 * Vision variant of `planDirector`: dispatch the frames + signal table through
 * `planMultimodal`, then sanitize with the SAME schema as the text path. A
 * backend that can't take images (e.g. `claude-code`) returns `degraded: true`
 * and a valid text-only plan — never a failure (R3); the caller surfaces it.
 */
export async function planDirectorVision({
	segments,
	totalSec,
	taste,
	catalog,
	frames,
	auth,
	model,
	signal,
}: {
	segments: readonly DirectorSegment[];
	totalSec: number;
	taste?: string;
	catalog?: readonly DirectorAssetSummary[];
	frames: readonly DirectorVisionFrame[];
	auth: ClaudeAuth;
	model?: string;
	signal?: AbortSignal;
}): Promise<{ plan: DirectorPlan; usage: TokenUsage | null; degraded: boolean }> {
	const blocks = buildDirectorVisionBlocks({ segments, totalSec, taste, catalog, frames });
	const { raw, usage, degraded } = await planMultimodal({
		blocks,
		auth,
		schema: DIRECTOR_SCHEMA,
		model: model ?? DIRECTOR_VISION_MODEL,
		signal,
	});
	return { plan: sanitizeDirectorPlan(raw, totalSec), usage, degraded };
}

export async function planEffects({
	segments,
	totalDurationSec,
	auth,
	allowedTemplateIds,
	direction,
	preferences,
	look,
}: {
	segments: TranscriptSegment[];
	totalDurationSec: number;
	auth: ClaudeAuth;
	/** Restrict the planner to these template ids (user's panel checkboxes). */
	allowedTemplateIds?: string[];
	/** Free-form instructions from the user's HyperFrames prompt window. */
	direction?: string;
	/** Self-learning notes from the user's past edits. */
	preferences?: string[];
	/** Active look (name + aesthetic) — biases template/pacing choices. */
	look?: { name: string; description: string };
}): Promise<EffectPlan & { usage: TokenUsage | null }> {
	if (!segments.length) {
		return { items: [], usage: null };
	}
	const prompt = buildPlannerPrompt({
		segments,
		totalDurationSec,
		allowedTemplateIds,
		direction,
		preferences,
		look,
	});
	const { raw, usage } = await planDispatch(prompt, auth, PLAN_SCHEMA);
	return { ...sanitizePlan(raw, totalDurationSec, allowedTemplateIds), usage };
}
