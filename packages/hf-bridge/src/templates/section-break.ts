import type { HfTemplate } from "../types";
import { buildCompShell, SET_TEXT_HELPER } from "./comp-shell";

export const sectionBreak: HfTemplate = {
	id: "section-break",
	name: "Section break",
	description: "A full-width band sweeps across the center with a chapter title.",
	whenToUse:
		"Topic changes — the speaker moves to a new section, step, or chapter of the video.",
	variables: [
		{ id: "text", type: "string", label: "Title", default: "Part Two" },
		{ id: "kicker", type: "string", label: "Kicker (small text above)", default: "" },
		{ id: "accent", type: "color", label: "Accent", default: "#FF6E20" },
	],
	minDurationSec: 2.5,
	maxDurationSec: 5,
	buildCompHtml: ({ width, height, durationSec }) =>
		buildCompShell({
			width,
			height,
			durationSec,
			variables: sectionBreak.variables,
			css: `
.clip { position: absolute; inset: 0; font-family: Inter, "Helvetica Neue", Arial, sans-serif; }
.sb-band {
	position: absolute; left: 0; right: 0;
	top: 50%; transform: translateY(-50%);
	height: ${Math.round(height * 0.24)}px;
	background: rgba(10, 12, 16, 0.88);
	border-top: 1px solid rgba(255, 255, 255, 0.10);
	border-bottom: 1px solid rgba(255, 255, 255, 0.10);
	display: flex; flex-direction: column; align-items: center; justify-content: center;
	gap: ${Math.round(height * 0.008)}px;
	overflow: hidden;
}
.sb-accent-bar {
	position: absolute; left: 0; top: 0; bottom: 0;
	width: ${Math.round(width * 0.012)}px;
	background: var(--accent, #FF6E20);
}
.sb-kicker {
	color: var(--accent, #FF6E20);
	font-size: ${Math.round(height * 0.026)}px;
	font-weight: 700; letter-spacing: 0.22em; text-transform: uppercase;
}
.sb-kicker:empty { display: none; }
.sb-title {
	color: #F5F2EC;
	font-size: ${Math.round(height * 0.085)}px;
	font-weight: 800; letter-spacing: 0.01em; line-height: 1.05;
	max-width: ${Math.round(width * 0.86)}px;
	white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
	text-align: center;
}
`,
			bodyHtml: `
<div class="sb-band" id="sb-band">
	<div class="sb-accent-bar" id="sb-accent-bar"></div>
	<div class="sb-kicker" id="sb-kicker"></div>
	<div class="sb-title" id="sb-title"></div>
</div>
`,
			timelineJs: `
${SET_TEXT_HELPER}
setAccent(VARS.accent);
setText("sb-title", VARS.text);
setText("sb-kicker", VARS.kicker || "");

tl.from("#sb-band", { scaleY: 0, duration: 0.5, ease: "expo.out" }, 0.12);
tl.from("#sb-accent-bar", { x: -40, opacity: 0, duration: 0.45, ease: "power3.out" }, 0.35);
tl.from("#sb-title", { x: 70, opacity: 0, duration: 0.55, ease: "power4.out" }, 0.4);
tl.from("#sb-kicker", { y: -16, opacity: 0, duration: 0.4, ease: "sine.out" }, 0.5);

tl.to("#sb-band", { scaleY: 0, opacity: 0, duration: 0.4, ease: "expo.in" }, EXIT_AT);
tl.set("#sb-band", { opacity: 0 }, EXIT_AT + 0.45);
`,
		}),
};
