/**
 * U2 integration: the emphasis-pause classifier feeds keepers into
 * mergeDetectedCuts exactly as run-director wires them, so a protected in-dialog
 * pause survives the multi-source merge while dead air and repeat-adjacent gaps
 * are still cut. Composes the two pure helpers (wasm-free) rather than spinning up
 * the full Director.
 */
import { describe, expect, test } from "bun:test";
import { mergeDetectedCuts } from "../cut-utils";
import { computeEmphasisPauseKeepers } from "../emphasis-pause";
import type { DirectorOp } from "@framecut/hf-bridge";
import type { TranscriptWordLite } from "@/features/transcription/transcript-cache";

const cut = (
	over: Partial<DirectorOp> & { startSec: number; endSec: number },
): DirectorOp => ({
	id: `id-${over.startSec}-${over.endSec}`,
	op: "cut",
	reason: "r",
	confidence: 0.5,
	...over,
});

// Two segments [3,5] and [6.5,8] leave a 1.5s inter-segment gap [5, 6.5].
const words: TranscriptWordLite[] = [
	{ start: 4.5, end: 5, text: "before" },
	{ start: 6.5, end: 7, text: "after" },
];
const gap = { start: 5, end: 6.5 };

// What run-director targets at that gap: pacing tightens [5.4, 6.5]; vad-dead-air
// would remove the whole gap [5, 6.5].
const pacingCut = cut({ startSec: 5.4, endSec: 6.5, category: "pacing" });
const deadAirCut = cut({ startSec: 5, endSec: 6.5, category: "deadair", id: "dead" });

describe("emphasis-pause protection through the merge (U2)", () => {
	test("a 1.5s speech-bounded gap with no repeat nearby survives — both cuts dropped", () => {
		const keepers = computeEmphasisPauseKeepers({
			gaps: [gap],
			words,
			repeatSpans: [],
		});
		expect(keepers).toHaveLength(1);
		const merged = mergeDetectedCuts({
			planOps: [],
			extraOps: [pacingCut, deadAirCut],
			keepers,
		});
		expect(merged).toHaveLength(0); // the pause is kept
	});

	test("coupled: a redundancy cut adjacent to the gap removes protection — the gap IS cut", () => {
		const repeatSpan = { startSec: 6.7, endSec: 7.5 }; // within proximity of gap end
		const keepers = computeEmphasisPauseKeepers({
			gaps: [gap],
			words,
			repeatSpans: [repeatSpan],
		});
		expect(keepers).toHaveLength(0);
		const merged = mergeDetectedCuts({
			planOps: [],
			extraOps: [pacingCut, deadAirCut],
			keepers,
		});
		// No keeper → the pause-removing cuts survive (deduped against each other).
		expect(merged.length).toBeGreaterThan(0);
	});

	test("regression: a 3s LEADING dead-air gap (speech only after) is still removed", () => {
		const leadGap = { start: 0, end: 3 };
		const leadingWords: TranscriptWordLite[] = [{ start: 3, end: 3.5, text: "hi" }];
		const keepers = computeEmphasisPauseKeepers({
			gaps: [leadGap],
			words: leadingWords,
			repeatSpans: [],
		});
		expect(keepers).toHaveLength(0);
		const leadCut = cut({ startSec: 0, endSec: 3, category: "deadair", id: "lead" });
		const merged = mergeDetectedCuts({ planOps: [], extraOps: [leadCut], keepers });
		expect(merged).toHaveLength(1);
	});

	test("without word timings no gap is protected (degrades to prior behavior)", () => {
		const keepers = computeEmphasisPauseKeepers({ gaps: [gap], words: [], repeatSpans: [] });
		expect(keepers).toHaveLength(0);
		const merged = mergeDetectedCuts({ planOps: [], extraOps: [pacingCut, deadAirCut], keepers });
		expect(merged.length).toBeGreaterThan(0);
	});
});
