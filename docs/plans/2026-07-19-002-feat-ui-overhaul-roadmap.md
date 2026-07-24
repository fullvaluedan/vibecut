---
title: "feat: UI overhaul roadmap - core-loop stabilization, per-feature worktrees, Premiere as the guide"
type: feat
date: 2026-07-19
depth: roadmap
---

# feat: UI overhaul roadmap (per-feature worktrees, delegated builds)

## Dan's binding decisions (2026-07-19, supersedes the panel-audit defaults)

- D1 Masks: BROKEN, wants DEEP FIXES, not hiding. Research prior art on GitHub first (the OpenCut
  rewrite and other OSS editors).
- D2 AI CUT: the menu shows exactly two options, "AI CUT" (the Director) and "Remove silences".
  Auto-assemble and Highlight are hidden.
- D3 Stickers: delete the orphaned code.
- D4 Panels: hide the ones that are not useful, for now (reversible). Elevated as important:
  CREATE AND EXPORT TRANSCRIPTS (very important), adding TEXT, adding SOLIDS.
- D5 Design standard: the Transform panel (Effect Controls) is the reference for ALL panels - the
  blue numbers, the boxes, the layout. Unify button/control behavior across the app to match it.
- D6 HyperFrames/Remotion: PARKED on the roadmap. A week was spent and it failed. No further work,
  and its UI surfaces are hidden with everything else in W2.
- D7 Process: split work into per-feature worktrees, each developed/built/tested/verified in its
  own environment; research the equivalent Premiere Pro experience as the guiding principle
  BEFORE building; ALL implementation delegated to Opus/Sonnet/Haiku; Fable plans only.

## Hidden-panel default list (W2, flag-gated and reversible in one edit)

HIDE: HyperFrames bin tab, the RUN HYPERFRAMES toolbar cluster (button, dropdown, Versions x3,
Log, Stop), the HyperFrames drafts panel, the assistant prompt box in the preview toolbar, the
Sounds tab, the Effects tab. KEEP: Media, Text, Shapes, Captions, Transcript, Settings.
(Dan can amend this list; it is one const in one file.)

## Workstreams

| ID | Feature (worktree) | Model | Phase | Premiere guiding principle | Status |
|---|---|---|---|---|---|
| W1 | Export: chunked audio mixing for long videos (the ~21-min `createBuffer` wall; Dan's live project is 29 min) | Opus | 1, NOW | Export never fails on length; render progresses visibly | MERGED 89aebd5b (live 29-min export = smoke #10) |
| W2 | Panel slimming: hidden-list above + AI CUT menu to two options + Director dock idle card to two actions | Sonnet | 1, NOW | Premiere ships many panels but a curated default workspace; hiding = workspace curation | MERGED adf9b16a |
| W3 | Dead-code deletion: orphaned stickers view (3,435 LOC), guides popover, freeze-frame comment, stale "OpenCut" banner string (PATCHES row) | Sonnet | 1, NOW | n/a (hygiene) | MERGED 198bd733 |
| W4 | Transcript create + export (VERY IMPORTANT): verify existing transcribe flow, add first-class export (TXT, SRT, VTT at minimum) | Sonnet | 1b, after research | Premiere's Text panel: transcribe sequence, export transcript as .txt/.srt/.csv | MERGED 5bbda617 (shipped txt/srt/csv + word-seek + search) |
| W5 | Masks deep fix | Opus | 2, after research | Premiere's masking: shape + pen masks on clips/effects, feather/expansion/opacity, direct-manipulation handles | MERGED cd40049f (3 red tests fixed; expansion/opacity built but flag-gated on the wasm rebuild) |
| W6 | Design-system unification: extract the Transform panel's control language (blue draggable numeric values, boxed groups, twirl-down layout) into shared components; apply panel by panel | Opus spec, Sonnet apply | 2, after research | Premiere's "hot text" blue scrubbable values and uniform panel conventions - the exact look Dan is pointing at | MERGED dbe4d7d9 (follow-ups noted in its commit: speed-tab/project-info-chip Escape wire, multi-row group resets) |
| W7 | Solids: first-class solid-color layer (full-frame color matte), one click/drag from the Media bin | Sonnet | 1b, after research | Premiere's Color Matte / Legacy "Solid" | MERGED d819efc3 (export render of a solid = live-verify) |
| W8 | 20-minute smoke list distilled from TO-VERIFY, then reconcile (check off confirmed, reopen failures as named bugs) | Haiku draft, Dan executes | 1b | n/a | docs/SMOKE-20MIN.md committed 83bd950c; DAN'S TURN |
| W9 | Director round 13: final-read recall (ADDENDUM 11's labeled 9-fragment test set; precision 5/5 must hold) + Cancel = one undo | Opus | 3 | Premiere has no equivalent; our own measured bar governs | queued (next build item) |
| U0 | Pause-on-timeline-click (round 14) | Sonnet | 1, NOW | Premiere timeline feedback during playback | MERGED 8adad3e6 (timeline click pauses, playhead stays at clicked point) |
| U1 | Multi-pass core: virtual apply + P2 second cut (round 14) | Opus | 1, NOW | 3-pass architecture per Dan's directive | MERGED 8adad3e6 (OFFERED recall google +5.2pp, how-to-edit +8.8pp) |
| U2 | P3 final-read v2: revert-harmful + fragmentation guard (round 14) | Opus | 1, NOW | Safe cuts via final verification + micro-cut merging | MERGED 8adad3e6 (harm-revert demotion + deterministic fragmentation guard) |
| U3 | Per-project run ledger feeding taste notes v2 (round 14) | Sonnet | 1, NOW | Learning across runs per category | MERGED 8adad3e6 (per-pass/per-category outcome stats injected to prompts) |

## HELD, unmerged, needs measurement before it lands (added 2026-07-20)

`worktree-agent-a2dcdcc24f461aa97` (commit `064b51c7`) is COMPLETE and GATED but deliberately NOT
merged. Two fixes:

- **Keeper-swap near-verbatim gate (safe).** `applyKeeperSwap` re-derived acceptance without the
  `nearVerbatim` conjunct the initial mapping applies, so swapping which take a PARAPHRASE group
  keeps silently promoted its rows to auto-checked, defeating the round-7 protection. Interactive
  path only, invisible to the eval, zero measurement risk.
- **Swallow-pause OFFERED-vs-AUTO resolution (CHANGES CUT OUTPUT).** Root cause of the long-red
  `diag-join-the-group` R3 assertion: after widening, overlapping removals were clipped purely by
  raw start-time order, so an OFFERED recall row (retake/structural/backstop, which one-click apply
  NEVER executes) could win disputed territory and clip an accepted pacing cut to zero, leaving real
  dead air in the AUTO output. The fix resolves accepted removals against each other first, freezes
  that territory, then trims OFFERED rows against it. Diag now green.

**Why held:** the second fix makes the AUTO path cut MORE (diag autoCutSeconds 29.5 -> 32.6, auto
ops 4 -> 5). Rounds 11 and 12 were entirely about REDUCING auto harm, so this could partially undo
that win and must be measured on the four-fixture eval before merging. A round-13 eval was already
in flight when this landed, and the standing rule forbids overlapping an eval with pipeline edits.

**Sequence when picking this up:** merge round 13 first, then merge this branch onto that tip, then
run ONE `--llm --runs 3` eval and compare AUTO essLost per fixture against ADDENDUM 12's numbers.
If AUTO essLost rises materially, the tension is real (more correct dead-air cutting vs more
essential words lost) and belongs in an addendum with Dan's call, not a silent merge.

## Backlog (round 15+ follow-ups from round 14 measurement)

- Instrument tiny-cut counter in eval score (ADDENDUM 13b): the fragmentation guard's behavior is pinned by unit tests but the eval cannot measure cuts-under-0.5s-not-companion; add the counter to score.ts for next measurement.
- P2 confidence gate if Dan reports review fatigue (ADDENDUM 13b): second-pass paraphrase-redundancy rows have 65-77% offered precision across noisy fixtures (roughly one in three rejected by Dan); if review load becomes an issue, apply per-pass confidence floor following the ADDENDUM-12 pattern.

## Parked (roadmap, not scheduled)

- HyperFrames/Remotion generation layer (D6). Everything hidden by W2 stays in the codebase;
  un-hiding is one edit when Dan reopens it.
- Director Vision v0 (stays gated off, no verification spend).
- Transition slot (the suppressed "Add" affordance stays suppressed).
- Playback-stutter #6 (blocked on the Rust/wasm toolchain, unchanged).

## Process contract (every workstream)

1. Own worktree branched from feat/director-eval tip; preamble: `git reset --hard
   feat/director-eval`, `bun install`, copy `apps/web/.content-collections` from the main checkout.
2. Research phase first where the table says so; the researcher's Premiere notes ride into the
   builder's spec.
3. Gates in the worktree before commit: apps/web suite (1465 pass + exactly 3 known mask failures
   as of tip e91d636b; W5 is expected to CHANGE the mask number by fixing them), hf-bridge 188,
   tsc clean. One commit per workstream, no push; Fable merges sequentially and re-gates.
4. Hard rules ride along: Edit tool only, no em dashes, PATCHES.md same-commit for upstream files,
   plain-language user-facing strings, prompt version bumps for prompt changes (W9).
5. Fable's role: plans, specs, launch, review, gates, merges, docs. No product code.

## Merge order and conflict watch

W3 and W2 both touch `timeline-toolbar.tsx` (different regions); merge W3 first, then W2, re-gate
after each. W1 is isolated (export engine). W4/W7 touch left-panel views after W2 lands, so they
branch from the post-W2 tip. W6 lands last in its phase (it repaints what survives W2).
