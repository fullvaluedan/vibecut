export * from "./types";
export {
	computeSafeZone,
	type HZone,
	type FrameSpeaker,
	type SafeZone,
} from "./speaker-zone";
export {
	detectSpeakerZonesFromFrames,
	safeZoneFromModelFrames,
	type SpeakerDetectFrame,
} from "./speaker-detect";
export {
	HF_TEMPLATES,
	getTemplate,
	describeTemplateCatalog,
} from "./templates/index";
export {
	planEffects,
	planJson,
	planMultimodal,
	planDirector,
	planDirectorVision,
	stableOpId,
	DIRECTOR_PROMPT_VERSION,
	buildDirectorVisionPrompt,
	buildDirectorVisionBlocks,
	MAX_MULTIMODAL_IMAGES,
	type TokenUsage,
	type MultimodalBlock,
	type MultimodalImageMediaType,
	type MultimodalResult,
	type DirectorOpKind,
	type DirectorOpCategory,
	type DirectorOp,
	type DirectorPlan,
	type DirectorSegment,
	type DirectorAssetSummary,
	type DirectorVisionFrame,
} from "./author";
export {
	planAssembly,
	buildAssemblyPrompt,
	renderCandidateCatalog,
	sanitizeAssemblyPlan,
	type AssemblyCandidate,
	type AssemblySpan,
	type AssemblyPlan,
} from "./assemble";
export {
	planRedundancy,
	buildRedundancyPrompt,
	renderRedundancyCatalog,
	sanitizeRedundancyPlan,
	mergeRedundancyGroups,
	type RedundancyLine,
	type RedundancyMember,
	type RedundancyGroup,
	type RedundancyPlan,
} from "./llm-redundancy";
export {
	planContext,
	buildContextPrompt,
	renderContextCatalog,
	sanitizeContextPlan,
	type ContextFlag,
	type ContextPlan,
} from "./llm-context";
export {
	planRetake,
	buildRetakePrompt,
	renderRetakeCatalog,
	sanitizeRetakePlan,
	groupWordsIntoLines,
	markHandledLines,
	mergeRetakeCuts,
	RETAKE_MAX_CHARS,
	HANDLED_LINE_COVER_FRACTION,
	RETAKE_PROMPT_VERSION,
	type RetakeWord,
	type RetakeLine,
	type RetakeCut,
	type RetakePlan,
	type RetakeHandledSpan,
} from "./llm-retake";
export {
	planStructural,
	buildStructuralPrompt,
	renderStructuralCatalog,
	sanitizeStructuralPlan,
	markHandledStructuralLines,
	STRUCTURAL_PROMPT_VERSION,
	type StructuralDrop,
	type StructuralPlan,
	type StructuralHandledSpan,
} from "./llm-structural";
export {
	planVerify,
	buildVerifyPrompt,
	sanitizeVerifyPlan,
	VERIFY_PROMPT_VERSION,
	type VerifyCandidate,
	type VerifyVerdict,
	type VerifyPlan,
} from "./llm-verify";
export {
	resolveReferencedOps,
	sanitizeReferencedPlan,
	type ReferenceLine,
	type ReferenceWord,
	type ReferenceCatalog,
	type RawReferencedOp,
	type ResolvedOp,
	type SanitizeResult,
} from "./llm-reference-sanitizer";
export {
	chunkTranscriptLines,
	transcriptExceedsBudget,
	dedupeByKey,
	type ChunkLine,
} from "./transcript-chunk";
export {
	renderTemplateJob,
	renderCompDir,
	startStudio,
	generatedRoot,
} from "./renderer";
export {
	authorComposition,
	type AuthoredComposition,
} from "./author-composition";
export {
	bakeRegistryItem,
	bakeRegistryBlock,
	bakedRoot,
	type BakeJob,
	type BakeOutcome,
} from "./bake";
export {
	fetchRegistryComposition,
	registryKindDir,
	isValidRegistryName,
	isValidRegistryType,
	KNOWN_REGISTRY_KINDS,
	type RegistryComposition,
	type RegistryItemMeta,
	type RegistryCompositionFile,
} from "./registry-fetch";
export { runDoctor, type DoctorReport } from "./doctor";
