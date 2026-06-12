import type { ParamDefinition } from "@/params";
import { applyAlignedStroke } from "../stroke";
import { STROKE_ALIGN_PARAM, type GraphicStrokeAlign } from "./shared";
import type { GraphicDefinition } from "../types";

/**
 * Custom shape drawn with the Pen tool: a closed polygon whose points are
 * stored normalized (0..1) in the shape's own bounding box. Premiere-style
 * mask controls: feather softens the edge, expand grows/shrinks the shape
 * around its center.
 */

interface PathParams {
	points: string;
	fill: string;
	stroke: string;
	strokeWidth: number;
	strokeAlign: GraphicStrokeAlign;
	feather: number;
	expand: number;
}

const PATH_PARAMS: ParamDefinition<keyof PathParams & string>[] = [
	{
		key: "fill",
		label: "Fill",
		type: "color",
		default: "#ffffff",
	},
	{
		key: "feather",
		label: "Feather",
		type: "number",
		default: 0,
		min: 0,
		max: 100,
		step: 1,
		shortLabel: "F",
	},
	{
		key: "expand",
		label: "Expand",
		type: "number",
		default: 0,
		min: -50,
		max: 100,
		step: 1,
		shortLabel: "E",
	},
	{
		key: "stroke",
		label: "Color",
		type: "color",
		default: "#000000",
		group: "stroke",
	},
	{
		key: "strokeWidth",
		label: "Width",
		type: "number",
		default: 0,
		min: 0,
		max: 64,
		step: 1,
		shortLabel: "W",
		group: "stroke",
	},
	STROKE_ALIGN_PARAM,
	{
		key: "points",
		label: "Points (pen data)",
		type: "text",
		default: "[]",
	},
];

function parsePoints(raw: unknown): [number, number][] {
	try {
		const parsed = JSON.parse(String(raw ?? "[]")) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(p): p is [number, number] =>
				Array.isArray(p) &&
				p.length === 2 &&
				typeof p[0] === "number" &&
				typeof p[1] === "number",
		);
	} catch {
		return [];
	}
}

export const pathGraphicDefinition: GraphicDefinition = {
	id: "custom-path",
	name: "Custom shape",
	keywords: ["pen", "path", "custom", "draw", "shape"],
	params: PATH_PARAMS,
	render({ ctx, params, width, height }) {
		const points = parsePoints(params.points);
		ctx.clearRect(0, 0, width, height);
		if (points.length < 3) return;

		const fill = String(params.fill ?? "#ffffff");
		const stroke = String(params.stroke ?? "#000000");
		const strokeWidth = Math.max(0, Number(params.strokeWidth ?? 0));
		const strokeAlign = (params.strokeAlign ?? "center") as GraphicStrokeAlign;
		const feather = Math.max(0, Number(params.feather ?? 0));
		const expand = Number(params.expand ?? 0);

		// Expand grows/shrinks around the shape's centroid (Premiere-style
		// approximation of edge expansion).
		const scale = Math.max(0.01, 1 + expand / 100);
		let cx = 0;
		let cy = 0;
		for (const [x, y] of points) {
			cx += x;
			cy += y;
		}
		cx /= points.length;
		cy /= points.length;

		const path = new Path2D();
		points.forEach(([nx, ny], index) => {
			const x = (cx + (nx - cx) * scale) * width;
			const y = (cy + (ny - cy) * scale) * height;
			if (index === 0) path.moveTo(x, y);
			else path.lineTo(x, y);
		});
		path.closePath();

		const previousFilter = ctx.filter;
		if (feather > 0) {
			// Canvas blur radius scales with the 512px source; the element's
			// transform scale carries it to screen size.
			ctx.filter = `blur(${feather}px)`;
		}
		ctx.fillStyle = fill;
		ctx.fill(path);
		if (strokeWidth > 0) {
			applyAlignedStroke({
				ctx,
				path,
				strokeWidth,
				strokeAlign,
				strokeColor: stroke,
			});
		}
		ctx.filter = previousFilter;
	},
};
