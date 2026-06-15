/**
 * Anchor Point pivot math — PURE and wasm-free (importing `@/wasm` here is
 * forbidden so this stays unit-testable under bun).
 *
 * The WASM compositor pivots scale + rotation about the quad CENTER. To make
 * the pivot an arbitrary anchor instead, we keep emitting a center-pivoted
 * quad and instead displace the quad's centerX/centerY by a compensating
 * offset so the chosen anchor point lands where it would under a true
 * anchor-pivoted transform.
 *
 * Derivation: a point at element-local offset `a` from the center maps, under
 * a center-pivoted scale-then-rotate, to `R(θ)·S·a` relative to the center.
 * For the anchor to stay fixed in screen space, the center must move by
 *
 *     offset = a − R(θ)·S·a
 *
 * When `a = (0,0)` the offset is exactly (0,0) for ANY scale/rotation — this
 * is the export-safe guard: a default (center) anchor changes nothing, so
 * output stays byte-identical to today.
 */

export interface AnchorCenterOffsetInput {
	/** Anchor in element-local pixels, offset from the element center. */
	anchor: { x: number; y: number };
	/** Horizontal scale factor applied to the element (1 = unscaled). */
	scaleX: number;
	/** Vertical scale factor applied to the element (1 = unscaled). */
	scaleY: number;
	/** Rotation in degrees, matching the compositor's `rotationDegrees`. */
	rotateDeg: number;
}

/**
 * Returns the {dx,dy} to ADD to the center-pivoted quad's centerX/centerY so
 * scale/rotation pivot about `anchor` instead of the element center. Returns
 * {dx:0,dy:0} when the anchor is at its default (0,0).
 */
export function anchorCenterOffset({
	anchor,
	scaleX,
	scaleY,
	rotateDeg,
}: AnchorCenterOffsetInput): { dx: number; dy: number } {
	// Fast path / exact identity: a center anchor never moves the center.
	if (anchor.x === 0 && anchor.y === 0) {
		return { dx: 0, dy: 0 };
	}

	// Scale the anchor (S·a).
	const sx = anchor.x * scaleX;
	const sy = anchor.y * scaleY;

	// Rotate the scaled anchor (R(θ)·S·a) using a CCW-positive rotation.
	const radians = (rotateDeg * Math.PI) / 180;
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);
	const rx = sx * cos - sy * sin;
	const ry = sx * sin + sy * cos;

	// offset = a − R(θ)·S·a
	return {
		dx: anchor.x - rx,
		dy: anchor.y - ry,
	};
}
