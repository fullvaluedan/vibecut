import type { HfTemplate } from "../types";
import { buildCompShell, SET_TEXT_HELPER } from "./comp-shell";

export const calloutPill: HfTemplate = {
	id: "callout-pill",
	name: "Callout pill",
	description: "A small badge with a glowing dot and short text, tucked into a corner.",
	whenToUse:
		"Side notes, tips, corrections, links, or 'watch this part' nudges that should not dominate the frame.",
	variables: [
		{ id: "text", type: "string", label: "Text", default: "Pro tip" },
		{ id: "accent", type: "color", label: "Accent", default: "#FF6E20" },
		{
			id: "corner",
			type: "enum",
			label: "Corner",
			default: "top-right",
			options: [
				{ value: "top-left", label: "Top left" },
				{ value: "top-right", label: "Top right" },
				{ value: "bottom-left", label: "Bottom left" },
				{ value: "bottom-right", label: "Bottom right" },
			],
		},
	],
	minDurationSec: 2,
	maxDurationSec: 8,
	buildCompHtml: ({ width, height, durationSec }) =>
		buildCompShell({
			width,
			height,
			durationSec,
			variables: calloutPill.variables,
			css: `
.clip { position: absolute; inset: 0; font-family: Inter, "Helvetica Neue", Arial, sans-serif; }
.cp-pill {
	position: absolute;
	display: flex; align-items: center; gap: ${Math.round(height * 0.012)}px;
	background: rgba(10, 12, 16, 0.82);
	border: 1px solid rgba(255, 255, 255, 0.12);
	border-radius: 999px;
	padding: ${Math.round(height * 0.013)}px ${Math.round(height * 0.026)}px;
	box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
	max-width: ${Math.round(width * 0.4)}px;
}
.cp-pill.top-left { top: ${Math.round(height * 0.06)}px; left: ${Math.round(width * 0.04)}px; }
.cp-pill.top-right { top: ${Math.round(height * 0.06)}px; right: ${Math.round(width * 0.04)}px; }
.cp-pill.bottom-left { bottom: ${Math.round(height * 0.06)}px; left: ${Math.round(width * 0.04)}px; }
.cp-pill.bottom-right { bottom: ${Math.round(height * 0.06)}px; right: ${Math.round(width * 0.04)}px; }
.cp-dot {
	width: ${Math.round(height * 0.018)}px; height: ${Math.round(height * 0.018)}px;
	border-radius: 50%; background: var(--accent, #FF6E20);
	box-shadow: 0 0 ${Math.round(height * 0.02)}px var(--accent, #FF6E20);
	flex-shrink: 0;
}
.cp-text {
	color: #F5F2EC; font-size: ${Math.round(height * 0.030)}px;
	font-weight: 600; line-height: 1.25; white-space: nowrap;
	overflow: hidden; text-overflow: ellipsis;
}
`,
			bodyHtml: `
<div class="cp-pill" id="cp-pill">
	<div class="cp-dot" id="cp-dot"></div>
	<div class="cp-text" id="cp-text"></div>
</div>
`,
			timelineJs: `
${SET_TEXT_HELPER}
setAccent(VARS.accent);
setText("cp-text", VARS.text);
const corner = ["top-left","top-right","bottom-left","bottom-right"].includes(VARS.corner) ? VARS.corner : "top-right";
document.getElementById("cp-pill").classList.add(corner);
const fromY = corner.startsWith("top") ? -36 : 36;

tl.from("#cp-pill", { y: fromY, opacity: 0, duration: 0.5, ease: "back.out(1.7)" }, 0.2);
let pulses = Math.max(1, Math.ceil((DURATION - 1.6) / 1.4) - 1);
if (pulses % 2 === 0) pulses += 1; // odd repeats end yoyo back at scale 1
tl.to("#cp-dot", { scale: 1.45, duration: 0.7, ease: "sine.inOut", repeat: pulses, yoyo: true }, 0.8);
tl.set("#cp-dot", { scale: 1 }, EXIT_AT); // hard kill against seek drift

tl.to("#cp-pill", { y: fromY * 0.6, opacity: 0, duration: 0.35, ease: "power2.in" }, EXIT_AT);
tl.set("#cp-pill", { opacity: 0 }, EXIT_AT + 0.4);
`,
		}),
};
