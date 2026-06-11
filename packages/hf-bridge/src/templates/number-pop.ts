import type { HfTemplate } from "../types";
import { buildCompShell, SET_TEXT_HELPER } from "./comp-shell";

export const numberPop: HfTemplate = {
	id: "number-pop",
	name: "Number pop",
	description: "A huge counting-up statistic with a label underneath.",
	whenToUse:
		"The speaker cites a specific number, percentage, price, or metric worth emphasizing.",
	variables: [
		{ id: "value", type: "string", label: "Value (e.g. 87%, $1.2M, 10x)", default: "87%" },
		{ id: "label", type: "string", label: "Label", default: "of editors agree" },
		{ id: "accent", type: "color", label: "Accent", default: "#FF6E20" },
	],
	minDurationSec: 2.5,
	maxDurationSec: 6,
	buildCompHtml: ({ width, height, durationSec }) =>
		buildCompShell({
			width,
			height,
			durationSec,
			variables: numberPop.variables,
			css: `
.clip { position: absolute; inset: 0; font-family: Inter, "Helvetica Neue", Arial, sans-serif; }
.np-stage {
	position: absolute; inset: 0;
	display: flex; flex-direction: column; align-items: center; justify-content: center;
	gap: ${Math.round(height * 0.012)}px;
}
.np-value {
	color: var(--accent, #FF6E20);
	font-size: ${Math.round(height * 0.21)}px;
	font-weight: 800; line-height: 1;
	font-variant-numeric: tabular-nums;
	letter-spacing: -0.02em;
	text-shadow: 0 10px 44px rgba(0, 0, 0, 0.5);
}
.np-label {
	color: #F5F2EC;
	font-size: ${Math.round(height * 0.040)}px;
	font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase;
	background: rgba(10, 12, 16, 0.78);
	border: 1px solid rgba(255, 255, 255, 0.10);
	border-radius: 999px;
	padding: ${Math.round(height * 0.012)}px ${Math.round(height * 0.034)}px;
}
`,
			bodyHtml: `
<div class="np-stage" id="np-stage">
	<div class="np-value" id="np-value"></div>
	<div class="np-label" id="np-label"></div>
</div>
`,
			timelineJs: `
${SET_TEXT_HELPER}
setAccent(VARS.accent);
setText("np-label", VARS.label);

const raw = String(VARS.value).trim();
const match = raw.match(/^([^0-9]*)([0-9][0-9.,]*)(.*)$/);
const valueEl = document.getElementById("np-value");
if (match) {
	const prefix = match[1];
	const target = parseFloat(match[2].replace(/,/g, ""));
	const suffix = match[3];
	const decimals = (match[2].split(".")[1] || "").length;
	const counter = { v: 0 };
	valueEl.textContent = prefix + (0).toFixed(decimals) + suffix;
	tl.to(counter, {
		v: target,
		duration: 1.1,
		ease: "power2.out",
		onUpdate: () => {
			valueEl.textContent = prefix + counter.v.toFixed(decimals) + suffix;
		},
	}, 0.3);
} else {
	valueEl.textContent = raw;
}

tl.from("#np-value", { scale: 0.6, opacity: 0, duration: 0.55, ease: "back.out(2)" }, 0.15);
tl.from("#np-label", { y: 26, opacity: 0, duration: 0.45, ease: "power3.out" }, 0.5);

tl.to("#np-stage", { opacity: 0, scale: 0.96, duration: 0.4, ease: "power2.in" }, EXIT_AT);
tl.set("#np-stage", { opacity: 0 }, EXIT_AT + 0.45);
`,
		}),
};
