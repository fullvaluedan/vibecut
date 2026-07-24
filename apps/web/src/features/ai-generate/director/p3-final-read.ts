/**
 * P3 final-read wiring (round 14 U2, revert-harmful + texture). The verify pass
 * grew a THIRD duty in v7: read the DEFAULT-ACCEPTED cuts the pipeline is about to
 * ship and pull back any that damage the read. This module is the pure bridge
 * between the op list the pipeline holds and the id-keyed harm verdicts the
 * hf-bridge `planVerify` returns, with no I/O or store coupling (the join wiring in
 * `verify-apply.ts` is the precedent):
 *
 *  - `collectHarmCandidates` builds the `VerifyHarmCandidate` list the final read
 *    judges. Two sources feed it: SUBSTANTIAL default-accepted cuts (long enough to
 *    gut a point if they land wrong) and the deterministic fragmentation guard's
 *    BORDERLINE micro-cuts (a texture question). Each candidate carries the removed
 *    text plus the KEPT words on each side, so the model reads the exact assembled
 *    seam the cut leaves - not the cut in isolation.
 *  - `applyHarmVerdicts` maps the verdicts back: a confident "revert" DEMOTES the
 *    cut to offered-off (`defaultAccept: false`) with an annotated reason, so a
 *    select-all no longer auto-applies it. It NEVER deletes the row - the
 *    ADDENDUM-12 mandate is that a destroyed kept line costs far more than an extra
 *    review row, so the harm net only ever adds review rows, never removes footage.
 *
 * Dan applies everything (Applied 208 of 208), so this is his real safety net: the
 * cut that would break a sentence is the one thing the whole multi-pass exists to
 * catch. Pure + wasm-free -> unit-tested.
 */

import type { DirectorOp, VerifyHarmCandidate, VerifyHarmVerdict } from "@framecut/hf-bridge";
import { isMidpointContained, mergeAcceptedRemovalSpans, type WordTiming } from "./cut-utils";

/**
 * A default-accepted cut at least this long is a SUBSTANTIAL removal the harm
 * review always looks at - long enough to carry a whole clause or point, so a
 * wrong one can gut the read. Shorter cuts reach the review only when the
 * fragmentation guard flags them borderline (a texture question, not a harm one).
 */
export const HARM_REVIEW_MIN_SEC = 1.5;

/**
 * Cap on how many cuts the harm review sends in one call. A long run can hold
 * hundreds of substantial cuts; sending them all would bloat the prompt and blur
 * the model's attention. Borderline micro-cuts are always kept (they are few and
 * were flagged for a reason); the substantial cuts fill the remaining budget
 * LARGEST-FIRST, since the longer a removal the more read it can destroy. The cap
 * is a bounded-cost tradeoff, honestly: a harmful cut below the cut line ships, but
 * the join-fragment and recall duties already cover the small-seam cases, and the
 * biggest removals are where an un-reviewed harm is most expensive.
 */
export const HARM_REVIEW_MAX_CANDIDATES = 24;

/** Kept words of context rendered on each side of a harm candidate's seam. */
export const HARM_CONTEXT_WORDS = 12;

/**
 * Categories a SUBSTANTIAL cut is never harm-reviewed under: the deterministic
 * removals of non-speech (dead air, splice noise, pacing silence) and of discrete
 * disfluencies (a doubled word, an "um"). None of these can sever a sentence or
 * orphan a referent - they remove ground-truth dead weight - so sending them to the
 * harm review only bloats the prompt and risks a wrong revert of a correct cut (the
 * 24s dead-air tail is exactly the kind of long, correct removal to keep out).
 * "join" is the join layer's own concern. A cut the FRAGMENTATION GUARD flagged
 * borderline is a texture question and is reviewed regardless of category (the guard
 * already exempts these same categories, so a borderline row is never one of them).
 */
export const HARM_EXEMPT_CATEGORIES: ReadonlySet<string> = new Set([
	"deadair",
	"noise",
	"pacing",
	"filler",
	"duplicate",
	"join",
]);

/**
 * A "revert" verdict below this confidence leaves the cut default-accepted: the
 * final read must be SURE before it demotes a cut Dan wanted gone (a demote he
 * would have to notice and re-check). Mirrors the join-swallow gate's discipline
 * from the other direction - there a low-confidence swallow stays offered, here a
 * low-confidence revert stays accepted.
 */
export const HARM_REVERT_MIN_CONFIDENCE = 0.8;

/** A kept word: midpoint NOT inside any merged default-accepted removal. */
function collectKeptWords(
	ops: readonly DirectorOp[],
	words: readonly WordTiming[],
): WordTiming[] {
	const removed = mergeAcceptedRemovalSpans(ops);
	return words.filter(
		(w) =>
			!removed.some((r) =>
				isMidpointContained({
					spanStart: w.start,
					spanEnd: w.end,
					containerStart: r.startSec,
					containerEnd: r.endSec,
				}),
			),
	);
}

/**
 * Build the harm/texture candidate list from the FINAL op list (round 14 U2).
 * Sources: every default-accepted `cut`/`take_select` at least `minSec` long
 * (substantial), plus every op whose id is in `borderlineIds` (the fragmentation
 * guard's texture flags). The "join" category is excluded - join fragments have
 * their own verdict path. Each candidate carries the removed words and up to
 * `contextWords` KEPT words each side (the assembled seam). The list is capped at
 * `maxCandidates`: borderline rows first, then substantial cuts LARGEST-FIRST, so
 * the review always spends its budget where an un-caught harm is costliest. The
 * output is sorted back into timeline order. Pure.
 */
export function collectHarmCandidates({
	ops,
	words,
	borderlineIds = [],
	minSec = HARM_REVIEW_MIN_SEC,
	maxCandidates = HARM_REVIEW_MAX_CANDIDATES,
	contextWords = HARM_CONTEXT_WORDS,
}: {
	ops: readonly DirectorOp[];
	words: readonly WordTiming[];
	borderlineIds?: readonly string[];
	minSec?: number;
	maxCandidates?: number;
	contextWords?: number;
}): VerifyHarmCandidate[] {
	const borderline = new Set(borderlineIds);
	const kept = collectKeptWords(ops, words);

	// One pass to select which ops the review judges, tagging each as a texture
	// (borderline micro-cut) or a harm (substantial cut) question.
	interface Selected {
		op: DirectorOp;
		texture: boolean;
	}
	const selected: Selected[] = [];
	for (const op of ops) {
		if (op.op !== "cut" && op.op !== "take_select") continue;
		if (op.defaultAccept === false) continue;
		const isBorderline = borderline.has(op.id);
		if (isBorderline) {
			selected.push({ op, texture: true });
			continue;
		}
		// Substantial harm review: content-bearing categories only, at least minSec.
		if (HARM_EXEMPT_CATEGORIES.has(op.category ?? "")) continue;
		if (op.endSec - op.startSec < minSec) continue;
		selected.push({ op, texture: false });
	}

	// Budget: borderline (texture) rows always survive; substantial rows fill the
	// rest largest-first. Enforced by a stable sort key, then a slice.
	selected.sort((a, b) => {
		if (a.texture !== b.texture) return a.texture ? -1 : 1; // texture first
		return b.op.endSec - b.op.startSec - (a.op.endSec - a.op.startSec); // longest first
	});
	const budgeted = selected.slice(0, Math.max(0, maxCandidates));

	const out: VerifyHarmCandidate[] = budgeted
		.map(({ op, texture }) => {
			const removedText = words
				.filter((w) =>
					isMidpointContained({
						spanStart: w.start,
						spanEnd: w.end,
						containerStart: op.startSec,
						containerEnd: op.endSec,
					}),
				)
				.map((w) => w.text.trim())
				.join(" ");
			const before = kept.filter((w) => w.end <= op.startSec + 1e-9);
			const after = kept.filter((w) => w.start >= op.endSec - 1e-9);
			const contextBefore = before
				.slice(Math.max(0, before.length - contextWords))
				.map((w) => w.text.trim())
				.join(" ");
			const contextAfter = after
				.slice(0, contextWords)
				.map((w) => w.text.trim())
				.join(" ");
			return {
				id: op.id,
				startSec: op.startSec,
				endSec: op.endSec,
				removedText,
				contextBefore,
				contextAfter,
				texture,
			};
		})
		.sort((a, b) => a.startSec - b.startSec); // back to timeline order for the prompt
	return out;
}

/** Trim a reason to the DirectorOp 240-char budget the pipeline uses everywhere. */
function cap(reason: string): string {
	return reason.slice(0, 240);
}

/**
 * Apply the final read's id-keyed harm verdicts (round 14 U2). A "revert" at or
 * above `HARM_REVERT_MIN_CONFIDENCE` DEMOTES its cut to offered-off
 * (`defaultAccept: false`) and annotates the reason; a "keep", a low-confidence
 * revert, an unknown id, or a non-removal op leaves the row exactly as it was.
 * NEVER deletes a row (the harm net only demotes). Malformed verdicts demote
 * nothing - the sanitizer upstream drops them and these guards are belt-and-braces,
 * so a degraded response can only ever fail toward keeping the cut. Pure.
 */
export function applyHarmVerdicts({
	ops,
	verdicts,
}: {
	ops: readonly DirectorOp[];
	verdicts: readonly VerifyHarmVerdict[];
}): DirectorOp[] {
	const revert = new Set<string>();
	for (const v of verdicts) {
		if (typeof v !== "object" || v === null) continue;
		if (typeof v.id !== "string") continue;
		if (v.verdict !== "revert") continue;
		if (
			typeof v.confidence !== "number" ||
			!Number.isFinite(v.confidence) ||
			v.confidence < HARM_REVERT_MIN_CONFIDENCE
		)
			continue;
		revert.add(v.id);
	}
	if (revert.size === 0) return [...ops];
	return ops.map((op) => {
		if (!revert.has(op.id)) return op;
		if (op.op !== "cut" && op.op !== "take_select") return op;
		if (op.defaultAccept === false) return op; // already offered
		const base = op.reason ?? "";
		return {
			...op,
			defaultAccept: false,
			reason: cap(
				`${base} (final read: this cut damages the read, offered for review rather than auto-applied)`,
			),
		};
	});
}
