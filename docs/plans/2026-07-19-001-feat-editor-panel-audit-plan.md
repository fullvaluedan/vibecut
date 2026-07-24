---
title: "feat: editor panel audit - per-panel fix/polish/remove verdicts and the next UI rounds"
type: feat
date: 2026-07-19
depth: standard
---

# feat: editor panel audit (per-panel verdicts, next UI rounds)

## Summary

Dan's directive (2026-07-19): "A lot of our UI isn't working. Create a detailed plan to improve
each panel. Recommend adding or removing if it's not worth it." Two audits ran against the tip
(665a6160): a full panel inventory (every surface, reachability, authorship, dead ends) and a
breakage cross-reference (TO-VERIFY, LIVE-TEST-ISSUES, handoffs, code markers), weighted by the
BRIEF's core workflow: record, AI CUT, review, hand-tune on the timeline, export.

Three headline findings shape everything below:

1. **The single scariest item is not a panel: it is EXPORT on long videos.** The ~21-minute
   `createBuffer` wall is a known latent failure whose real fix (chunked audio mixing) was never
   built. Dan's current project is 29 minutes. He may finish his edit and be unable to export it.
   This is P1 and jumps every queue.
2. **Most of what "isn't working" is actually SHIPPED-BUT-UNCONFIRMED.** All four of Dan's
   2026-07-17 live-test bugs (linked-clip extend, vanishing menu, timeline snap-back, cut texture)
   have merged fixes; zero have his live sign-off. TO-VERIFY has grown to 300+ lines nobody will
   ever work through. The fix for "a lot of UI isn't working" starts with a 20-minute guided smoke
   list, not more code.
3. **There is real dead weight to delete.** An orphaned 3,435-LOC stickers UI no imports reach, a
   grid/guides overlay commented out since v0.4.0, a suppressed half-built transition affordance,
   and a stale "open OpenCut in Chrome" banner string.

## Per-panel verdicts

Verdict key: KEEP (works, leave alone), FIX (broken or core-critical work named), VERIFY (shipped
fixes awaiting Dan's hands), SLIM (keep but reduce surface), REMOVE (delete or keep hidden).

| # | Panel / surface | State | Verdict |
|---|---|---|---|
| 1 | Export (header) | Latent long-video wall at ~21min audio; save-picker + progress fixes unverified | **FIX (P1): chunked audio mixing** |
| 2 | Timeline (+ toolbar, tool-rail) | Heaviest fix backlog, all shipped, almost all gesture-verification pending; 8-track cap SEVERE item command-verified only; playback stutter blocked on wasm toolchain | **VERIFY (guided smoke), then fix reopened items** |
| 3 | Director dock (AI CUT) | The product core, 15k LOC, healthy; final-read recall 5/14 is the measured gap; Cancel is not one-undo; opening paraphrased repeat still uncaught | **FIX: round-13 recall lever + Cancel rollback** |
| 4 | Preview canvas + toolbar | Solid; cursor polish unverified; stutter blocked (wasm); guides overlay dead since v0.4.0 | **KEEP; delete dead guides code** |
| 5 | Media bin (Media tab) | Multi-drop and audio-separation fixes shipped, unverified | **VERIFY (in the smoke list)** |
| 6 | Properties panel | State-hygiene fixes unverified; serves motion-graphics editing more than the cut loop; masks subsystem is 6.5k LOC and owns the suite's only 3 failing tests | **SLIM: verify the basics; decide masks (see D1)** |
| 7 | Transcript tab | FrameCut, text-based ripple-delete, directly serves the cut loop | **KEEP** |
| 8 | Captions tab | Serves talking-head output | **KEEP** |
| 9 | Text tab + motion templates | Serves Dan's graphics passes | **KEEP** |
| 10 | Sounds / Shapes / Effects tabs | No known breakage, low traffic | **KEEP (zero work)** |
| 11 | Settings (AI / Hotkeys / Background / Help) | Reworked recently, agent-verified; hotkey editor items unverified | **VERIFY (smoke list)** |
| 12 | HyperFrames panel + RUN HYPERFRAMES | Works for blocks; transition "Add" suppressed (slot never built); five overlapping AI entry points confuse the app | **SLIM: consolidate AI entry points (see D2); transition slot stays unbuilt** |
| 13 | Assistant prompt box (preview toolbar) | One of the five AI entry points | **fold into D2** |
| 14 | Director Vision v0 | Opt-in, off by default, heavy unverified list, marginal to scripted talking-head work | **KEEP GATED OFF; stop spending verification on it** |
| 15 | Stickers UI (orphaned dir) | 3,435 LOC unreachable by any import; legacy elements still render via properties config | **REMOVE the orphaned view (keep legacy render path)** |
| 16 | Grid/guides popover | Commented out since v0.4.0, unreachable | **REMOVE** |
| 17 | Scenes selector sheet | Wired and working; cosmetic no-op prop | **KEEP** |
| 18 | Root dialogs (gate, onboarding, migration, changelog) | Fine; DegradedRendererBanner still says "OpenCut" | **KEEP; fix the brand string** |

## Dan's decision points (the plan proceeds on defaults if unanswered)

- D1 **Masks**: if you never use the Masks tab, we hide it behind a Settings toggle and stop
  maintaining its 6.5k LOC surface (the suite's only 3 failing tests live there). Default: hide.
- D2 **AI entry points**: today there are five ways to invoke AI (RUN HYPERFRAMES button, AI CUT
  menu, HyperFrames tab, assistant prompt box, Settings AI). Proposal: two surfaces only -
  AI CUT stays the cutting entry (Director dock), and generation consolidates under the
  HyperFrames tab + one toolbar button. The assistant prompt box either becomes the single
  universal entry or goes. Default: design doc first, no removal without your sign-off.
- D3 **Stickers**: deleting the orphaned view is invisible to you unless you have legacy sticker
  elements in old projects (they keep rendering either way). Default: delete.
- D4 **Which panels you never open**: your answer reorders the VERIFY queue. Default: the core-loop
  order above.

## Units, in order

- U1 **Export chunked audio mixing (P1).** Replace the single offline `createBuffer` mix with
  chunked processing so a 29+ minute timeline exports. Gate: export Dan's real project length
  (synthetic 30-min timeline in a headless harness, plus his live confirmation). This unblocks the
  video he is editing RIGHT NOW.
- U2 **The 20-minute smoke list.** Distill TO-VERIFY's 300+ lines into docs/SMOKE-20MIN.md: the
  ~12 highest-value gesture checks (linked-clip extend, snap-back gravity, forward-select drag at
  the track cap, multi-asset drop, text-resize ANCHOR, round-12 join rows + error card, export
  save-picker), each one action + one expected result. Everything Dan confirms gets checked off
  TO-VERIFY; everything that fails becomes a named bug with a repro.
- U3 **Dead-code removal batch.** Orphaned stickers view, guides popover + wiring, freeze-frame
  comment, stale OpenCut banner string (PATCHES.md row: upstream file), scene-selector no-op prop
  comment. Suites must stay at 1465+3/188/tsc-clean; zero behavior change expected.
- U4 **Director round 13: final-read recall.** The measured lever from ADDENDUM 11: reframe the
  verify prompt around whether a fragment earns its screen time; tune against the 9 labeled missed
  fragments; precision 5/5 must not regress. VERIFY_PROMPT_VERSION bump; per-fragment harness is
  the instrument (the AUTO/OFFERED eval is blind here).
- U5 **Director Cancel = one undo.** Cancel currently leaves the timeline mutated with N+1 undo
  entries. Make Cancel restore the pre-run state in one step.
- U6 **AI entry-point consolidation (design first).** One-page proposal for D2, then implement on
  Dan's sign-off.
- U7 **Masks decision execution** (per D1): hide behind a toggle, or leave as-is if Dan uses them.

## Standing rules

Edit tool only; no em dashes in added lines; PATCHES.md same-commit for upstream files (U3's
banner string, any masks-tab hiding touch); suites + tsc + the four-fixture eval when director
code moves (U4); prompt wording changes bump the pass's version constant (U4); worktree agents get
the reset/install/content-collections preamble; nothing merges without its gate.
