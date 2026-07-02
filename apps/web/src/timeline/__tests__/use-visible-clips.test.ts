import { describe, expect, test } from "bun:test";
import {
	selectVisibleSpans,
	type VisibleWindow,
} from "@/timeline/hooks/use-visible-clips";

interface Span {
	id: string;
	start: number;
	end: number;
}

/** N contiguous 10px-wide clips: clip i occupies [10i, 10i + 10]. */
function contiguousClips(count: number): Span[] {
	return Array.from({ length: count }, (_, i) => ({
		id: `clip-${i}`,
		start: i * 10,
		end: i * 10 + 10,
	}));
}

const ids = (spans: Span[]) => spans.map((s) => s.id);

describe("selectVisibleSpans", () => {
	test("413 clips: only those intersecting [start-overscan, end+overscan] are returned", () => {
		const spans = contiguousClips(413);
		// Visible pixel window [1000, 1200], overscan 50 => keep [950, 1250].
		// clip i kept iff 10i <= 1250 && 10i+10 >= 950  =>  i in [94, 125].
		const window: VisibleWindow = { start: 1000, end: 1200, overscan: 50 };
		const visible = selectVisibleSpans({ spans, window });
		expect(visible).toHaveLength(32);
		expect(visible[0].id).toBe("clip-94");
		expect(visible[visible.length - 1].id).toBe("clip-125");
		// Nothing outside the grown window slips through.
		expect(ids(visible)).not.toContain("clip-93");
		expect(ids(visible)).not.toContain("clip-126");
	});

	test("a clip exactly at either viewport edge is included (touch counts)", () => {
		const window: VisibleWindow = { start: 100, end: 200, overscan: 0 };
		const spans: Span[] = [
			{ id: "left-touch", start: 0, end: 100 }, // end === lo
			{ id: "right-touch", start: 200, end: 300 }, // start === hi
			{ id: "just-left", start: 0, end: 99 }, // ends before lo
			{ id: "just-right", start: 201, end: 300 }, // starts after hi
		];
		const visible = ids(selectVisibleSpans({ spans, window }));
		expect(visible).toContain("left-touch");
		expect(visible).toContain("right-touch");
		expect(visible).not.toContain("just-left");
		expect(visible).not.toContain("just-right");
	});

	test("the active drag target is retained even when its span leaves the window", () => {
		const window: VisibleWindow = { start: 0, end: 100, overscan: 10 };
		const spans: Span[] = [
			{ id: "on-screen", start: 20, end: 40 },
			{ id: "dragged-away", start: 5000, end: 5100 }, // far outside
		];
		// Without force-include the off-screen clip is culled.
		expect(ids(selectVisibleSpans({ spans, window }))).not.toContain(
			"dragged-away",
		);
		// A Set (or Map) satisfies the `.has(id)` force-include contract.
		const forceInclude = new Set(["dragged-away"]);
		const visible = ids(selectVisibleSpans({ spans, window, forceInclude }));
		expect(visible).toContain("dragged-away");
		expect(visible).toContain("on-screen");
	});

	test("empty window (scrolled past all clips) returns nothing without error", () => {
		const spans = contiguousClips(50); // spans [0, 500]
		const window: VisibleWindow = { start: 10000, end: 11000, overscan: 0 };
		expect(selectVisibleSpans({ spans, window })).toHaveLength(0);
	});

	test("overscan is applied on both sides", () => {
		const window: VisibleWindow = { start: 1000, end: 1000, overscan: 100 };
		// Grown window is [900, 1100].
		const spans: Span[] = [
			{ id: "in-left-overscan", start: 900, end: 910 }, // within left overscan
			{ id: "beyond-left", start: 880, end: 890 }, // just outside left overscan
			{ id: "in-right-overscan", start: 1090, end: 1100 }, // within right overscan
			{ id: "beyond-right", start: 1110, end: 1120 }, // just outside right overscan
		];
		const visible = ids(selectVisibleSpans({ spans, window }));
		expect(visible).toContain("in-left-overscan");
		expect(visible).toContain("in-right-overscan");
		expect(visible).not.toContain("beyond-left");
		expect(visible).not.toContain("beyond-right");
	});
});
