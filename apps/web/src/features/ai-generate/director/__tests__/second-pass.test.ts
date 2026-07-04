import { describe, expect, test } from "bun:test";
import type { DirectorOp } from "@framecut/hf-bridge";
import type { WordTiming } from "../cut-utils";
import {
	acceptedRemovalSpans,
	buildRemappedTranscript,
	forwardRemapTime,
	inverseRemapTime,
	runSecondPass,
	type RemovalSpan,
	type SecondPassSegment,
} from "../second-pass";

// ── fixtures ────────────────────────────────────────────────────────────────

/** A take: `tokens` spoken at `firstStart`, one word every 0.5s, each 0.4s long
 * (span [firstStart, firstStart + 0.5*(n-1) + 0.4]). */
function take(tokens: readonly string[], firstStart: number): WordTiming[] {
	return tokens.map((text, i) => ({
		text,
		start: firstStart + i * 0.5,
		end: firstStart + i * 0.5 + 0.4,
	}));
}

function cut(
	startSec: number,
	endSec: number,
	extra: Partial<DirectorOp> = {},
): DirectorOp {
	return {
		id: `fix-${startSec}-${endSec}`,
		op: "cut",
		startSec,
		endSec,
		reason: "fixture cut",
		confidence: 0.8,
		...extra,
	};
}

const FREE = ["it", "is", "free", "to", "try"];

// ── inverse-remap round-trip (the risky part) ────────────────────────────────

describe("inverseRemapTime round-trip", () => {
	test("hand fixture: retained boundaries map to themselves", () => {
		const removals: RemovalSpan[] = [
			{ startSec: 2, endSec: 5 },
			{ startSec: 7, endSec: 9 },
		];
		// Retained points 0,1 (before), 6 (between), 10 (after). Forward then inverse.
		for (const t of [0, 1, 6, 6.5, 10, 12]) {
			expect(inverseRemapTime(forwardRemapTime(t, removals), removals)).toBeCloseTo(
				t,
				9,
			);
		}
	});

	test("property: inverse(forward(t)) === t for interior retained points", () => {
		// Deterministic LCG so the case set is stable across runs.
		let seed = 0x2f6e2b1;
		const rand = () => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed / 0x7fffffff;
		};
		for (let trial = 0; trial < 400; trial++) {
			// Build N disjoint sorted removals with retained gaps between them.
			const n = 1 + Math.floor(rand() * 5);
			const removals: RemovalSpan[] = [];
			let cursor = rand() * 3;
			for (let i = 0; i < n; i++) {
				cursor += 0.5 + rand() * 4; // retained gap before this removal
				const start = cursor;
				const end = start + 0.3 + rand() * 4; // removal width
				removals.push({ startSec: start, endSec: end });
				cursor = end;
			}
			// Pick retained interior points: before the first, strictly inside each gap
			// (incl. after the last), never on a boundary.
			const points: number[] = [removals[0].startSec * rand()];
			for (let i = 0; i < removals.length; i++) {
				const gapStart = removals[i].endSec;
				const gapEnd =
					i + 1 < removals.length ? removals[i + 1].startSec : gapStart + 5;
				points.push(gapStart + (gapEnd - gapStart) * (0.1 + rand() * 0.8));
			}
			for (const t of points) {
				const back = inverseRemapTime(forwardRemapTime(t, removals), removals);
				expect(back).toBeCloseTo(t, 6);
			}
		}
	});

	test("edge tie-break: a collapse-point start maps after, end maps before", () => {
		const removals: RemovalSpan[] = [{ startSec: 2.4, endSec: 70 }];
		// Compressed 2.4 is both take A's end (orig 2.4) and take B's start (orig 70).
		expect(inverseRemapTime(2.4, removals, "end")).toBeCloseTo(2.4, 9);
		expect(inverseRemapTime(2.4, removals, "start")).toBeCloseTo(70, 9);
	});
});

// ── remap composition (matches delete-then-remap-sequence semantics) ─────────

describe("buildRemappedTranscript", () => {
	test("drops in-removal words and shifts survivors by the cumulative removed duration", () => {
		const words: WordTiming[] = Array.from({ length: 11 }, (_, i) => ({
			text: `w${i}`,
			start: i,
			end: i + 0.4,
		}));
		const removals: RemovalSpan[] = [
			{ startSec: 2, endSec: 5 }, // removes w2,w3,w4 (starts 2,3,4)
			{ startSec: 7, endSec: 9 }, // removes w7,w8
		];
		const { words: rw } = buildRemappedTranscript({ words, segments: [], removals });
		// Survivors w0,w1,w5,w6,w9,w10 shifted by cumulative removed-before.
		expect(rw.map((w) => w.text)).toEqual(["w0", "w1", "w5", "w6", "w9", "w10"]);
		expect(rw.map((w) => Number(w.start.toFixed(6)))).toEqual([0, 1, 2, 3, 4, 5]);
	});

	test("a word straddling a removal END is dropped, never left unshifted (review F2)", () => {
		// Old midpoint membership KEPT a word starting inside a removal whose midpoint
		// sat past its end, while the shift rule never moved it: stale coordinates,
		// inverted order, detector findings inverse-mapped onto the wrong footage.
		const words: WordTiming[] = [
			{ text: "before", start: 7.0, end: 7.4 },
			{ text: "strad", start: 9.9, end: 10.5 }, // starts inside [8,10), mid past end
			{ text: "after", start: 10.6, end: 11.0 },
		];
		const removals: RemovalSpan[] = [{ startSec: 8, endSec: 10 }];
		const { words: rw } = buildRemappedTranscript({ words, segments: [], removals });
		expect(rw.map((w) => w.text)).toEqual(["before", "after"]);
		expect(rw[1].start).toBeCloseTo(8.6, 6);
		for (let i = 1; i < rw.length; i++) {
			expect(rw[i].start).toBeGreaterThan(rw[i - 1].start); // stays monotonic
		}
	});

	test("a word reaching INTO a removal is clamped to the removal start (review F2)", () => {
		const words: WordTiming[] = [{ text: "w", start: 7.5, end: 8.5 }];
		const removals: RemovalSpan[] = [{ startSec: 8, endSec: 10 }];
		const { words: rw } = buildRemappedTranscript({ words, segments: [], removals });
		expect(rw).toHaveLength(1);
		expect(rw[0].start).toBeCloseTo(7.5, 6);
		expect(rw[0].end).toBeCloseTo(8.0, 6); // clamped, no reach into removed footage
	});

	test("a SEGMENT keeps its tail across an interior micro-cut (review X1)", () => {
		// Clamping to the first removal amputated the whole tail: [10,20] with an
		// interior 0.4s filler cut became [10,12], leaving a fake 8s hole the pacing
		// detector then cut as a 'long pause' over real speech. Subtraction shrinks
		// the segment by exactly the removed duration instead.
		const segments = [{ start: 10, end: 20, text: "s1" }];
		const removals: RemovalSpan[] = [{ startSec: 12, endSec: 12.4 }];
		const { segments: rs } = buildRemappedTranscript({ words: [], segments, removals });
		expect(rs).toHaveLength(1);
		expect(rs[0].start).toBeCloseTo(10, 6);
		expect(rs[0].end).toBeCloseTo(19.6, 6); // 20 minus the 0.4s interior cut
	});

	test("a segment spanning MULTIPLE interior cuts subtracts them all", () => {
		const segments = [{ start: 0, end: 10, text: "s" }];
		const removals: RemovalSpan[] = [
			{ startSec: 2, endSec: 2.5 },
			{ startSec: 5, endSec: 6 },
			{ startSec: 9.5, endSec: 12 }, // straddles the end: only [9.5,10) counts
		];
		const { segments: rs } = buildRemappedTranscript({ words: [], segments, removals });
		expect(rs).toHaveLength(1);
		expect(rs[0].end).toBeCloseTo(10 - 0.5 - 1 - 0.5, 6); // 8.0
	});
});

describe("acceptedRemovalSpans", () => {
	test("keeps only default-accepted removals and unions overlaps", () => {
		const spans = acceptedRemovalSpans([
			cut(0, 2),
			cut(1.5, 3), // overlaps the first -> unioned to [0,3]
			cut(10, 11, { defaultAccept: false }), // opt-in -> excluded
			{ ...cut(20, 21), op: "keep" }, // not a removal -> excluded
		]);
		expect(spans).toEqual([
			{ startSec: 0, endSec: 3 },
			// [10,11] excluded (opt-in), keep excluded
		]);
	});
});

// ── the convergence loop ─────────────────────────────────────────────────────

describe("runSecondPass", () => {
	test("two verbatim takes >60s apart: the compression reveals the repeat, emitted in ORIGINAL coords", () => {
		const words = [...take(FREE, 0), ...take(FREE, 70)];
		// Pass 1 cut the whole span between the takes (accepted).
		const mergedOps = [cut(2.4, 70, { reason: "middle removed" })];
		const { extraOps } = runSecondPass({
			ops: mergedOps,
			words,
			segments: [],
			redundancyRan: false,
		});
		const repeat = extraOps.find((op) => op.category === "repeat");
		expect(repeat).toBeDefined();
		// Earlier occurrence (take A) is cut, in ORIGINAL coordinates.
		expect(repeat!.startSec).toBeCloseTo(0, 6);
		expect(repeat!.endSec).toBeCloseTo(2.4, 6);
	});

	test("a keeper span covering the revealed take survives all passes uncut", () => {
		const words = [...take(FREE, 0), ...take(FREE, 70)];
		const mergedOps = [cut(2.4, 70)];
		const { extraOps } = runSecondPass({
			ops: mergedOps,
			words,
			segments: [],
			keepers: [{ startSec: 0, endSec: 2.4 }], // protects take A
			redundancyRan: false,
		});
		const hitsKeeper = extraOps.some((op) => op.startSec < 2.4 && 0 < op.endSec);
		expect(hitsKeeper).toBe(false);
	});

	test("a pass-2 cut overlapping a pass-1 op is deduped (no double)", () => {
		const words = [...take(FREE, 0), ...take(FREE, 70)];
		// Take A already carries an opt-in pass-1 cut: it is NOT applied to the
		// transcript (so the repeat still surfaces), but it IS a surviving removal, so
		// the pass-2 repeat over the same span dedups away.
		const mergedOps = [
			cut(0, 2.4, { defaultAccept: false, id: "optin-a" }),
			cut(2.4, 70, { id: "middle" }),
		];
		const { extraOps } = runSecondPass({
			ops: mergedOps,
			words,
			segments: [],
			redundancyRan: false,
		});
		expect(extraOps).toHaveLength(0);
	});

	test("a revealed repeat CONTAINING an interior pass-1 cut is not deduped away (review F3)", () => {
		// Both takes carry an "um" that pass 1 cut (auto-accepted fillers), so the
		// compressed takes read verbatim-identical and phrase-repeat matches. The
		// repeat cut of take A inverse-maps to a span CONTAINING A's interior um cut;
		// the old any-overlap dedup dropped it for that overlap and the verbatim
		// repeat shipped. Now it survives: it adds ~2.5s of new coverage.
		const UM_FREE = ["it", "is", "um", "free", "to", "try"];
		const words = [...take(UM_FREE, 120), ...take(UM_FREE, 240)];
		const mergedOps = [
			cut(121.0, 121.4, { id: "um-a", category: "filler" }), // A's um (accepted)
			cut(241.0, 241.4, { id: "um-b", category: "filler" }), // B's um (accepted)
			cut(122.9, 240, { id: "middle" }), // everything between the takes
		];
		const { extraOps } = runSecondPass({
			ops: mergedOps,
			words,
			segments: [],
			redundancyRan: false,
		});
		const repeat = extraOps.find((op) => op.category === "repeat");
		expect(repeat).toBeDefined();
		// Take A's span in ORIGINAL coordinates, re-expanded across the interior cut.
		expect(repeat!.startSec).toBeCloseTo(120, 6);
		expect(repeat!.endSec).toBeCloseTo(122.9, 6);
	});

	test("a pass-2 op adding only sliver coverage over an existing cut still dedups", () => {
		// The coverage rule must not let edge jitter re-add an existing removal.
		const words = [...take(FREE, 0), ...take(FREE, 70)];
		const mergedOps = [
			// Pass-1 opt-in cut nearly covering take A: an sp- repeat over [0,2.4]
			// would add only ~0.1s of new footage, below the 0.5s floor.
			cut(0.1, 2.4, { defaultAccept: false, id: "optin-a" }),
			cut(2.4, 70, { id: "middle" }),
		];
		const { extraOps } = runSecondPass({
			ops: mergedOps,
			words,
			segments: [],
			redundancyRan: false,
		});
		expect(extraOps).toHaveLength(0);
	});

	test("an interior micro-cut never manufactures a fake pacing gap (review X1 regression)", () => {
		// End-to-end: segments with an accepted filler cut INSIDE the first one. The
		// truncation bug compressed seg1 to [10,12], showed pacing an 8s fake pause,
		// and shipped a pre-checked sp- pacing cut over 7.6s of real speech.
		const tokens = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];
		const words: WordTiming[] = [
			...tokens.map((text, i) => ({ text, start: 10 + i * 1.6, end: 10 + i * 1.6 + 1.2 })),
			...["golf", "hotel", "india"].map((text, i) => ({
				text,
				start: 23 + i * 2,
				end: 23 + i * 2 + 1.2,
			})),
		];
		const segments = [
			{ start: 10, end: 20, text: "first sentence" },
			{ start: 23, end: 30, text: "second sentence" },
		];
		const mergedOps = [
			cut(12.0, 12.4, { id: "filler-inside", category: "filler" }), // interior micro-cut
			cut(20.4, 23, { id: "pause-tighten", category: "pacing" }), // real inter-take pause
		];
		const { extraOps } = runSecondPass({
			ops: mergedOps,
			words,
			segments,
			redundancyRan: false,
		});
		const fakePacing = extraOps.filter((op) => op.category === "pacing");
		expect(fakePacing).toEqual([]); // no manufactured pause over real speech
	});

	test("no new findings: the loop runs one extra pass and exits with zero ops", () => {
		const words: WordTiming[] = [
			...["alpha", "beta", "gamma", "delta"].map((text, i) => ({
				text,
				start: i,
				end: i + 0.4,
			})),
			{ text: "um", start: 4, end: 4.4 },
		];
		const mergedOps = [cut(4, 4.4, { reason: "filler um" })]; // removes the only filler
		const { extraOps, passesRun } = runSecondPass({
			ops: mergedOps,
			words,
			segments: [],
			redundancyRan: false,
		});
		expect(extraOps).toHaveLength(0);
		expect(passesRun).toBe(2); // pass 1 (caller) + one dry extra pass
	});

	test("adversarial cascade: each pass reveals one repeat; loop caps at 3, pass-4 repeat is NOT cut", () => {
		// A(alpha..) is matchable at pass 2. Removing A1 nudges B(echo..) across the
		// 60s window at pass 3. Removing B1 would nudge C(india..) across at pass 4 -
		// but the cap stops the loop at pass 3, so C is never cut. Distances are tuned
		// to the phrase-repeat window (later.firstStart - earlier.firstEnd <= 60).
		const A = ["alpha", "bravo", "charlie", "delta"];
		const B = ["echo", "foxtrot", "golf", "hotel"];
		const C = ["india", "juliet", "kilo", "lima"];
		const words = [
			...take(C, 90), // C1
			...take(B, 95), // B1
			...take(A, 100), // A1 (cut pass 2)
			...take(A, 104), // A2 (kept)
			...take(C, 153), // C2  (C dist 63: crosses only at pass 4)
			...take(B, 156.5), // B2 (B dist 61.5: crosses at pass 3, after A1 gone)
		];
		// A pass-1 accepted removal far past the takes: its span is irrelevant, it only
		// kicks off the loop (a real run always has accepted cuts).
		const mergedOps = [cut(200, 201, { reason: "pass-1 trigger" })];
		const { extraOps, passesRun } = runSecondPass({
			ops: mergedOps,
			words,
			segments: [],
			redundancyRan: false,
		});
		expect(passesRun).toBe(3); // capped: pass 2 + pass 3, pass 4 never runs
		// A1 (pass 2) and B1 (pass 3) cut, in ORIGINAL coordinates.
		const starts = extraOps.map((op) => Number(op.startSec.toFixed(3))).sort((a, b) => a - b);
		expect(starts).toEqual([95, 100]); // B1 firstStart 95, A1 firstStart 100
		// C (would be revealed only at pass 4) is untouched.
		const hitsC = extraOps.some((op) => op.startSec < 91.9 && 90 < op.endSec);
		expect(hitsC).toBe(false);
	});

	test("respects a custom pass cap", () => {
		const words = [...take(FREE, 0), ...take(FREE, 70)];
		const mergedOps = [cut(2.4, 70)];
		const { passesRun } = runSecondPass({
			ops: mergedOps,
			words,
			segments: [],
			redundancyRan: false,
			maxPasses: 2,
		});
		expect(passesRun).toBe(2); // only pass 2 runs
	});

	test("produces ops only: inputs are never mutated (pure)", () => {
		const words = Object.freeze([...take(FREE, 0), ...take(FREE, 70)]) as WordTiming[];
		const segments = Object.freeze([]) as SecondPassSegment[];
		const ops = Object.freeze([cut(2.4, 70)]) as DirectorOp[];
		const before = JSON.stringify({ words, ops });
		expect(() =>
			runSecondPass({ ops, words, segments, redundancyRan: false }),
		).not.toThrow();
		expect(JSON.stringify({ words, ops })).toBe(before);
	});
});
