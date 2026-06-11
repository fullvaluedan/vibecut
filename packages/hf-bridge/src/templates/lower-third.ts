import type { HfTemplate } from "../types";
import { buildCompShell, SET_TEXT_HELPER } from "./comp-shell";

export const lowerThird: HfTemplate = {
	id: "lower-third",
	name: "Lower third",
	description: "Name/title bar in the lower left or right with an accent underline.",
	whenToUse:
		"Introducing a person, product, or place the speaker just mentioned; labeling who is talking.",
	variables: [
		{ id: "title", type: "string", label: "Title", default: "Dan Reola" },
		{ id: "subtitle", type: "string", label: "Subtitle", default: "FrameCut" },
		{ id: "accent", type: "color", label: "Accent", default: "#FF6E20" },
		{
			id: "align",
			type: "enum",
			label: "Align",
			default: "left",
			options: [
				{ value: "left", label: "Left" },
				{ value: "right", label: "Right" },
			],
		},
	],
	minDurationSec: 3,
	maxDurationSec: 7,
	buildCompHtml: ({ width, height, durationSec }) =>
		buildCompShell({
			width,
			height,
			durationSec,
			variables: lowerThird.variables,
			css: `
.clip { position: absolute; inset: 0; font-family: Inter, "Helvetica Neue", Arial, sans-serif; }
.lt-wrap {
	position: absolute;
	bottom: ${Math.round(height * 0.085)}px;
	display: flex; flex-direction: column; gap: 0;
	max-width: ${Math.round(width * 0.46)}px;
}
.lt-wrap.align-left { left: ${Math.round(width * 0.052)}px; align-items: flex-start; }
.lt-wrap.align-right { right: ${Math.round(width * 0.052)}px; align-items: flex-end; }
.lt-card {
	overflow: hidden;
	background: rgba(10, 12, 16, 0.82);
	border: 1px solid rgba(255, 255, 255, 0.10);
	border-radius: 10px;
	padding: ${Math.round(height * 0.020)}px ${Math.round(height * 0.034)}px;
	box-shadow: 0 14px 40px rgba(0, 0, 0, 0.35);
}
.lt-title {
	color: #F5F2EC; font-size: ${Math.round(height * 0.044)}px; font-weight: 700;
	letter-spacing: 0.01em; line-height: 1.18; white-space: nowrap;
}
.lt-subtitle {
	color: rgba(245, 242, 236, 0.72); font-size: ${Math.round(height * 0.026)}px;
	font-weight: 500; letter-spacing: 0.06em; text-transform: uppercase;
	margin-top: ${Math.round(height * 0.006)}px; white-space: nowrap;
}
.lt-underline {
	height: ${Math.max(4, Math.round(height * 0.006))}px;
	width: 100%; background: var(--accent, #FF6E20);
	border-radius: 999px; margin-top: ${Math.round(height * 0.010)}px;
	transform-origin: left center;
}
.align-right .lt-underline { transform-origin: right center; }
`,
			bodyHtml: `
<div class="lt-wrap" id="lt-wrap">
	<div class="lt-card" id="lt-card">
		<div class="lt-title" id="lt-title"></div>
		<div class="lt-subtitle" id="lt-subtitle"></div>
	</div>
	<div class="lt-underline" id="lt-underline"></div>
</div>
`,
			timelineJs: `
${SET_TEXT_HELPER}
setText("lt-title", VARS.title);
setText("lt-subtitle", VARS.subtitle);
setAccent(VARS.accent);
document.getElementById("lt-wrap").classList.add(VARS.align === "right" ? "align-right" : "align-left");
const slideX = VARS.align === "right" ? 60 : -60;

tl.from("#lt-card", { x: slideX, opacity: 0, duration: 0.55, ease: "power3.out" }, 0.15);
tl.from("#lt-title", { y: 18, opacity: 0, duration: 0.45, ease: "power2.out" }, 0.3);
tl.from("#lt-subtitle", { y: 14, opacity: 0, duration: 0.4, ease: "sine.out" }, 0.42);
tl.from("#lt-underline", { scaleX: 0, duration: 0.5, ease: "expo.out" }, 0.5);

tl.to("#lt-wrap", { opacity: 0, y: 16, duration: 0.4, ease: "power2.in" }, EXIT_AT);
tl.set("#lt-wrap", { opacity: 0 }, EXIT_AT + 0.45);
`,
		}),
};
