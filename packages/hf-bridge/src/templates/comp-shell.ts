import type { TemplateVariableDecl } from "../types";

/**
 * Wraps template content in a complete standalone HyperFrames composition.
 *
 * Contract (see hyperframes docs): standalone comps put the
 * data-composition-id div directly in <body> (no <template> wrapper),
 * declare variables on <html>, register a paused GSAP timeline on
 * window.__timelines, and stay fully deterministic. Background is left
 * transparent so `render --format webm` produces alpha for overlaying.
 */
export function buildCompShell({
	width,
	height,
	durationSec,
	variables,
	css,
	bodyHtml,
	timelineJs,
}: {
	width: number;
	height: number;
	durationSec: number;
	variables: TemplateVariableDecl[];
	css: string;
	bodyHtml: string;
	timelineJs: string;
}): string {
	const varsAttr = JSON.stringify(variables).replace(/'/g, "&#39;");
	return `<!doctype html>
<html data-composition-variables='${varsAttr}'>
<head>
<meta charset="utf-8" />
<style>
html, body { margin: 0; padding: 0; background: transparent; }
* { box-sizing: border-box; }
${css}
</style>
</head>
<body>
<div data-composition-id="root" data-width="${width}" data-height="${height}">
	<div id="clip" class="clip" data-start="0" data-duration="${durationSec}" data-track-index="0">
${bodyHtml}
	</div>
</div>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<script>
window.__timelines = window.__timelines || {};
const VARS = window.__hyperframes.getVariables();
const DURATION = ${durationSec};
const EXIT_AT = Math.max(0.8, DURATION - 0.55);
const tl = gsap.timeline({ paused: true });
${timelineJs}
window.__timelines["root"] = tl;
</script>
</body>
</html>
`;
}

/** Sets text content from variables before the timeline is built. */
export const SET_TEXT_HELPER = `
function setText(id, value) {
	const el = document.getElementById(id);
	if (el) el.textContent = String(value);
}
function setAccent(value) {
	document.documentElement.style.setProperty("--accent", String(value));
}
`;
