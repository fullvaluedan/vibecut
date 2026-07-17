# Live-test issues (ongoing list — do not lose)

Started 2026-07-17 from Dan's first real AI CUT / Director run on
`C:\Users\danom\Videos\0714 Building an app for app testers\2026-07-14 13-46-45_join the group.mp4`
(dev server, both recall toggles on, claude-code auth, Groq cloud transcription).
Dan's directive: keep the list current, fix nothing until he says so.
**Priority per Dan: lock in on the cuts first (items 1-4). Timeline/UX items follow.**

## Cut quality (the priority)

> ROUND 6 STATUS (2026-07-17): items 1-4 FIXED by plan 2026-07-17-001 (commits on
> feat/director-eval; measured verdict in findings doc ADDENDUM 6). The diag replay
> assertion harness passes; the four-fixture eval shows no match regression and
> essential-words-lost down 52-107 on three fixtures. Remaining: Dan's hands-on
> smoke pass (gate e). Item details kept below for the record.

1. **Over-cutting clean footage.** The join-the-group clip needs only a head trim; the
   dialog is smooth for 45s — no mistakes, no repeats. The Director still produced many
   cuts. ROOT-CAUSED 2026-07-17 by replaying the pipeline on the exact live-run transcript
   (`apps/web/scripts/diag-join-the-group.ts`, op dump in scratchpad `diag-join-ops.json`):
   1a. Phrase-repeat detector auto-cuts on short n-grams shared by DIFFERENT sentences
       ("We are going to", "You do not have to"): amputated one sentence tail and one
       sentence head, mid-speech, no silence at either boundary. 2 of 6 AUTO cuts.
   1b. A second-pass "pacing tighten" (sp- op, AUTO) spanned 3.75s INCLUDING an entire
       spoken sentence ("I don't think you even have to link to your Google accounts").
       Pacing ops must never contain words.
   1c. Whisper hallucination over the 24s dead-air tail ("Thank you." segments 30s long,
       single words 9-21s long) made silence look like speech to every word-based pass.
   1d. THE INVERSION: the one correct big cut (LLM plan's "dead outro, 24s, pure dead
       weight") was clamp-DEMOTED to an unchecked review row (no evidence coverage since
       VAD was off), while the n-gram false positives auto-applied. Precision layer and
       recall layer are calibrated backwards on this footage.
   1e. Pacing tightens leave 0.5-0.7s residual silence on each side of the join (they
       relocate boundaries; nothing swallows the pause), producing the head/tail silences.
       The 24s block itself survived because dead-air is VAD-gated (default off) and the
       hallucinated words blocked the pause math.
2. **Hard cuts.** Cut boundaries land on word edges (no handles, no room tone, no fades),
   not in the middle of silence gaps. Sounds like splice errors.
3. **Silences at clip heads/tails.** Retained silence inside kept clips; nothing in the
   default pipeline trims dead air (VAD dead-air pass is opt-in, default off).
4. **Fragmentation ("confetti").** Many small cuts shred the timeline into short,
   unhelpful segments; no minimum-keep-length or merge pass at apply time.

## Editor / timeline (blocks hand-fixing the cuts)

5. **Linked clip extend broken.** Cannot extend/trim video and its audio together.
6. **Clip movement broken.** Cannot move a clip away from the head of the timeline —
   it snaps back. General movement jank. (Editor-core / upstream behavior.)

## Product / flow

7. **Director cut menu not persistent.** Should always be available; when AI CUT has not
   run yet it should show AI CUT as the action; after a run it should show the review state.
8. **OFFERED-row discoverability.** The review rows (where the measured value lives) are
   easy to never see; the timeline shows the AUTO floor most prominently. Ties into item 7.

## Process failures (why these shipped)

- Five rounds gated on test suites + offline eval; zero rounds gated on hands-on product
  use. Basic drag/trim/extend was broken the whole time.
- The eval metric is transcript-word-only: structurally blind to silence, cut-point
  acoustics, and timeline topology (items 2-4 cost zero on the scorecard).
- Definition of done now includes a hands-on smoke pass: import, drag, trim, extend
  linked clip, run AI CUT, open review.
