// Pure, wasm-free geometry helpers for the mask `expand` control (U8).
//
// `expand` grows (positive) or shrinks (negative) the masked REGION, distinct
// from `feather` (which softens the edge). These helpers are the single source
// of the expand math so the per-renderer draw paths and the bun tests share one
// implementation. Everything here is plain numbers — no @/wasm, no DOM.

export interface ExpandPoint {
	x: number;
	y: number;
}

/**
 * Inflate (positive) or deflate (negative) a single shape dimension by
 * `2 * expand` — the region grows by `expand` on each side. Clamps to 0 so a
 * contract past the dimension yields an empty (no-op) extent rather than an
 * inverted one.
 */
export function expandDimension({
	size,
	expand,
}: {
	size: number;
	expand: number;
}): number {
	return Math.max(0, size + expand * 2);
}

/**
 * Inflate/deflate an axis-aligned box's width and height by `expand` on each
 * side (so each grows by `2 * expand`). Used by the box-like shape masks
 * (rectangle/ellipse/heart/diamond/star/cinematic-bars). The center is
 * unchanged. Returns clamped non-negative dimensions; when either collapses to
 * 0 the caller should treat the mask as empty.
 */
export function expandRect({
	width,
	height,
	expand,
}: {
	width: number;
	height: number;
	expand: number;
}): { width: number; height: number } {
	return {
		width: expandDimension({ size: width, expand }),
		height: expandDimension({ size: height, expand }),
	};
}

/**
 * Inflate/deflate a radius by `expand`. Positive grows, negative shrinks,
 * clamped to 0 (an over-contract collapses the shape rather than inverting it).
 */
export function expandRadius({
	radius,
	expand,
}: {
	radius: number;
	expand: number;
}): number {
	return Math.max(0, radius + expand);
}

function subtract({ a, b }: { a: ExpandPoint; b: ExpandPoint }): ExpandPoint {
	return { x: a.x - b.x, y: a.y - b.y };
}

/** Left-hand outward normal of an edge vector, normalized. Zero-length → zero. */
function edgeNormal({ edge }: { edge: ExpandPoint }): ExpandPoint {
	// For a polygon wound clockwise in screen space (y-down), the outward normal
	// of an edge (dx, dy) is (dy, -dx).
	const length = Math.hypot(edge.x, edge.y);
	if (length === 0) {
		return { x: 0, y: 0 };
	}
	return { x: edge.y / length, y: -edge.x / length };
}

function isClockwise({ points }: { points: ExpandPoint[] }): boolean {
	// Shoelace signed area. In a y-down screen space, a positive signed area
	// (by this formula) corresponds to clockwise winding.
	let signedArea = 0;
	for (let index = 0; index < points.length; index++) {
		const current = points[index];
		const next = points[(index + 1) % points.length];
		signedArea += current.x * next.y - next.x * current.y;
	}
	return signedArea > 0;
}

/**
 * Offset each vertex of a path outward (positive `expand`) or inward (negative)
 * along its local normal — the average of the two adjacent edge normals for a
 * closed path, or the single adjacent edge normal at the endpoints of an open
 * path.
 *
 * This is the simple, well-tested vertex-normal offset: it does NOT handle
 * self-intersection from large contracts on concave paths (true polygon
 * offsetting is out of scope for v1). To avoid degenerate/empty output it
 * clamps so the offset never moves a vertex more than `maxContract` toward the
 * centroid; an over-contract collapses every vertex onto the centroid (an empty
 * region) rather than turning the path inside out.
 */
export function offsetPathPoints({
	points,
	closed,
	expand,
}: {
	points: ExpandPoint[];
	closed: boolean;
	expand: number;
}): ExpandPoint[] {
	if (points.length < 2 || expand === 0) {
		return points.map((point) => ({ x: point.x, y: point.y }));
	}

	const count = points.length;
	const clockwise = closed ? isClockwise({ points }) : true;
	// Outward direction flips with winding so positive expand always grows the
	// enclosed area regardless of how the path was drawn.
	const outwardSign = clockwise ? 1 : -1;

	const centroid = points.reduce(
		(accumulator, point) => ({
			x: accumulator.x + point.x / count,
			y: accumulator.y + point.y / count,
		}),
		{ x: 0, y: 0 },
	);

	return points.map((point, index) => {
		const previous = points[(index - 1 + count) % count];
		const next = points[(index + 1) % count];

		const normals: ExpandPoint[] = [];
		if (closed || index > 0) {
			normals.push(edgeNormal({ edge: subtract({ a: point, b: previous }) }));
		}
		if (closed || index < count - 1) {
			normals.push(edgeNormal({ edge: subtract({ a: next, b: point }) }));
		}

		const summed = normals.reduce(
			(accumulator, normal) => ({
				x: accumulator.x + normal.x,
				y: accumulator.y + normal.y,
			}),
			{ x: 0, y: 0 },
		);
		const summedLength = Math.hypot(summed.x, summed.y);
		const normal =
			summedLength === 0
				? { x: 0, y: 0 }
				: { x: summed.x / summedLength, y: summed.y / summedLength };

		let offset = expand * outwardSign;

		// Clamp a contract so the vertex cannot cross the centroid (which would
		// invert the region). The vertex can move inward at most up to the
		// centroid along the normal.
		if (offset < 0) {
			const towardCentroid = {
				x: centroid.x - point.x,
				y: centroid.y - point.y,
			};
			const distanceToCentroidAlongNormal =
				towardCentroid.x * normal.x + towardCentroid.y * normal.y;
			// distanceToCentroidAlongNormal is negative when the centroid lies on
			// the inward side (the expected case for a convex-ish vertex).
			const maxInward = Math.min(0, distanceToCentroidAlongNormal);
			offset = Math.max(offset, maxInward);
		}

		return {
			x: point.x + normal.x * offset,
			y: point.y + normal.y * offset,
		};
	});
}
