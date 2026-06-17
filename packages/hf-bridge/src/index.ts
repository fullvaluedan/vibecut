export * from "./types";
export { HF_TEMPLATES, getTemplate, describeTemplateCatalog } from "./templates/index";
export {
	planEffects,
	planRepeatCuts,
	planJson,
	planMultimodal,
	partitionMultimodalBlocks,
	buildAnthropicMultimodalBody,
	buildCustomMultimodalBody,
	assertSafeMultimodalHost,
	MAX_MULTIMODAL_IMAGES,
	type CutsMode,
	type RepeatCut,
	type TokenUsage,
	type MultimodalBlock,
	type MultimodalResult,
} from "./author";
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
