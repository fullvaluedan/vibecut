import { describe, expect, test } from "bun:test";
import { anchorCenterOffset } from "../anchor-offset";

const closeTo = ({
	actual,
	expected,
	digits = 6,
}: {
	actual: number;
	expected: number;
	digits?: number;
}) => expect(actual).toBeCloseTo(expected, digits);

describe("anchorCenterOffset", () => {
	test("center anchor never moves the center (export-safe guard)", () => {
		// For ANY scale/rotation a default (0,0) anchor must yield (0,0) so the
		// emitted quad — and therefore the exported pixels — is unchanged.
		const cases = [
			{ scaleX: 1, scaleY: 1, rotateDeg: 0 },
			{ scaleX: 2, scaleY: 0.5, rotateDeg: 37 },
			{ scaleX: -3, scaleY: 4, rotateDeg: -123 },
			{ scaleX: 1, scaleY: 1, rotateDeg: 360 },
		];
		for (const c of cases) {
			expect(anchorCenterOffset({ anchor: { x: 0, y: 0 }, ...c })).toEqual({
				dx: 0,
				dy: 0,
			});
		}
	});

	test("no scale, no rotation → anchor stays put (zero offset)", () => {
		const { dx, dy } = anchorCenterOffset({
			anchor: { x: 10, y: -20 },
			scaleX: 1,
			scaleY: 1,
			rotateDeg: 0,
		});
		closeTo({ actual: dx, expected: 0 });
		closeTo({ actual: dy, expected: 0 });
	});

	test("anchor (10,0) + 90° rotate → expected offset", () => {
		// offset = a − R(90°)·S·a. With S=I: R(90°)·(10,0) = (0,10).
		// offset = (10,0) − (0,10) = (10,-10).
		const { dx, dy } = anchorCenterOffset({
			anchor: { x: 10, y: 0 },
			scaleX: 1,
			scaleY: 1,
			rotateDeg: 90,
		});
		closeTo({ actual: dx, expected: 10 });
		closeTo({ actual: dy, expected: -10 });
	});

	test("anchor (10,0) + 2× uniform scale → expected offset", () => {
		// S·a = (20,0), no rotation. offset = (10,0) − (20,0) = (-10,0).
		const { dx, dy } = anchorCenterOffset({
			anchor: { x: 10, y: 0 },
			scaleX: 2,
			scaleY: 2,
			rotateDeg: 0,
		});
		closeTo({ actual: dx, expected: -10 });
		closeTo({ actual: dy, expected: 0 });
	});

	test("anchor (0,10) + 2× scaleY + 90° rotate", () => {
		// S·a = (0,20); R(90°)·(0,20) = (-20,0).
		// offset = (0,10) − (-20,0) = (20,10).
		const { dx, dy } = anchorCenterOffset({
			anchor: { x: 0, y: 10 },
			scaleX: 1,
			scaleY: 2,
			rotateDeg: 90,
		});
		closeTo({ actual: dx, expected: 20 });
		closeTo({ actual: dy, expected: 10 });
	});

	test("180° rotation doubles the anchor displacement", () => {
		// R(180°)·(8,6) = (-8,-6). offset = (8,6) − (-8,-6) = (16,12).
		const { dx, dy } = anchorCenterOffset({
			anchor: { x: 8, y: 6 },
			scaleX: 1,
			scaleY: 1,
			rotateDeg: 180,
		});
		closeTo({ actual: dx, expected: 16 });
		closeTo({ actual: dy, expected: 12 });
	});

	test("round-trip sanity: the anchor point stays fixed under the transform", () => {
		// The anchor's screen position is center + R·S·a; after shifting the
		// center by the offset it must equal the original anchor position
		// (center + a). i.e. (center + offset) + R·S·a === center + a.
		const anchor = { x: 13, y: -7 };
		const scaleX = 1.5;
		const scaleY = 0.8;
		const rotateDeg = 50;
		const { dx, dy } = anchorCenterOffset({
			anchor,
			scaleX,
			scaleY,
			rotateDeg,
		});
		const rad = (rotateDeg * Math.PI) / 180;
		const sx = anchor.x * scaleX;
		const sy = anchor.y * scaleY;
		const rx = sx * Math.cos(rad) - sy * Math.sin(rad);
		const ry = sx * Math.sin(rad) + sy * Math.cos(rad);
		// New anchor screen pos relative to original center:
		closeTo({ actual: dx + rx, expected: anchor.x });
		closeTo({ actual: dy + ry, expected: anchor.y });
	});
});
