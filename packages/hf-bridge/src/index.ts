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
