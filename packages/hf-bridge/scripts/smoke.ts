/**
 * End-to-end smoke test for the local render pipeline.
 * Run from repo root: bun packages/hf-bridge/scripts/smoke.ts [templateId]
 */
import { renderTemplateJob } from "../src/renderer";
import { HF_TEMPLATES } from "../src/templates/index";

const templateId = process.argv[2] ?? "lower-third";
const template = HF_TEMPLATES.find((t) => t.id === templateId);
if (!template) {
	console.error(`Unknown template ${templateId}. Have: ${HF_TEMPLATES.map((t) => t.id).join(", ")}`);
	process.exit(1);
}

const variables: Record<string, string> = {};
for (const v of template.variables) {
	if (typeof v.default === "string") variables[v.id] = v.default;
}

console.log(`Rendering ${templateId} (4s, 1280x720@30) ...`);
const started = Date.now();
const result = await renderTemplateJob({
	templateId,
	durationSec: 4,
	fps: 30,
	width: 1280,
	height: 720,
	variables,
});
console.log(`OK in ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(`video: ${result.videoPath}`);
console.log(`comp:  ${result.compDir}`);
