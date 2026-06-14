export * from "./types";
export { HF_TEMPLATES, getTemplate, describeTemplateCatalog } from "./templates/index";
export {
	planEffects,
	planRepeatCuts,
	planJson,
	type CutsMode,
	type RepeatCut,
	type TokenUsage,
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
