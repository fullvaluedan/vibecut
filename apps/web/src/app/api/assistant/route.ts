import { NextRequest, NextResponse } from "next/server";
import { planJson } from "@framecut/hf-bridge";
import { resolveAiAuth } from "@/features/ai-generate/resolve-ai-auth";

export const runtime = "nodejs";
export const maxDuration = 120;

export type AssistantCommand =
	| { command: "find_broll"; query: string }
	| { command: "find_audio"; query: string; audioType: "music" | "sound_effects" }
	| {
			command: "ai_cut";
			mode: "silences" | "repeats" | "cleanup" | "youtube";
	  }
	| { command: "run_hyperframes"; direction: string; replace?: boolean }
	| { command: "add_text"; text: string }
	| { command: "open_captions" }
	| { command: "reject"; reason: string };

const ASSISTANT_SCHEMA = {
	type: "object",
	properties: {
		command: {
			type: "string",
			enum: [
				"find_broll",
				"find_audio",
				"ai_cut",
				"run_hyperframes",
				"add_text",
				"open_captions",
				"reject",
			],
		},
		query: { type: "string" },
		audioType: { type: "string", enum: ["music", "sound_effects"] },
		mode: {
			type: "string",
			enum: ["silences", "repeats", "cleanup", "youtube"],
		},
		direction: { type: "string" },
		replace: { type: "boolean" },
		text: { type: "string" },
		reason: { type: "string" },
	},
	required: ["command"],
	additionalProperties: false,
} as const;

function buildAssistantPrompt(userPrompt: string): string {
	return `You are the command router for VibeCut, a video editor. Map the user's request to EXACTLY ONE of these commands:

- find_broll {query}: the user wants b-roll / supporting imagery. query = a concise image search phrase.
- find_audio {query, audioType}: the user wants background music ("music") or a sound effect ("sound_effects"). query = a natural-language description of the sound.
- ai_cut {mode}: the user wants the footage cut/cleaned. mode: "silences" (just dead air), "repeats" (just retakes), "cleanup" (stutters+retakes+tangents), "youtube" (full edit: assemble everything, pacing, hook — use this for "edit my video", "make this a YouTube video", "cut everything").
- run_hyperframes {direction, replace}: the user wants motion graphics / effects / overlays / animations generated. direction = their creative instructions, verbatim where possible. Set replace=true when they want to CHANGE, REDO, or REPLACE effects that already exist ("change the effects to...", "redo the graphics", "try a different style") so the old ones are cleared first.
- add_text {text}: the user wants a specific text/title placed on the video. text = the exact words to display.
- open_captions: the user wants captions/subtitles generated or styled.
- reject {reason}: ANYTHING ELSE.

STRICT SCOPE RULE: you only operate this video editor — video, audio, graphics, HyperFrames effects, and captions for the CURRENT project. General knowledge questions, coding, math, life advice, web browsing, news, or anything not about editing this video → reject with a one-sentence reason that politely says what you CAN do.

USER REQUEST:
${userPrompt}

Respond with ONLY a flat JSON object whose "command" field is the command name. Examples of the EXACT shape:
{"command":"reject","reason":"I only help edit this video."}
{"command":"ai_cut","mode":"youtube"}
{"command":"find_broll","query":"city skyline at night"}
{"command":"find_audio","query":"tense cinematic underscore","audioType":"music"}
{"command":"add_text","text":"BIG NEWS"}`;
}

const COMMAND_NAMES = [
	"find_broll",
	"find_audio",
	"ai_cut",
	"run_hyperframes",
	"add_text",
	"open_captions",
	"reject",
] as const;

/**
 * Claude-code mode has no schema enforcement, so the model occasionally
 * nests the command ({"command":{"reject":{...}}} or {"reject":{...}}).
 * Flatten anything recognizable into the canonical shape.
 */
function normalizeCommand(raw: unknown): Record<string, unknown> | null {
	if (!raw || typeof raw !== "object") return null;
	const obj = raw as Record<string, unknown>;
	if (
		typeof obj.command === "string" &&
		(COMMAND_NAMES as readonly string[]).includes(obj.command)
	) {
		return obj;
	}
	const container =
		obj.command && typeof obj.command === "object"
			? (obj.command as Record<string, unknown>)
			: obj;
	if (
		typeof container.command === "string" &&
		(COMMAND_NAMES as readonly string[]).includes(container.command)
	) {
		return container;
	}
	for (const name of COMMAND_NAMES) {
		if (name in container) {
			const params =
				container[name] && typeof container[name] === "object"
					? (container[name] as Record<string, unknown>)
					: {};
			return { command: name, ...params };
		}
	}
	return null;
}

export async function POST(req: NextRequest) {
	const auth = resolveAiAuth(req);
	if (!auth) {
		return NextResponse.json(
			{ error: "Your AI connection isn't fully configured. Check Settings → AI." },
			{ status: 401 },
		);
	}
	const body = (await req.json()) as { prompt?: string };
	const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
	if (!prompt) {
		return NextResponse.json({ error: "Empty prompt" }, { status: 400 });
	}
	try {
		const { raw, usage } = await planJson({
			prompt: buildAssistantPrompt(prompt.slice(0, 2000)),
			auth,
			schema: ASSISTANT_SCHEMA,
		});
		const command = normalizeCommand(raw);
		if (!command) {
			return NextResponse.json(
				{ error: "The assistant returned an unrecognized command." },
				{ status: 502 },
			);
		}
		return NextResponse.json({ command, usage });
	} catch (e) {
		return NextResponse.json(
			{ error: `Assistant failed: ${e instanceof Error ? e.message : String(e)}` },
			{ status: 500 },
		);
	}
}
