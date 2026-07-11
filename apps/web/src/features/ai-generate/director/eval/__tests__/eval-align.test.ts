import { describe, expect, test } from "bun:test";
import { alignTranscripts } from "../align";
import type { TranscriptionWord } from "@/transcription/types";

/** Build timed words from a sentence: 0.3s per word, back to back. */
function words(text: string, startAt = 0): TranscriptionWord[] {
	return text
		.split(/\s+/)
		.filter(Boolean)
		.map((w, i) => ({
			text: w,
			start: startAt + i * 0.3,
			end: startAt + i * 0.3 + 0.28,
		}));
}

describe("alignTranscripts (ground truth from raw vs final)", () => {
	test("identical transcripts produce zero cut spans", () => {
		const raw = words("welcome back today we are building a website from scratch");
		const result = alignTranscripts({ rawWords: raw, finalWords: words("welcome back today we are building a website from scratch") });
		expect(result.truthCutSpans).toEqual([]);
		expect(result.rawKept.every(Boolean)).toBe(true);
	});

	test("a deleted retake labels exactly one copy as cut", () => {
		// Dan flubbed the line and re-took it; the final keeps ONE copy.
		const raw = words(
			"so the first step is to open the terminal " +
				"so the first step is to open the editor and create a file",
		);
		const final = words("so the first step is to open the editor and create a file");
		const result = alignTranscripts({ rawWords: raw, finalWords: final });
		const cutWords = result.rawKept.filter((k) => !k).length;
		expect(cutWords).toBe(9); // one copy's worth
		expect(result.truthCutSpans).toHaveLength(1);
		expect(result.truthCutSpans[0].text).toContain("terminal");
	});

	test("a single deleted filler word IS a cut (deletion, not noise)", () => {
		const raw = words("and then um you click the deploy button");
		const final = words("and then you click the deploy button");
		const result = alignTranscripts({ rawWords: raw, finalWords: final });
		expect(result.truthCutSpans).toHaveLength(1);
		expect(result.truthCutSpans[0].text).toBe("um");
		// Times come from the raw word's own stamps.
		expect(result.truthCutSpans[0].startSec).toBeCloseTo(0.6, 5);
	});

	test("transcriber mishearing is a substitution, NOT a cut", () => {
		// Same audio survived; the two transcription runs disagree on words.
		const raw = words("we are gonna configure the server");
		const final = words("we are going to configure the server");
		const result = alignTranscripts({ rawWords: raw, finalWords: final });
		expect(result.truthCutSpans).toEqual([]);
		expect(result.substitutionWords).toBeGreaterThan(0);
	});

	test("final-only insertions (added VO) are ignored, not labeled", () => {
		const raw = words("here is the dashboard we built");
		const final = words("quick note before we start here is the dashboard we built");
		const result = alignTranscripts({ rawWords: raw, finalWords: final });
		expect(result.truthCutSpans).toEqual([]);
		expect(result.finalOnlyWords).toBe(5);
	});

	test("mixed edit: filler cut + retake cut + noise, all classified", () => {
		const raw = words(
			"okay um lets deploy this to production " +
				"wait that broke lets deploy this to production properly " +
				"and now we are gonna verify the logs",
		);
		const final = words(
			"okay lets deploy this to production properly " +
				"and now we are going to verify the logs",
		);
		const result = alignTranscripts({ rawWords: raw, finalWords: final });
		const cutText = result.truthCutSpans.map((s) => s.text).join(" | ");
		expect(cutText).toContain("um");
		expect(cutText).toContain("wait that broke");
		// "gonna" vs "going to" must NOT appear as a cut.
		expect(cutText).not.toContain("gonna");
		expect(result.substitutionWords).toBeGreaterThan(0);
	});

	test("a reordered block is labeled moved, not cut (R3)", () => {
		// A distinctive 8-word block appears EARLY in raw and LATE in final —
		// Dan relocated it, he didn't cut it.
		const block = "remember to back up your project before you deploy";
		const raw = words(
			`${block} welcome back today we are building a website from scratch`,
		);
		const final = words(
			`welcome back today we are building a website from scratch ${block}`,
		);
		const result = alignTranscripts({ rawWords: raw, finalWords: final });
		expect(result.movedWords).toBe(9); // the block's word count
		expect(result.truthCutSpans).toEqual([]); // moved, so no cut label
		// The block's words are relabeled kept.
		expect(result.rawKept.every(Boolean)).toBe(true);
		// The relocated final copy stops counting as a final-only insertion.
		expect(result.finalOnlyWords).toBe(0);
		expect(result.movedSpans).toHaveLength(1);
		expect(result.movedSpans[0].text).toContain("back up your project");
	});

	test("a retake with a moved survivor keeps exactly one copy cut (R3)", () => {
		// Two identical copies of a distinctive line in raw, each separated by
		// distinctive KEPT context that anchors in order. Both line copies fall
		// out of the diff (they can't align in order with the single relocated
		// final copy), so BOTH land as raw cuts and the final copy is the lone
		// twin. Greedy pairing consumes that twin ONCE: one copy is relabeled
		// moved, the other STAYS a cut — a move must never double-count a retake.
		const line = "open the settings panel and switch the theme to dark mode";
		const kept1 = "meanwhile the camera pans across the studio floor now";
		const kept2 = "afterwards we review the color grading in fine detail";
		const raw = words(`${line} ${kept1} ${line} ${kept2}`);
		const final = words(`${kept1} ${kept2} ${line}`);
		const result = alignTranscripts({ rawWords: raw, finalWords: final });
		// Exactly ONE copy moved (the twin is consumed once) and ONE copy stays
		// cut — a move must never double-count a retake into two moves.
		expect(result.movedSpans).toHaveLength(1);
		expect(result.movedWords).toBeGreaterThanOrEqual(5); // MIN_MOVE_RUN_WORDS
		const cutWords = result.rawKept.filter((k) => !k).length;
		expect(cutWords).toBeGreaterThanOrEqual(5); // the un-paired retake copy stays cut
		const cutText = result.truthCutSpans.map((s) => s.text).join(" | ");
		expect(cutText).toContain("settings panel");
	});

	test("a moved block shorter than the minimum stays a cut (R3)", () => {
		// A 3-word reappearance is below MIN_MOVE_RUN_WORDS — too generic to trust
		// as a move, so it keeps the old deletion semantics.
		const raw = words("save the file welcome back today we build a website");
		const final = words("welcome back today we build a website save the file");
		const result = alignTranscripts({ rawWords: raw, finalWords: final });
		expect(result.movedWords).toBe(0);
		// "save the file" is cut from the front and appears final-only at the end.
		expect(result.truthCutSpans.length).toBeGreaterThan(0);
	});

	test("punctuation-only tokens never form cuts", () => {
		const raw: TranscriptionWord[] = [
			...words("this works"),
			{ text: "...", start: 0.6, end: 0.7 },
			...words("fine", 0.9),
		];
		const final = words("this works fine");
		const result = alignTranscripts({ rawWords: raw, finalWords: final });
		expect(result.truthCutSpans).toEqual([]);
	});

	test("scales to long transcripts via patience anchors", () => {
		// ~6k words with a cut in the middle: too big for one LCS window, so
		// the anchor recursion must carry it.
		const base: string[] = [];
		for (let i = 0; i < 2000; i++) base.push(`word${i} the and`);
		const rawText =
			base.slice(0, 1000).join(" ") +
			" this whole take was bad and repeated " +
			base.slice(1000).join(" ");
		const finalText = base.join(" ");
		const raw = words(rawText);
		const result = alignTranscripts({
			rawWords: raw,
			finalWords: words(finalText),
		});
		// Repeated function words ("and") make span SHAPE ambiguous under any
		// diff; what matters for scoring is word-level: exactly one take's
		// worth of words cut, all inside the inserted region.
		const cutWords = result.rawKept.filter((k) => !k).length;
		expect(cutWords).toBe(7);
		// +-1 token: a duplicate word at a cut boundary ("and" here) can have
		// its attribution swapped with the identical neighbor by any diff.
		const insertStart = 1000 * 3; // 1000 base items x 3 words each
		for (const span of result.truthCutSpans) {
			expect(span.startIndex).toBeGreaterThanOrEqual(insertStart - 1);
			expect(span.endIndex).toBeLessThan(insertStart + 8);
		}
	});
});
