---
title: "feat: Director round 14 (multi-pass cutting with per-run learning) + pause-on-timeline-click"
type: feat
date: 2026-07-24
depth: standard
---

# feat: Director round 14 (multi-pass) + pause-on-timeline-click

## Dan's directives (2026-07-24, from a real 208-op applied run on 21-minute footage)

1. **Timeline click during playback must PAUSE and stay** at the clicked point. Today it seeks and
   keeps playing. (Premiere behavior matches Dan's ask.)
2. **The Director still under-cuts on one shot**: massive gaps of missing cuts, surviving repeats,
   and "randomly tiny cuts that aren't helpful." His prescription, verbatim shape:
   - First cut: removes silences and repeats
   - Second cut: verifies everything was caught and cuts again if there are issues
   - Third cut: third layer of verification
   - "And each time it happens, we should be learning and improving."
3. Delegate to Opus/Sonnet/Haiku; Fable plans only.

## Why multi-pass is the right architecture, in eval terms

ADDENDUM 8 proved the recall gaps on google-omni (offered match 62, ceiling 65) and how-to-edit
(37, ceiling 39) are STRUCTURAL: span-discipline ceilings that no threshold tuning reaches. The
road named then was "recall levers: more/better offered spans." A second analysis pass over the
ASSEMBLED RESULT is precisely that lever: after pass 1 removes silences/repeats, the residual
transcript is shorter and cleaner, surviving repeats become salient, and missed dead weight stands
out. Round 12 already built the materialization this needs (assembled-transcript.ts).

Dan's workflow reality (Applied 208 of 208 = select-all) also resolves the harm-vs-recall tension
of rounds 9-11: he applies everything, so per-row opt-in protection is not his safety net. The
safety net becomes P3: a final whole-result verification that REVERTS genuinely harmful cuts and
consolidates fragmentation. Aggressive recall + strong final verification, exactly his three-pass
shape.

## Architecture (the loop is VIRTUAL: no timeline mutation between passes)

- P1 "first cut": the existing pipeline at full strength (deterministic silence/repeat detectors +
  LLM plan + redundancy + recall passes), producing op set S1.
- Virtual apply: materialize the assembled state after S1 (assembled transcript, remapped word
  timings, remapped features/envelope) with a coordinate map assembled-time -> source-time. The
  VAD-gated transcription remap and assembled-transcript.ts are the precedents.
- P2 "second cut": run the ANALYSIS passes again over the assembled state (LLM plan + redundancy at
  minimum; detectors where cheap). New ops come back in assembled coordinates and are mapped
  through the coordinate map into source coordinates, then merged into S1 -> S2. Early exit: if P2
  proposes nothing material, skip to P3.
- P3 "third layer": final-read verification v2 over the assembled result of S2. Three duties:
  (a) flag remaining misses as offered rows (last recall sweep), (b) REVERT cuts that damage the
  read (the harm net), (c) TEXTURE: merge or drop fragmenting micro-cuts (the "randomly tiny cuts"
  complaint) via a deterministic fragmentation guard plus LLM judgment. Round 13's verify (v6)
  grows into this or a sibling pass; either way its prompt version bumps.
- The review dock shows ONE merged op list, as today, with pass provenance in the reasons. The
  run-feedback stage labels (round 12 U3) surface pass progress ("Second pass: reading the
  assembled cut...").

## Learning ("each time, we should be learning and improving")

Two loops, honestly scoped:
- WITHIN a run: inherent - P2 sees P1's result, P3 sees P2's.
- ACROSS runs (taste v2): a per-project run ledger persisting, per pass and per category: proposed
  vs applied vs later-unchecked counts, reverted-by-P3 kinds, and the user's explicit row toggles.
  Compact summaries inject into the prompts at the EXISTING taste-note seams (taste.ts already
  steers per category). No new UI beyond what exists; the ledger is storage + prompt injection.
  Explicitly NOT in scope: any cloud/telemetry, any cross-project sharing.

## Units and delegation

| Unit | What | Model | Depends on |
|---|---|---|---|
| U0 | Pause-on-timeline-click: any ruler/timeline click or scrub while playing pauses playback and the playhead stays at the click point. The cut-row timestamp click (round 9) KEEPS its seek-and-play behavior (explicit play affordance). | Sonnet | none |
| U1 | The iterative core: virtual apply + coordinate remap + the P1->P2 loop with early exit, inside/beside buildDirectorProposals so THE EVAL MEASURES THE REAL PIPELINE. New prompt-version constants for any new/changed pass prompts. | Opus | none |
| U2 | P3 final-read v2: revert-harmful, last recall sweep, fragmentation guard (deterministic micro-cut merge/drop + LLM texture judgment). VERIFY version bump. | Opus | U1 merged |
| U3 | Taste v2 run ledger: per-project persistence, per-pass/per-category outcome stats, prompt injection via existing taste seams. | Sonnet | none (thin seam) |
| U4 | Measurement: four-fixture eval --runs 3 before/after, ADDENDUM 13. Success = OFFERED recall and match adj up materially on google-omni and how-to-edit (the ceiling fixtures), AUTO essLost suite mean not above the round-13 baseline, tiny-cut count (cuts under 0.5s not attached to sliver-swallowing) DOWN. Direction stated, magnitudes measured, per the op-counts lesson. | main session | U1+U2 |
| U5 | Docs: TO-VERIFY rows, SMOKE-20MIN updates (multi-pass run + pause-on-click checks), roadmap status. | Haiku | U1-U3 |

## Standing rules

Per-feature worktrees with the reset/install/content-collections preamble; Edit tool only; no em
dashes in added lines; PATCHES.md same-commit for upstream files (U0 touches playback/timeline
code, which IS upstream); prompt wording changes bump that pass's version constant; never edit
pipeline code while an eval runs; suites (1672/204 at tip c6f53c60) + bunx tsc + diag + eval gates.
The canonical typecheck is `bunx tsc --noEmit` from apps/web (bun runtime + the app's TS 5.9.3);
direct node_modules/.bin/tsc invocations use the wrong compiler and false-fail.
