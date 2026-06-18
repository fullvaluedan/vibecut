import { describe, expect, test } from "bun:test";
import {
	type ClipSpan,
	type DropPlan,
	planClipDrop,
} from "../overwrite-plan";

// --- Plan simulator (the real correctness check) -------------------------
//
// Mirrors exactly what the integration layer does with a DropPlan, in pure
// timeline-time, so the tests can assert the RESULTING layout has no overlaps
// and preserves content. Order matches the documented integration sequence:
// split -> (overwrite) delete-in-range -> (insert) ripple -> insert incoming.

interface Frag {
	start: number;
	end: number;
}

function applyPlan({
	clips,
	incoming,
	plan,
}: {
	clips: ClipSpan[];
	incoming: { start: number; end: number };
	plan: DropPlan;
}): Frag[] {
	// 1. Split every clip at each split time it strictly straddles.
	let frags: Frag[] = [];
	for (const clip of clips) {
		let segments: Frag[] = [
			{ start: clip.startTime, end: clip.startTime + clip.duration },
		];
		for (const t of plan.splitTimes) {
			segments = segments.flatMap((s) =>
				s.start < t && t < s.end
					? [
							{ start: s.start, end: t },
							{ start: t, end: s.end },
						]
					: [s],
			);
		}
		frags.push(...segments);
	}

	// 2. OVERWRITE: delete fragments fully inside the delete range.
	if (plan.deleteRange) {
		const { start, end } = plan.deleteRange;
		frags = frags.filter((f) => !(f.start >= start && f.end <= end));
	}

	// 3. INSERT: ripple fragments at/after fromTime right by deltaTicks.
	if (plan.rippleShift) {
		const { fromTime, deltaTicks } = plan.rippleShift;
		frags = frags.map((f) =>
			f.start >= fromTime
				? { start: f.start + deltaTicks, end: f.end + deltaTicks }
				: f,
		);
	}

	// 4. Insert the incoming clip.
	frags.push({ start: incoming.start, end: incoming.end });

	return frags.sort((a, b) => a.start - b.start);
}

function hasOverlap(frags: Frag[]): boolean {
	for (let i = 1; i < frags.length; i++) {
		if (frags[i].start < frags[i - 1].end) return true;
	}
	return false;
}

function totalLength(frags: Frag[]): number {
	return frags.reduce((sum, f) => sum + (f.end - f.start), 0);
}

const clip = (startTime: number, duration: number): ClipSpan => ({
	startTime,
	duration,
});

// --- OVERWRITE ----------------------------------------------------------

describe("planClipDrop — overwrite", () => {
	test("disjoint clip is untouched; drop zone is the carve range", () => {
		const plan = planClipDrop({
			existingClips: [clip(0, 100)],
			incomingStart: 200,
			incomingEnd: 300,
		});
		expect(plan).toEqual({
			splitTimes: [],
			deleteRange: { start: 200, end: 300 },
			rippleShift: null,
		});
	});

	test("clip touching at A (end == A) does not overlap", () => {
		const plan = planClipDrop({
			existingClips: [clip(0, 100)],
			incomingStart: 100,
			incomingEnd: 200,
		});
		expect(plan.splitTimes).toEqual([]);
	});

	test("clip touching at B (start == B) does not overlap", () => {
		const plan = planClipDrop({
			existingClips: [clip(200, 100)],
			incomingStart: 100,
			incomingEnd: 200,
		});
		expect(plan.splitTimes).toEqual([]);
	});

	test("clip straddling A only splits at A", () => {
		const plan = planClipDrop({
			existingClips: [clip(50, 100)], // [50,150)
			incomingStart: 100,
			incomingEnd: 200,
		});
		expect(plan.splitTimes).toEqual([100]);
	});

	test("clip straddling B only splits at B", () => {
		const plan = planClipDrop({
			existingClips: [clip(150, 100)], // [150,250)
			incomingStart: 100,
			incomingEnd: 200,
		});
		expect(plan.splitTimes).toEqual([200]);
	});

	test("clip enclosing the drop zone splits at both A and B", () => {
		const plan = planClipDrop({
			existingClips: [clip(50, 250)], // [50,300)
			incomingStart: 100,
			incomingEnd: 200,
		});
		expect(plan.splitTimes).toEqual([100, 200]);
	});

	test("clip fully inside the drop zone needs no split (deleted by range)", () => {
		const plan = planClipDrop({
			existingClips: [clip(120, 40)], // [120,160)
			incomingStart: 100,
			incomingEnd: 200,
		});
		expect(plan.splitTimes).toEqual([]);
		expect(plan.deleteRange).toEqual({ start: 100, end: 200 });
	});

	test("multiple overlapping clips yield the union of split points, sorted+deduped", () => {
		const plan = planClipDrop({
			existingClips: [clip(50, 100), clip(150, 30), clip(190, 80)], // [50,150) [150,180) [190,270)
			incomingStart: 100,
			incomingEnd: 200,
		});
		expect(plan.splitTimes).toEqual([100, 200]);
	});

	test("empty track is a clean carve with no splits", () => {
		const plan = planClipDrop({
			existingClips: [],
			incomingStart: 100,
			incomingEnd: 200,
		});
		expect(plan).toEqual({
			splitTimes: [],
			deleteRange: { start: 100, end: 200 },
			rippleShift: null,
		});
	});

	test("invariant: enclosing-clip overwrite produces no overlap and exact layout", () => {
		const clips = [clip(50, 250)]; // [50,300)
		const incoming = { start: 100, end: 200 };
		const layout = applyPlan({
			clips,
			incoming,
			plan: planClipDrop({
				existingClips: clips,
				incomingStart: incoming.start,
				incomingEnd: incoming.end,
			}),
		});
		expect(hasOverlap(layout)).toBe(false);
		expect(layout).toEqual([
			{ start: 50, end: 100 },
			{ start: 100, end: 200 },
			{ start: 200, end: 300 },
		]);
	});

	test("invariant: downstream clip (start >= B) is left in place", () => {
		const clips = [clip(0, 100), clip(400, 100)];
		const incoming = { start: 100, end: 200 };
		const layout = applyPlan({
			clips,
			incoming,
			plan: planClipDrop({
				existingClips: clips,
				incomingStart: incoming.start,
				incomingEnd: incoming.end,
			}),
		});
		expect(hasOverlap(layout)).toBe(false);
		expect(layout).toContainEqual({ start: 400, end: 500 });
	});
});

// --- INSERT (true insert: deletes nothing, ripples from A) ----------------

describe("planClipDrop — insert", () => {
	test("clip before A is not rippled; the drop point is A with delta B-A", () => {
		const plan = planClipDrop({
			existingClips: [clip(0, 50)],
			incomingStart: 100,
			incomingEnd: 200,
			mode: "insert",
		});
		expect(plan).toEqual({
			splitTimes: [],
			deleteRange: null,
			rippleShift: { fromTime: 100, deltaTicks: 100 },
		});
	});

	test("clip straddling A splits at A only", () => {
		const plan = planClipDrop({
			existingClips: [clip(50, 200)], // [50,250)
			incomingStart: 100,
			incomingEnd: 200,
			mode: "insert",
		});
		expect(plan.splitTimes).toEqual([100]);
		expect(plan.deleteRange).toBeNull();
		expect(plan.rippleShift).toEqual({ fromTime: 100, deltaTicks: 100 });
	});

	test("clip straddling B but NOT A is never split in insert (regression: used to overlap)", () => {
		const plan = planClipDrop({
			existingClips: [clip(150, 100)], // [150,250)
			incomingStart: 100,
			incomingEnd: 200,
			mode: "insert",
		});
		expect(plan.splitTimes).toEqual([]);
	});

	test("invariant: straddle-B-not-A insert produces NO overlap (the old critical bug)", () => {
		const clips = [clip(150, 100)]; // [150,250)
		const incoming = { start: 100, end: 200 };
		const layout = applyPlan({
			clips,
			incoming,
			plan: planClipDrop({
				existingClips: clips,
				incomingStart: incoming.start,
				incomingEnd: incoming.end,
				mode: "insert",
			}),
		});
		expect(hasOverlap(layout)).toBe(false);
		// The clip was pushed fully right; the incoming sits in the opened gap.
		expect(layout).toEqual([
			{ start: 100, end: 200 },
			{ start: 250, end: 350 },
		]);
	});

	test("invariant: clip starting exactly at A is rippled, no overlap", () => {
		const clips = [clip(100, 150)]; // [100,250)
		const incoming = { start: 100, end: 200 };
		const layout = applyPlan({
			clips,
			incoming,
			plan: planClipDrop({
				existingClips: clips,
				incomingStart: incoming.start,
				incomingEnd: incoming.end,
				mode: "insert",
			}),
		});
		expect(hasOverlap(layout)).toBe(false);
		expect(layout).toEqual([
			{ start: 100, end: 200 },
			{ start: 200, end: 350 },
		]);
	});

	test("invariant: enclosing clip insert produces NO overlap (the old documented-overlap case)", () => {
		const clips = [clip(120, 130)]; // [120,250)
		const incoming = { start: 100, end: 200 };
		const layout = applyPlan({
			clips,
			incoming,
			plan: planClipDrop({
				existingClips: clips,
				incomingStart: incoming.start,
				incomingEnd: incoming.end,
				mode: "insert",
			}),
		});
		expect(hasOverlap(layout)).toBe(false);
	});

	test("invariant: straddle-A insert preserves total content and has no overlap", () => {
		const clips = [clip(50, 200)]; // [50,250), 200 ticks of content
		const incoming = { start: 100, end: 200 }; // 100 ticks
		const layout = applyPlan({
			clips,
			incoming,
			plan: planClipDrop({
				existingClips: clips,
				incomingStart: incoming.start,
				incomingEnd: incoming.end,
				mode: "insert",
			}),
		});
		expect(hasOverlap(layout)).toBe(false);
		expect(totalLength(layout)).toBe(200 + 100);
	});

	test("invariant: multiple clips insert — everything from A shifts, no overlap, content preserved", () => {
		const clips = [clip(0, 80), clip(150, 100), clip(300, 50)];
		const incoming = { start: 100, end: 200 };
		const layout = applyPlan({
			clips,
			incoming,
			plan: planClipDrop({
				existingClips: clips,
				incomingStart: incoming.start,
				incomingEnd: incoming.end,
				mode: "insert",
			}),
		});
		expect(hasOverlap(layout)).toBe(false);
		expect(totalLength(layout)).toBe(80 + 100 + 50 + 100);
	});

	test("empty track insert is a valid no-delete ripple plan", () => {
		const plan = planClipDrop({
			existingClips: [],
			incomingStart: 100,
			incomingEnd: 200,
			mode: "insert",
		});
		expect(plan).toEqual({
			splitTimes: [],
			deleteRange: null,
			rippleShift: { fromTime: 100, deltaTicks: 100 },
		});
	});
});

// --- Guards / policy ----------------------------------------------------

describe("planClipDrop — guards and policy", () => {
	test("default mode is overwrite", () => {
		const plan = planClipDrop({
			existingClips: [],
			incomingStart: 100,
			incomingEnd: 200,
		});
		expect(plan.deleteRange).toEqual({ start: 100, end: 200 });
		expect(plan.rippleShift).toBeNull();
	});

	test("zero-length span (A == B) is a no-op in both modes", () => {
		for (const mode of ["overwrite", "insert"] as const) {
			expect(
				planClipDrop({
					existingClips: [clip(50, 250)],
					incomingStart: 200,
					incomingEnd: 200,
					mode,
				}),
			).toEqual({ splitTimes: [], deleteRange: null, rippleShift: null });
		}
	});

	test("reversed span (A > B) is a no-op, never an invalid plan", () => {
		for (const mode of ["overwrite", "insert"] as const) {
			const plan = planClipDrop({
				existingClips: [clip(0, 1000)],
				incomingStart: 300,
				incomingEnd: 100,
				mode,
			});
			expect(plan).toEqual({
				splitTimes: [],
				deleteRange: null,
				rippleShift: null,
			});
		}
	});

	test("split times are sorted ascending and de-duplicated", () => {
		const plan = planClipDrop({
			existingClips: [clip(50, 100), clip(150, 200)], // [50,150) straddles A=100; [150,350) straddles B=200
			incomingStart: 100,
			incomingEnd: 200,
		});
		expect(plan.splitTimes).toEqual([100, 200]);
	});
});
