/**
 * The public surface of the prompt-to-edit assistant's data layer (T17.1).
 *
 * T17.2 (executor) and T17.3 (chat UI) import from here, so the internal module
 * split can change without touching either. Deliberately NOT named `index.ts`:
 * `features/assistant/run-assistant.ts` is the older command-router surface and
 * a bare barrel next to it would blur which one a caller meant.
 */

export {
	ASSISTANT_CONTEXT_VERSION,
	DEFAULT_CONTEXT_OPTIONS,
	describeAspect,
	estimateContextTokens,
	measureContextChars,
	serializeAssistantContext,
} from "./context";
export type {
	AssistantContext,
	AssistantContextClip,
	AssistantContextOptions,
	AssistantContextTrack,
	AssistantContextTranscript,
} from "./context";

export {
	collectAssistantContext,
	editorTranscriptSource,
	readAssistantTranscript,
} from "./collect";
export type {
	AssistantTranscriptSource,
	TranscriptSourceWord,
} from "./collect";

export {
	ASSISTANT_EDIT_MODEL,
	ASSISTANT_EDIT_PROMPT_VERSION,
	buildAssistantEditSystemPrompt,
} from "./prompt";

export {
	allSnapshotClips,
	buildTimelineSnapshot,
	buildTrackLabels,
	findSnapshotClip,
	findSnapshotTrack,
	linkedSnapshotClips,
	snapshotClipEnd,
} from "./snapshot";
export type {
	AssistantSnapshotEditor,
	SnapshotClip,
	SnapshotMarker,
	SnapshotProtectedSpan,
	SnapshotTrack,
	SnapshotTranscript,
	SnapshotWord,
	TimelineSnapshot,
} from "./snapshot";

export {
	ASSISTANT_EDIT_TOOLS,
	ASSISTANT_TEMPLATE_CATALOG,
	findAssistantTool,
	MUTATING_TOOL_NAMES,
	toAnthropicTools,
	validateToolCall,
	validateTurn,
} from "./tools";
export type {
	AnthropicToolSpec,
	AssistantToolDefinition,
	ToolInputSchema,
} from "./tools";

export {
	ASSISTANT_TEMPLATE_IDS,
	findAssistantTemplate,
} from "./template-catalog";
export type {
	AssistantTemplateField,
	AssistantTemplateSpec,
} from "./template-catalog";

export type {
	AddMarkerArgs,
	AddMotionTemplateArgs,
	AddTextArgs,
	AskUserArgs,
	AssistantMessage,
	AssistantToolName,
	AssistantToolResult,
	AssistantTurnRequest,
	AssistantTurnResponse,
	AssistantTurnUsage,
	CutRangeArgs,
	CutScope,
	DeleteClipArgs,
	ExtendClipArgs,
	MoveClipArgs,
	SelectClipsArgs,
	SetSpeedArgs,
	SplitAtArgs,
	ToolCall,
	TurnValidation,
	ValidatedToolCall,
	ValidationFailure,
	ValidationFailureCode,
	ValidationResult,
	ValidationSuccess,
} from "./types";
