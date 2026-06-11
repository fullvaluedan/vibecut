import type { HfTemplate } from "../types";
import { buildCompShell, SET_TEXT_HELPER } from "./comp-shell";

export const kineticTitle: HfTemplate = {
	id: "kinetic-title",
	name: "Kinetic title",
	description: "Big centered words that pop in one after another, word by word.",
	whenToUse:
		"The speaker's key phrase or thesis statement — 2 to 6 punchy words worth amplifying full-screen.",
	variables: [
		{ id: "text", type: "string", label: "Text", default: "MAKE IT MOVE" },
		{ id: "accent", type: "color", label: "Accent", default: "#FF6E20" },
	],
	minDurationSec: 2,
	maxDurationSec: 5,
	buildCompHtml: ({ width, height, durationSec }) =>
		buildCompShell({
			width,
			height,
			durationSec,
			variables: kineticTitle.variables,
			css: `
.clip { position: absolute; inset: 0; font-family: Inter, "Helvetica Neue", Arial, sans-serif; }
.kt-stage {
	position: absolute; inset: 0;
	display: flex; align-items: center; justify-content: center;
	padding: 0 ${Math.round(width * 0.08)}px;
}
.kt-line {
	display: flex; flex-wrap: wrap; justify-content: center;
	gap: 0 ${Math.round(height * 0.022)}px;
	max-width: 100%;
}
.kt-word {
	color: #F5F2EC;
	font-size: ${Math.round(height * 0.115)}px;
	font-weight: 800; letter-spacing: -0.01em; line-height: 1.05;
	text-transform: uppercase;
	text-shadow: 0 6px 30px rgba(0, 0, 0, 0.45);
	will-change: transform;
}
.kt-word:nth-child(2n) { color: var(--accent, #FF6E20); }
`,
			bodyHtml: `
<div class="kt-stage">
	<div class="kt-line" id="kt-line"></div>
</div>
`,
			timelineJs: `
${SET_TEXT_HELPER}
setAccent(VARS.accent);
const line = document.getElementById("kt-line");
const words = String(VARS.text).trim().split(/\\s+/).slice(0, 8);
for (const w of words) {
	const span = document.createElement("span");
	span.className = "kt-word";
	span.textContent = w;
	line.appendChild(span);
}

const step = Math.min(0.14, 1.0 / Math.max(words.length, 1));
tl.from(".kt-word", {
	y: 90,
	opacity: 0,
	rotation: 4,
	duration: 0.5,
	ease: "back.out(1.6)",
	stagger: step,
}, 0.15);
tl.to(".kt-word", {
	scale: 1.03,
	duration: 0.9,
	ease: "sine.inOut",
	stagger: { each: 0.05, from: "center" },
}, 0.8);

tl.to(".kt-word", {
	y: -50,
	opacity: 0,
	duration: 0.35,
	ease: "power2.in",
	stagger: 0.04,
}, EXIT_AT);
tl.set(".kt-word", { opacity: 0 }, EXIT_AT + 0.7);
`,
		}),
};
