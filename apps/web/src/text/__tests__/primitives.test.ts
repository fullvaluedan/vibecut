import { describe, expect, test } from "bun:test";
import {
	drawMeasuredTextLayout,
	isTextShadowActive,
	isTextStrokeActive,
	type MeasuredTextLayout,
	type TextCanvasContext,
} from "@/text/primitives";
import { DEFAULTS } from "@/timeline/defaults";

/**
 * U3 (text round): stroke + drop shadow on plain text. `strokeMeasuredTextLayout`
 * already existed (wired only to the mask system); this wires it - plus a new
 * canvas shadow addition - into the shared text draw path both preview and
 * export call (services/renderer/nodes/text-node.ts -> drawMeasuredTextLayout).
 *
 * These tests use a hand-rolled fake 2D context that just records calls, since
 * this repo's `bun test` has no DOM / real canvas.
 */

function buildFakeCtx() {
	const calls: string[] = [];
	const ctx = {
		font: "",
		textAlign: "center" as CanvasTextAlign,
		textBaseline: "middle" as CanvasTextBaseline,
		fillStyle: "" as string | CanvasGradient | CanvasPattern,
		strokeStyle: "" as string | CanvasGradient | CanvasPattern,
		lineWidth: 0,
		lineJoin: "miter" as CanvasLineJoin,
		lineCap: "butt" as CanvasLineCap,
		shadowColor: "",
		shadowBlur: 0,
		shadowOffsetX: 0,
		shadowOffsetY: 0,
		save() {},
		restore() {},
		beginPath() {},
		roundRect() {},
		fill() {
			calls.push("fill");
		},
		fillRect() {
			calls.push("fillRect");
		},
		fillText(text: string) {
			calls.push(
				`fillText:${text}:shadow=${ctx.shadowColor}:${ctx.shadowBlur}:${ctx.shadowOffsetX}:${ctx.shadowOffsetY}`,
			);
		},
		strokeText(text: string) {
			calls.push(`strokeText:${text}:${String(ctx.strokeStyle)}:${ctx.lineWidth}`);
		},
	};
	return { ctx: ctx as unknown as TextCanvasContext, raw: ctx, calls };
}

const layout: MeasuredTextLayout = {
	scaledFontSize: 40,
	fontString: '40px "Arial", sans-serif',
	letterSpacing: 0,
	lineHeightPx: 48,
	fontSizeRatio: 1,
	textAlign: "center",
	textDecoration: "none",
	lines: ["Hello"],
	lineMetrics: [
		{
			width: 100,
			actualBoundingBoxAscent: 30,
			actualBoundingBoxDescent: 8,
		} as TextMetrics,
	],
	block: { visualCenterOffset: 0, height: 48, maxWidth: 100 },
};

describe("isTextStrokeActive", () => {
	test("the inert default (width 0) is inactive", () => {
		expect(isTextStrokeActive({ stroke: DEFAULTS.text.stroke })).toBe(false);
	});

	test("no stroke argument at all is inactive", () => {
		expect(isTextStrokeActive({})).toBe(false);
	});

	test("a positive width is active", () => {
		expect(isTextStrokeActive({ stroke: { color: "#000000", width: 2 } })).toBe(
			true,
		);
	});
});

describe("isTextShadowActive", () => {
	test("the inert default (zero blur, zero offsets) is inactive", () => {
		expect(isTextShadowActive({ shadow: DEFAULTS.text.shadow })).toBe(false);
	});

	test("no shadow argument at all is inactive", () => {
		expect(isTextShadowActive({})).toBe(false);
	});

	test("nonzero blur alone is active", () => {
		expect(
			isTextShadowActive({
				shadow: { color: "#000000", blur: 4, offsetX: 0, offsetY: 0 },
			}),
		).toBe(true);
	});

	test("nonzero offset alone is active even at zero blur (a hard-edged shadow is still visible)", () => {
		expect(
			isTextShadowActive({
				shadow: { color: "#000000", blur: 0, offsetX: 3, offsetY: 0 },
			}),
		).toBe(true);
	});
});

describe("drawMeasuredTextLayout: stroke + shadow render descriptor", () => {
	test("omitting stroke/shadow entirely is byte-identical to the pre-U3 draw path (mask system's existing call shape)", () => {
		const { ctx, calls } = buildFakeCtx();
		drawMeasuredTextLayout({ ctx, layout, textColor: "#ffffff", background: null });
		expect(calls).toEqual(["fillText:Hello:shadow=:0:0:0"]);
	});

	test("the inert default param set (strokeWidth 0, shadowBlur 0, zero offsets) is a true no-op: no strokeText call, no shadow ever assigned", () => {
		const { ctx, calls } = buildFakeCtx();
		drawMeasuredTextLayout({
			ctx,
			layout,
			textColor: "#ffffff",
			stroke: DEFAULTS.text.stroke,
			shadow: DEFAULTS.text.shadow,
		});
		expect(calls.some((c) => c.startsWith("strokeText"))).toBe(false);
		expect(calls).toEqual(["fillText:Hello:shadow=:0:0:0"]);
	});

	test("a positive stroke width draws a full stroke pass before the fill, using strokeMeasuredTextLayout", () => {
		const { ctx, calls } = buildFakeCtx();
		drawMeasuredTextLayout({
			ctx,
			layout,
			textColor: "#ffffff",
			stroke: { color: "#112233", width: 3 },
		});
		expect(calls[0]).toBe("strokeText:Hello:#112233:3");
		expect(calls[1]).toBe("fillText:Hello:shadow=:0:0:0");
	});

	test("an active shadow is set on the context right before the fill draw, and cleared after", () => {
		const { ctx, raw, calls } = buildFakeCtx();
		drawMeasuredTextLayout({
			ctx,
			layout,
			textColor: "#ffffff",
			shadow: { color: "#ff0000", blur: 6, offsetX: 2, offsetY: 4 },
		});
		expect(calls).toEqual(["fillText:Hello:shadow=#ff0000:6:2:4"]);
		expect(raw.shadowColor).toBe("transparent");
		expect(raw.shadowBlur).toBe(0);
		expect(raw.shadowOffsetX).toBe(0);
		expect(raw.shadowOffsetY).toBe(0);
	});

	test("stroke and shadow together: stroke pass unaffected, shadow only applies to the fill", () => {
		const { ctx, calls } = buildFakeCtx();
		drawMeasuredTextLayout({
			ctx,
			layout,
			textColor: "#ffffff",
			stroke: { color: "#000000", width: 2 },
			shadow: { color: "#ff0000", blur: 5, offsetX: 0, offsetY: 2 },
		});
		expect(calls[0]).toBe("strokeText:Hello:#000000:2");
		expect(calls[1]).toBe("fillText:Hello:shadow=#ff0000:5:0:2");
	});
});
