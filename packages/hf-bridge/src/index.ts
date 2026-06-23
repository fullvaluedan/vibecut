export * from "./types";
export { HF_TEMPLATES, getTemplate, describeTemplateCatalog } from "./templates/index";
export {
	planEffects,
	planRepeatCuts,
	planJson,
	planMultimodal,
	planDirector,
	planDirectorVision,
	buildDirectorVisionPrompt,
	buildDirectorVisionBlocks,
	MAX_MULTIMODAL_IMAGES,
	type CutsMode,
	type RepeatCut,
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
	bakeRegistryBlock,
	bakedRoot,
	type BakeJob,
	type BakeOutcome,
} from "./bake";
export { runDoctor, type DoctorReport } from "./doctor";
