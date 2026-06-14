# VibeCut — Quality & Hardening Playbook

> A reflective analysis of how VibeCut was built across 24 rounds (June 11–14, 2026)
> and the practices that made it hold up. Read this alongside `HANDOFF.md` (state),
> `BRIEF.md` (rules), and `PATCHES.md` (upstream ledger). The other three say *what*
> and *how*; this one says *why the work was good and how to keep it that way*.
>
> Written 2026-06-14 as a catch-up + analysis at Dan's request, after the build was
> singled out for "exceptional logic and ability to harden the system."

---

## 0. Scope and honest attribution

The body of work under review: **VibeCut**, a from-a-fork AI-native video editor
(OpenCut Classic + HyperFrames generation), built in the open on `main` at
`fullvaluedan/vibecut`. **24 numbered rounds, 46 merged PRs, June 11→13**, plus
in-progress work on June 14.

The recent work spans two models, and it's worth being precise because the praise
was aimed at "Fable":

| Span | Model (commit co-author) | What shipped |
|---|---|---|
| **Rounds 1–18, PRs #1–#37** + first handoff | **Claude Fable 5** | The whole foundation — see §1 |
| **Rounds 19–24, PRs #39–#46** + R20/R21 handoffs | **Claude Opus 4.8 (1M)** | Bake library, fontSize root-cause, Swiss-grid rebuild, honest panel, style-as-look, overlay-rect |
| **June 14 (uncommitted)** | in progress | Ripple track-scoping fix, 26-agent editor audit, prompt compiler, placement core |

**The most important finding of this whole analysis:** the quality did **not** drop
across the model handoff at Round 19. It didn't, because the quality was never living
only in the model — it was **codified in artifacts and a ritual** that the next model
read at session start and continued. That portability *is* the achievement. If you
want to keep the level alive, protect the operating system in §3, not any one model.

---

## 1. What got built (the outcome)

So the surface area is clear. Compressed; full per-round detail is in `HANDOFF.md §3`
and the project memory file.

- **Core AI loop (R1–3):** transcript → Claude planner → HyperFrames render → place on
  the timeline; AI Cut (silence removal by RMS, repeat/cleanup/YouTube cuts via Claude);
  the VP9-alpha overlay pipeline (DOM preview layer + ffmpeg burn-in on export).
- **Premiere parity (R4–12):** Effect Controls panel with a full keyframe model,
  drag-on-number scrubbing, pen→freeform masks, markers, a complete hotkey set
  (ripple trims, ripple delete, edit-point nav, link/unlink A/V), gap select + ripple,
  persistent tracks, panel maximize, tool rail.
- **AI & UX (R13–15):** hotkey remapping UI + Help, YouTube-edit AI Cut, export-diff
  self-learning, HeyGen audio search, the rails-constrained AI prompt box, background
  transcript caching, playback-speed engine.
- **Native motion templates (R16–18, R20–21):** 14 templates built as real text
  elements with pre-baked keyframes, the Template Controls editor, MOGRT-style linked
  grouping, the fontSize-unit root-cause fix, the rebuilt non-destructive Swiss grid.
- **Bake library + honest panel (R19, R22–24):** registry blocks rendered once and
  cached as droppable transparent WebMs; a type-aware panel that only offers "Add" on
  assets that actually work; style-as-a-look; preview==export overlay geometry.

It is, end to end, a credible "simplified Premiere with an AI cut + motion-graphics
engine." The point of this document is not the feature list — it's *how* it stayed
correct while moving that fast.

---

## 2. The hardening patterns

This is the heart of it. Each pattern is named, stated as a principle, grounded in a
real instance from the build, and paired with the rule that keeps it alive. These are
the behaviors that earned the "exceptional logic / hardening" description.

### 2.1 Root cause over symptom — and prove the cause mechanically

The single most repeated win. The good fixes did not patch the surface; they found the
**one wrong assumption** and corrected it at the source, after which a class of bugs
disappeared structurally.

- **The fontSize unit bug (R21).** Templates rendered ~5× too large, quadratically
  worse on bigger canvases. It had been patched *three times* (R18 proportional sizing,
  R20 scale control — which *compounded* it, R20 canvas-fit). The actual cause:
  `text/primitives.ts` renders `fontSize × canvasHeight/90`, so fontSize is a
  **/90-relative unit (~15 is normal), not pixels** — and templates authored it as raw
  px *and* multiplied by height/1080. The fix re-authored every template to the relative
  unit and split `fontScale` (user scale only) from `canvasScale` (positions). The
  quadratic was then *structurally gone*, not masked.
- **Vanishing tracks (R9).** "Add track" tracks kept disappearing. Root cause: an
  **empty-track pruning reactor in `core/index.ts`**. Fix: a `keepWhenEmpty` flag the
  reactor respects — not a workaround that re-adds the track.
- **VP9-alpha overlays showed nothing (R3).** Cause: WebCodecs can't decode VP9 alpha,
  so alpha clips composited as opaque black. Fix: exclude them from the WebCodecs render
  tree and reproduce via a DOM `<video>` preview layer + ffmpeg burn-in on export — a
  real architectural answer, in both preview *and* export.
- **AI Cut broke on a 9-min real video (R15).** Cause: assemble re-added footage already
  on an overlay track → a doubled copy wrecked silence detection. Fix: skip mediaIds
  already on *any* track.
- **Cursor vanished after scrubbing (R14).** Cause: `requestPointerLock` leaves the
  Chromium cursor invisible after exit. Fix: `setPointerCapture` + a body cursor.

**Keep-alive rule:** when a fix feels like the third patch for the same symptom, stop.
The symptom is recurring because the model of the system is wrong. Find the rendering/
reactor/unit that actually governs the behavior and fix *that*.

### 2.2 Verify the rendered output, not the parameters

The discipline that turned 2.1 from luck into a method — and, tellingly, the discipline
whose *absence* caused the bugs in the first place.

- The fontSize bug "survived three rounds" precisely because every check read fontSize
  *values* (which looked plausible: 40, 64, 110) instead of **measuring rendered
  pixels / canvas-height fraction**. R21 verified by measuring: kinetic-title went from
  122% of canvas height to 27.8%.
- R24 re-learned the same lesson in the other render path: baked blocks' transform was
  correct in params but **dead in both the preview layer and the ffmpeg export**, and the
  two didn't even match each other. The fix was verified by checking the preview rect
  against the compositor's math *and running a real export* — POSTing to
  `/api/media/composite`, extracting a frame, and confirming the overlay landed inside a
  marked box. `preview == export == compositor`, proven on pixels.

**Keep-alive rule (now in `HANDOFF.md §4`):** for anything visual, **verify rendered
pixels and run a real export/frame-extract — never element params.** Params can look
right while every render path is wrong. Use `measureTextElement` / `window.__vibeEditor`
for the live numbers.

### 2.3 Adversarial self-audit before claiming "done"

The June-13/14 editor audit is the clearest example: a **26-agent read-only review with
adversarial verification that rejected 7 of its own over-claims** and surfaced 13 *real*
defects, then traced them to **two root shortcuts** (ripple delete not being track-scoped;
the overlay built as a sidecar beside the compositor). The output wasn't a vague list —
it was a ranked, root-caused defect set with the critical one (Shift+Delete on an overlay
rips out the footage beneath it) called out and fixed first, on Dan's explicit greenlight.

**Keep-alive rule:** for any "is the system actually correct?" question, fan out
independent readers, then make them *try to refute* their own findings before reporting.
Default findings to "unproven" until verified. The 7 rejected over-claims are the value —
an audit that confirms everything it suspects is not an audit.

### 2.4 Fail loud — never silent-fallback

Silent fallbacks were explicitly identified as a bug class (`HANDOFF.md §5.3`) and
removed:

- The pen tool quietly created a *shape* when masking failed → now errors loudly when a
  clip is selected but not maskable; never a silent wrong-thing.
- `claude-code` mode returned nested command JSON the client silently ignored → a
  `normalizeCommand()` flattens it, and the prompt shows exact-shape examples.
- Every AI Cut / RUN stage reports its failure **with the stage name** ("While
  '<stage>': …") rather than a dead toast.

**Keep-alive rule:** a failure must be visible at the stage it happened. A fallback that
hides a failure is a bug, not a safety net.

### 2.5 Non-destructive by construction

The system never overwrites the user's work; it adds, and it reverts cleanly.

- AI placement goes onto **new** overlay lanes / new audio tracks — never over existing
  footage (`placement.ts buildAiLanes/claimLane`).
- The Swiss-grid reframe was changed from a **permanent base-param mutation** (video
  stayed shrunk forever) to **keyframes that revert to full-frame** at the segment end —
  the non-destructive version of the same effect (R21).
- Today's ripple fix (06-14): `RemoveRangesCommand` gained an optional per-range
  `trackId` — present = ripple *only that track*; absent = the all-track extract used by
  silences/repeats/autocut. Ripple-deleting an overlay block no longer disturbs the
  footage beneath it. The diff is small, heavily commented, and preserves every existing
  caller's behavior by making the new arg optional.

**Keep-alive rule:** default to additive and reversible. If an effect mutates base
state, ask whether it should be keyframed/scoped so it can be undone and so it leaves
neighbors untouched.

### 2.6 One user action = one undo step

Every compound operation (bake+place, nest, reframe, template rebuild, multi-track
ripple) is wrapped in a single `BatchCommand` so it reverses in one Ctrl+Z. The audit
flagged the few places this wasn't true (bake/re-render/nest weren't atomic) as defects —
i.e., the invariant is treated as a *requirement*, not a nicety.

**Keep-alive rule:** if a button does N things, it undoes in 1. Wrap it in a batch.

### 2.7 Long operations are abortable

RUN HYPERFRAMES and AI CUT thread an `AbortSignal` through every stage (`Promise.race`
in remove-repeats and run-hyperframes), and the Stop button actually interrupts
mid-stage. Token usage is surfaced. Nothing expensive runs without a way to cancel it
and an honest readout of what it cost.

**Keep-alive rule:** anything that spawns a render or an LLM call gets a Stop and a cost
readout from the start, not bolted on later.

### 2.8 Additive, migration-safe change

Changes reach existing users/state without resets or breakage:

- The keymap merge was made **additive** — new default shortcuts are adopted only when
  their key is still free, so new bindings reach existing users without wiping their map.
- New element fields (`framecutAi`, `motionTemplate`, `linkId`, `registryBlock`,
  `motionTemplate.scale`) are **optional with no zod gate**, so old projects load
  unchanged and new data "just works."
- `keepWhenEmpty` and `linkedSelectionEnabled` ship with persisted-store migrations.

**Keep-alive rule:** new persisted state must degrade gracefully on old data. Prefer
optional fields and additive merges over schema bumps that force a reset.

### 2.9 Match a real reference; don't guess semantics

`HANDOFF.md §5.5`: several features needed rework because the first build *guessed*
Premiere's behavior (pen close, A-key as tool vs. action, gap-delete blocking rule). The
correction was a standing rule: **WebSearch how Premiere does it, cite it, then build.**
The gap-delete "blocked when another track overlaps the span" rule was confirmed against
Premiere's sync-lock behavior before shipping.

**Keep-alive rule:** when building an editor feature, the reference behavior is a fact to
look up, not a thing to invent. North-star: "a simplified Premiere."

### 2.10 Tell the user the honest limits

Repeatedly, the build told Dan what *couldn't* be done yet rather than faking it:

- R22's "honest panel" splits real Blocks (61, droppable) from transition shaders (27,
  which bake to a self-contained demo and are *not* real transitions) and labels Styles/
  Components "not droppable yet" — instead of offering an Add button that produces garbage.
- R18 told Dan plainly that registry cinematic assets can't go native and that a true
  single-clip compound container is engine-level future work.

**Keep-alive rule:** a disabled-but-honest affordance beats an enabled-but-broken one.
Say what doesn't work yet.

### 2.11 Performance only with a safe fallback

Every speed lever has a graceful degrade:

- ffmpeg burn-in probes hardware H.264 (nvenc→qsv→amf) **with a per-request libx264
  fallback**; the export `CanvasSource` sets `prefer-hardware` and falls back to software
  automatically.
- Baked blocks contain-fit so they never overflow a mismatched canvas.

**Keep-alive rule:** add the fast path *and* its fallback in the same change. Never make
performance a correctness gamble. (See `HANDOFF` / memory for the ranked, not-yet-done
export levers B–F, each noted with its caveat — e.g. the local ffmpeg "essentials" build
likely lacks the CUDA filters lever D wants.)

### 2.12 Cache with a correctness key

Caches are keyed on content so they can never serve a stale wrong answer:

- The bake cache key is a **hash of the composition HTML + dims + fps**, so a registry
  update auto-re-bakes (cache hit ~0.3s vs ~20s render, but never wrong).
- The transcript cache hashes the audible-timeline state (mediaId/start/duration/trims)
  with in-flight dedupe, so AI Cut and RUN start instantly on a warm hash and recompute
  the moment the timeline changes.

**Keep-alive rule:** a cache key must include everything that changes the output. If you
can't articulate what invalidates it, you don't have a cache, you have a bug.

---

## 3. The process that produced it

The patterns in §2 didn't happen by inspiration — they were produced by a **repeatable
ritual and a set of living ledgers**. This is the operating system to protect.

### 3.1 The round ritual (per `HANDOFF.md §2`)
`git checkout main && pull` → `feat/roundN` branch → code → **`bun run build:web` must
exit 0** → **live-verify in the preview browser** → **add a `PATCHES.md` row for every
upstream file touched** → commit via `git commit -F tempfile` → `gh pr create` →
`gh pr merge --merge --delete-branch`. One round = one branch = one PR = one reviewable
unit. 46 PRs in, the cadence never degraded into direct-to-main commits.

### 3.2 `PATCHES.md` — the upstream-edit ledger
Every change to an OpenCut-originated file is logged in the same commit, with a "notes
for a future port" column. This does two things: it **minimizes blast radius** (new code
lives in `features/ai-generate/`, `packages/hf-bridge/`, etc.; touching upstream is a
last resort), and it keeps the fork **portable** if features are ever moved onto the
OpenCut rewrite. The ledger is also a discipline forcing-function: if a change requires a
new PATCHES row, you're reminded you're modifying shared ground and should keep it minimal.

### 3.3 `HANDOFF.md §5` — the permanent "do not repeat" log
Nine mistakes are written down with the verbatim user feedback that caused them
("This is not true at all, it doesn't work. You need to test your changes."). This is the
mechanism that turns a one-time failure into a standing rule. The fontSize-unit lesson and
the verify-pixels-not-params rule live here precisely so the *next* session can't repeat
them — and the model handoff at R19 proves it worked.

### 3.4 The live-verify playbook (`HANDOFF.md §6`)
A documented method for the ephemeral preview browser: recreate test media with a SAPI-TTS
recipe, **delete it from `public/` before committing**, assert via `window.__vibeEditor`
and DOM observables rather than screenshots (which time out under load), and the synthetic-
input gotchas (Radix ignores `.click()`; React needs `mouseover`; commit a controlled Input
via a bubbling `focusout`). Every round closed with "verified live," not "compiled."

### 3.5 Plan mode for risky, multi-step rounds
The big structural rounds (R16 native templates, R20 template fixes) went through an
approved written plan first (`~/.claude/plans/there-are-quite-a-wise-teapot.md`). Risky
renderer-touching work was explicitly *not* rushed — the transition system was scoped and
deliberately deferred to "a dedicated, properly-planned round, NOT rushed" rather than
bolted on.

### 3.6 Separation of concerns as a hard rule (`BRIEF.md §3`)
New code goes in `packages/*` or `features/ai-generate/`; the timeline is hard-capped at
4 tracks; HyperFrames is consumed via pinned npm only, never vendored. These constraints
are *why* the upstream surface stayed small and the fork stayed buildable.

### 3.7 Continuity artifacts (memory + handoff mirror)
The project memory file and `HANDOFF.md` are kept in sync, so a new session (or a new
model) reconstructs full context — goals, architecture, mistakes, queued work — in one
read. This is the literal mechanism that made the Fable→Opus handoff seamless.

### 3.8 Test-data hygiene
Synthetic media is deleted from `public/` pre-commit; synthetic self-learning signals
(undo-spam runs) are cleared from the preference store after testing. The repo never
accumulates test cruft or poisoned learning data.

---

## 4. Where quality dipped — and how the system caught it

Keeping the level alive means knowing the failure mode, not pretending there wasn't one.
There was exactly one recurring failure mode, and the system's *recovery* from it is the
most valuable thing here.

**The failure mode: over-claiming "done" after checking params instead of rendered
output.** It happened at least twice — the fontSize bug (survived 3 rounds) and the R24
overlay transform (correct in params, dead in both render paths). Both are the same
mistake: *the data looked right, so I didn't look at the pixels.*

**The recovery mechanism (this is the asset):**
1. Dan tests on **real footage** and gives blunt feedback with screenshots.
2. That forces reading the **render code**, not the param values.
3. The fix is verified by **measuring pixels and running a real export**.
4. The lesson is **written into `HANDOFF.md`** so the next session can't repeat it.

A secondary dip — R16 shipped templates whose editing path silently didn't work — produced
the standing **per-item verification matrix** (insert → edit each field → move/trim → undo
→ re-edit, observed, not assumed). Again: a one-time miss became a permanent rule.

The meta-point: the build was not flawless. It was **self-correcting**, because the
feedback loop (real-footage testing → read the render path → measure → codify) is
institutionalized. Protect that loop above all else.

---

## 5. Keep-it-alive checklist

A concrete list the next session — any model — can run against. If a round violates these,
it has regressed from the standard.

**Before writing code**
- [ ] Read `HANDOFF.md`, `BRIEF.md`, `PATCHES.md`, and the memory file. Reconstruct full context first.
- [ ] For an editor feature: look up how Premiere does it, cite it. Don't guess semantics (§2.9).
- [ ] For a risky / multi-step / renderer-touching round: write a plan and get it approved (§3.5).

**While building**
- [ ] New code in `features/*` or `packages/*`; touch upstream only as a last resort, and log every such file in `PATCHES.md` in the same commit (§3.2).
- [ ] Compound actions wrap in one `BatchCommand` — one user action, one undo (§2.6).
- [ ] Placement is additive (new tracks); effects that mutate base state should be keyframed/scoped so they revert and don't disturb neighbors (§2.5).
- [ ] New persisted fields are optional and degrade on old data; store merges are additive (§2.8).
- [ ] Failures surface loudly with their stage; no silent fallbacks (§2.4).
- [ ] Expensive ops (render, LLM) ship with a Stop + a cost readout (§2.7).
- [ ] Fast paths ship with their fallback in the same change (§2.11). Caches key on content (§2.12).

**Before claiming done**
- [ ] `bun run build:web` exits 0 (§3.1).
- [ ] **Live-verify the actual user flow** in the preview browser, not just compilation (§3.4).
- [ ] For anything visual: **measure rendered pixels and run a real export / frame-extract.** Never sign off on element params (§2.2). This is the rule that, when skipped, cost three rounds.
- [ ] Run the per-item verification matrix: insert → edit each field → move/trim → undo → re-edit (§4).
- [ ] Tell Dan the honest limits of what shipped; disable-honestly over enable-broken (§2.10).
- [ ] Delete synthetic test media from `public/`; clear synthetic learning signals (§3.8).
- [ ] If a fix is the 3rd patch for one symptom, stop and root-cause it (§2.1).

**After**
- [ ] If something went wrong, write the lesson into `HANDOFF.md §5` and the memory file so it can't recur (§3.3).

---

## 6. When you're not making progress — the un-sticking ladder

The recurring failure mode (§4) recurs *across models* — it bit Fable (R16) and Opus
(fontSize, R24). So the way *out* of it has to be inherited too. This is the protocol for
any model — Opus included — that hits the same issue Fable hit and starts spinning.

**Trigger:** the same *class* of fix has been tried 2–3 times and the observable hasn't
moved. That is not "try harder" — it means your model of the system is wrong. Fable's tell
was naming it out loud ("we patched this symptom three times"). When you notice it, stop
iterating and run this ladder, in order:

1. **Suspect the harness before the logic — confirm the code under test is the code that's
   running.** The top cause of false stuckness here was editing code that wasn't executing:
   stale HMR, a `useState` controller that doesn't hot-reload (the interaction controller —
   see §6/R17 in HANDOFF), a stale bundle, a torn-down dev server. Force a full page reload /
   server restart and re-read the **live** state via `window.__vibeEditor`, "not from memory,"
   before the next edit. Skipping this builds every later step on sand.
2. **Change what you're measuring — verify the OUTPUT, not the INPUT (§2.2/§2.3).** This *is*
   the recurring bug. If you've been confirming params/values/config and nothing improves,
   you're measuring the wrong layer. Switch to the rendered pixel / exported frame /
   playthrough / live DOM number. Read the render code, not the element params.
3. **Stop adjusting the knob; instrument to find the real bottleneck (§2.1).** When the
   obvious lever does nothing, the mechanism is elsewhere. Add logging/measurement to locate
   where it actually breaks ("the Add handler itself is failing silently. Instrumenting it").
4. **Bisect by isolating the suspect and running it against live data.** Pull the suspected
   function out and run it in isolation on the real current state. If it works in isolation,
   the bug is in the invocation/path, not the logic — which relocates the whole search ("The
   algorithm works perfectly on live data… So the controller path isn't invoking it").
5. **Reframe the stuck point as one decisive experiment.** Write the question and the test
   that answers it unambiguously ("Determine: does the compositor honor VP9 alpha? Test
   pixel-level with overlay over footage"). Flailing becomes one experiment with a verdict.
6. **If the diff is ballooning, revert and go surgical.** A growing, non-converging change is
   itself evidence the approach is wrong ("Full-file rewrite as feared. Reverting and doing
   it surgically"). Back out to last known-good; re-attack with the smallest possible change.

**Two escalations a multi-agent model can do that a single thread can't:**
- **Fan out an adversarial second opinion.** Spawn 2–3 independent agents to diagnose the
  same failure from different angles and default their findings to "unproven" — the audit
  pattern that rejected 7 over-claims (§2.3). Redundant perspectives break a wrong mental
  model faster than one thread re-reading its own assumptions.
- **Surface the stuck state honestly instead of emitting another confident-but-wrong
  attempt.** The failure mode is silent spinning that ends in an overclaim; the fix is making
  the uncertainty loud early — "here's what I've ruled out, here's my hypothesis, here's the
  test that would settle it" — and bringing Dan (the verifier of last resort) or an agent in.

**Meta-principle:** being stuck means your model of the system is wrong, so the move is never
another attempt at the same layer — it is to *relocate the search* (Is the code running? Am I
measuring the output? Does the suspect work in isolation?). When the loop breaks, prove the
fix against the output and write the lesson into §5 of HANDOFF so the next session inherits
the un-sticking, not just the fix.

## 7. The meta-lesson

The work was exceptional not because any single fix was clever (several were — the fontSize
unit, the alpha-overlay pipeline, the additive keymap merge), but because the project runs
on a **quality operating system**: a ritual that produces reviewable units, ledgers that
keep the blast radius small and the lessons permanent, and a verification discipline that
trusts pixels over parameters and real-footage testing over "it compiled."

That OS is portable. It carried the quality across a model handoff at Round 19 without a
visible seam. So the way to "keep this level alive" is not to hope for an exceptional
model — it's to **defend the artifacts and the loop**: keep `HANDOFF.md`/`PATCHES.md`/the
memory file honest and current, keep the round ritual intact, and never let "the params
look right" substitute for "I measured the pixels and ran the export."
