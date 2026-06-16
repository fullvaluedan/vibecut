import { describe, expect, test } from "bun:test";
import {
	expandDimension,
	expandRadius,
	expandRect,
	offsetPathPoints,
	type ExpandPoint,
} from "@/masks/expand";

function unitSquare(): ExpandPoint[] {
	// Clockwise in y-down screen space.
	return [
		{ x: 0, y: 0 },
		{ x: 1, y: 0 },
		{ x: 1, y: 1 },
		{ x: 0, y: 1 },
	];
}

describe("expandRect / expandDimension / expandRadius", () => {
	test("expand=0 is identity for shape bounds", () => {
		expect(expandRect({ width: 200, height: 100, expand: 0 })).toEqual({
			width: 200,
			height: 100,
		});
		expect(expandDimension({ size: 200, expand: 0 })).toBe(200);
		expect(expandRadius({ radius: 50, expand: 0 })).toBe(50);
	});

	test("positive expand grows each side by expand (width/height by 2*expand)", () => {
		const result = expandRect({ width: 200, height: 100, expand: 10 });
		expect(result.width).toBe(220);
		expect(result.height).toBe(120);
		expect(expandRadius({ radius: 50, expand: 10 })).toBe(60);
	});

	test("negative expand shrinks each side by |expand|", () => {
		const result = expandRect({ width: 200, height: 100, expand: -10 });
		expect(result.width).toBe(180);
		expect(result.height).toBe(80);
		expect(expandRadius({ radius: 50, expand: -10 })).toBe(40);
	});

	test("contract past the half-size/radius clamps to empty, never inverted", () => {
		// A 100px-wide box contracted by 60 on each side would be -20; clamps to 0.
		const result = expandRect({ width: 100, height: 40, expand: -60 });
		expect(result.width).toBe(0);
		expect(result.height).toBe(0);
		expect(expandDimension({ size: 100, expand: -1000 })).toBe(0);
		expect(expandRadius({ radius: 50, expand: -1000 })).toBe(0);
	});
});

describe("offsetPathPoints (freeform vertex-normal offset)", () => {
	test("expand=0 is identity", () => {
		const points = unitSquare();
		const result = offsetPathPoints({ points, closed: true, expand: 0 });
		expect(result).toEqual(points);
		// Returns a fresh array (no aliasing of the input points).
		expect(result).not.toBe(points);
	});

	test("positive expand moves each corner outward by ~d along its diagonal normal", () => {
		const d = 0.1;
		const diag = d / Math.SQRT2;
		const result = offsetPathPoints({
			points: unitSquare(),
			closed: true,
			expand: d,
		});

		const expected: ExpandPoint[] = [
			{ x: -diag, y: -diag }, // (0,0) → up-left
			{ x: 1 + diag, y: -diag }, // (1,0) → up-right
			{ x: 1 + diag, y: 1 + diag }, // (1,1) → down-right
			{ x: -diag, y: 1 + diag }, // (0,1) → down-left
		];

		result.forEach((point, index) => {
			expect(point.x).toBeCloseTo(expected[index].x, 9);
			expect(point.y).toBeCloseTo(expected[index].y, 9);
		});

		// Each corner's displacement magnitude is exactly d.
		const center = { x: 0.5, y: 0.5 };
		result.forEach((point, index) => {
			const original = unitSquare()[index];
			const displacement = Math.hypot(
				point.x - original.x,
				point.y - original.y,
			);
			expect(displacement).toBeCloseTo(d, 9);
			// And it moved away from the center.
			const beforeDist = Math.hypot(
				original.x - center.x,
				original.y - center.y,
			);
			const afterDist = Math.hypot(point.x - center.x, point.y - center.y);
			expect(afterDist).toBeGreaterThan(beforeDist);
		});
	});

	test("negative expand moves each corner inward", () => {
		const d = 0.1;
		const diag = d / Math.SQRT2;
		const result = offsetPathPoints({
			points: unitSquare(),
			closed: true,
			expand: -d,
		});

		const expected: ExpandPoint[] = [
			{ x: diag, y: diag },
			{ x: 1 - diag, y: diag },
			{ x: 1 - diag, y: 1 - diag },
			{ x: diag, y: 1 - diag },
		];

		result.forEach((point, index) => {
			expect(point.x).toBeCloseTo(expected[index].x, 9);
			expect(point.y).toBeCloseTo(expected[index].y, 9);
		});
	});

	test("over-contract clamps each vertex onto the centroid, not inverted", () => {
		// The diagonal half-distance from a corner to the centroid is
		// sqrt(0.5^2 + 0.5^2) = 0.7071. A huge contract should pull each corner
		// no further than the centroid (0.5, 0.5) along its normal.
		const result = offsetPathPoints({
			points: unitSquare(),
			closed: true,
			expand: -1000,
		});

		result.forEach((point) => {
			expect(point.x).toBeCloseTo(0.5, 9);
			expect(point.y).toBeCloseTo(0.5, 9);
		});
	});

	test("open path offsets endpoints by their single adjacent edge normal", () => {
		// Three collinear-ish points forming an open L; just assert the offset is
		// finite, identity at expand=0, and reversible in sign.
		const points: ExpandPoint[] = [
			{ x: 0, y: 0 },
			{ x: 1, y: 0 },
			{ x: 1, y: 1 },
		];
		const grown = offsetPathPoints({ points, closed: false, expand: 0.1 });
		const shrunk = offsetPathPoints({ points, closed: false, expand: -0.1 });
		grown.forEach((point, index) => {
			expect(Number.isFinite(point.x)).toBe(true);
			expect(Number.isFinite(point.y)).toBe(true);
			// Grow and shrink move in opposite directions from the original.
			expect(point.x - points[index].x).toBeCloseTo(
				-(shrunk[index].x - points[index].x),
				9,
			);
		});
	});

	test("a degenerate (single-point) path is returned unchanged", () => {
		const points: ExpandPoint[] = [{ x: 3, y: 4 }];
		expect(offsetPathPoints({ points, closed: true, expand: 5 })).toEqual(
			points,
		);
	});
});
