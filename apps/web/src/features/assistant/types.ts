/**
 * The TURN CONTRACT for the prompt-to-edit assistant (T17.1).
 *
 * One place for every shape that crosses a boundary: client to route, route to
 * client, and validator to executor. T17.2 (the executor) and T17.3 (the chat
 * UI) import from here and never from the route file, so the wire shape can be
 * changed in exactly one module.
 *
 * Architecture note (roadmap section 6): the model NEVER touches timeline state.
 * It emits tool calls, every call is validated against a pure snapshot, and only
 * a fully valid turn is turned into commands. This file describes the calls and
 * the validation verdicts; `tools.ts` owns the schemas and the validators;
 * `context.ts` owns what the model gets to see.
 */

import type { AssistantContext } from "./context";

/** Every tool the edit assistant may call. `ask_user` is the only non-mutating one. */
export type AssistantToolName =
	| "cut_range"
	| "delete_clip"
	| "extend_clip"
	| "move_clip"
	| "split_at"
	| "set_speed"
	| "add_text"
	| "add_motion_template"
	| "add_marker"
	| "select_clips"
	| "ask_user";

/** A tool call exactly as the model emitted it, before validation. */
export interface ToolCall {
	/** The provider's tool-use id; echoed back in the tool result. */
	id: string;
	name: string;
	/** Raw, untrusted arguments. Validators are the only thing that may read them. */
	args: Record<string, unknown>;
}

/**
 * Why a validator refused. Machine-readable so the executor and the model can
 * branch on it without string matching; `reason` carries the human sentence.
 */
export type ValidationFailureCode =
	| "unknown_tool"
	| "bad_argument"
	| "unknown_clip"
	| "unknown_track"
	| "unknown_template"
	| "empty_range"
	| "out_of_bounds"
	| "min_duration"
	| "source_limit"
	| "speed_range"
	| "not_retimable"
	| "wrong_track_type"
	| "overlap"
	| "track_cap"
	| "protected_span";

export interface ValidationFailure {
	ok: false;
	code: ValidationFailureCode;
	/** Plain language, safe to show the user AND to feed back to the model. */
	reason: string;
	/** Machine-readable specifics (the offending id, the limit that bound). */
	detail?: Record<string, string | number | boolean>;
}

export interface ValidationSuccess<TArgs> {
	ok: true;
	/** Normalized arguments: frame-snapped, defaulted, and stripped of junk. */
	args: TArgs;
}

export type ValidationResult<TArgs = unknown> =
	| ValidationSuccess<TArgs>
	| ValidationFailure;

// --- Normalized argument shapes (what the executor receives) ---------------

/** Which lanes a time-range removal touches. */
export type CutScope = "all" | "main";

export interface CutRangeArgs {
	startSec: number;
	endSec: number;
	scope: CutScope;
}

export interface DeleteClipArgs {
	clipId: string;
}

export interface ExtendClipArgs {
	clipId: string;
	edge: "start" | "end";
	/** Positive grows the clip, negative shrinks it. Frame-snapped. */
	deltaSec: number;
}

export interface MoveClipArgs {
	clipId: string;
	toStartSec: number;
	/** Resolved track id; absent means "same track" (or a new lane). */
	toTrackId?: string;
	/** Set when the model asked for a brand new lane of the clip's own type. */
	toNewTrack?: true;
}

export interface SplitAtArgs {
	clipId: string;
	atSec: number;
}

export interface SetSpeedArgs {
	clipId: string;
	rate: number;
	maintainPitch: boolean;
}

export interface AddTextArgs {
	text: string;
	atSec: number;
	durationSec: number;
}

export interface AddMotionTemplateArgs {
	templateId: string;
	atSec: number;
	durationSec: number;
	/** Only keys the template declares survive normalization. */
	variables: Record<string, string>;
}

export interface AddMarkerArgs {
	atSec: number;
	note?: string;
}

export interface SelectClipsArgs {
	clipIds: string[];
}

export interface AskUserArgs {
	question: string;
	/** Optional short answer choices, each grounded in the context. */
	options?: string[];
}

/** A validated call: the tool name paired with its normalized arguments. */
export type ValidatedToolCall =
	| { id: string; name: "cut_range"; args: CutRangeArgs }
	| { id: string; name: "delete_clip"; args: DeleteClipArgs }
	| { id: string; name: "extend_clip"; args: ExtendClipArgs }
	| { id: string; name: "move_clip"; args: MoveClipArgs }
	| { id: string; name: "split_at"; args: SplitAtArgs }
	| { id: string; name: "set_speed"; args: SetSpeedArgs }
	| { id: string; name: "add_text"; args: AddTextArgs }
	| { id: string; name: "add_motion_template"; args: AddMotionTemplateArgs }
	| { id: string; name: "add_marker"; args: AddMarkerArgs }
	| { id: string; name: "select_clips"; args: SelectClipsArgs }
	| { id: string; name: "ask_user"; args: AskUserArgs };

/** Whole-turn verdict: either every call validated, or the first one that did not. */
export type TurnValidation =
	| { ok: true; calls: ValidatedToolCall[] }
	| { ok: false; call: ToolCall; failure: ValidationFailure };

// --- Wire shapes -----------------------------------------------------------

/** One prior turn in the conversation. */
export interface AssistantMessage {
	role: "user" | "assistant";
	/** Plain text the model said or the user typed. */
	content: string;
	/** Tool calls the assistant emitted on this turn (assistant messages only). */
	toolCalls?: ToolCall[];
}

/** What the executor reports back for one tool call, so the model can continue. */
export interface AssistantToolResult {
	toolCallId: string;
	ok: boolean;
	/** One short sentence: what happened, or why it could not happen. */
	summary: string;
}

export interface AssistantTurnRequest {
	context: AssistantContext;
	messages: AssistantMessage[];
	/** Results for the tool calls of the LAST assistant message, when continuing. */
	toolResults?: AssistantToolResult[];
	/** Override the default model. Optional; the route defaults it. */
	model?: string;
}

export interface AssistantTurnUsage {
	inputTokens: number;
	outputTokens: number;
}

export interface AssistantTurnResponse {
	/** The model's plain-language summary. Always present, possibly empty. */
	text: string;
	/** Tool calls to validate and then execute. Empty for a pure text turn. */
	toolCalls: ToolCall[];
	/**
	 * Set when the model used `ask_user`: the clarifying question, already
	 * extracted so the UI does not have to dig through `toolCalls`. The matching
	 * call still appears in `toolCalls` so the transcript stays complete.
	 */
	question: string | null;
	/** Answer choices from the same `ask_user` call, when it offered any. */
	questionOptions?: string[];
	stopReason: string | null;
	usage: AssistantTurnUsage | null;
	/** The system-prompt version this turn was produced with. */
	promptVersion: number;
	model: string;
}
