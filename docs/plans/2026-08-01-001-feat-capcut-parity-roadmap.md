# VibeCut: CapCut-parity roadmap (rounds 15-20)

Date: 2026-08-01. Author: Fable (planning only, per process contract).
Status: DRAFT v2 - Dan answered the v1 open questions and added two workstreams
(prompt-to-edit window; HyperFrames + Remotion authoring). Awaiting Dan's approval.
No implementation has started.

Dan's directives (2026-08-01):
- Reach 9/10 quality, functionality, and intuitiveness versus CapCut (leaning CapCut
  over Premiere). "We want this to FEEL like CapCut."
- Order: timeline first, transcript second, then everything else.
- VibeCut rename: simple page, logo is a wordmark that just says VibeCut, CapCut-style
  (bold modern wordmark; we design our own mark, we do not copy CapCut's actual logo).
- Main-track magnet defaults ON.
- Up to 8 video tracks AND up to 8 audio tracks; users can add and delete tracks.
- NEW: a prompt window where users type timeline changes (cuts, extends, add graphics)
  and the changes are actively reflected in the timeline.
- NEW: integrate HyperFrames and Remotion so users can easily design their own style
  preferences for both, with a short-sequence test render before any full render
  (per the dan-video render playbook).
- Fable plans; Opus/Sonnet/Haiku implement in per-feature worktrees, in parallel
  whenever files do not collide.
- A feature is DONE only when tested, proven working, and rated 9/10 or better in
  quality AND functionality by its verifying agent (gate G6 below). Final acceptance
  is always Dan's.
- NEW (2026-08-01, second directive): VibeCut becomes a sellable product. Two offers:
  (1) a self-serve package where users connect their own AI keys (LLM of choice +
  Groq for transcription), with a clear get-started/onboarding page because today
  all of that is hidden; (2) a hosted tier we run, with a credit system, a $20/month
  subscription that includes at least $10 worth of compute credits, a top-up shop,
  and margin coming from the spread between metered credit rates and raw provider
  cost. Pricing recommendation in Round 21.
- Ambiguous assistant prompts ask a clarifying question relevant to the video/edit
  (Dan, 2026-08-01) rather than guessing.

## 0. What the research found (5 reports, 2026-08-01)

Summarized so tasks below cite facts, not guesses.

### 0.1 Why videos land on V2 (all five causes located, zero tests exist on this code)

1. **Below-the-tracks drops pick the wrong lane.** Once any audio lane exists (i.e.
   after the FIRST video drop, because we auto-separate audio), dropping into the empty
   area below the tracks resolves against the LOWEST track, which is now an audio lane,
   incompatible with video, so a new video track (V2) is created above main. A code
   comment at `timeline/components/drop-target.ts:179-182` says this case should reuse
   V1; the code does not do what the comment says.
2. **Drops over the ruler/toolbar always spawn a new TOP track.** The drop surface
   covers the whole timeline panel and `headerRef` is never wired (`headerHeight = 0`),
   so a drop near the ruler computes negative mouseY, "above all tracks", forced new
   track.
3. **V1 occupied for the clip's full duration** at the drop x falls back to a new track
   instead of any CapCut-like insert (unless the pointer is directly ON a clip, which
   correctly ripple-inserts).
4. **Hit-test drift.** `getTrackAtY` sums base track heights only, ignoring the 2px top
   padding and keyframe-expansion rows.
5. **Discarded result fallthrough.** When the out-of-bounds branch resolves to an
   existing track, the result is thrown away and a new top track is created
   (`drop-target.ts:186-189`).

Empty-timeline special-casing exists ONLY for external file drops (and stops applying
after the first video because it also requires zero audio tracks). Bin drags have none.

### 0.2 The trim math is correct; the FEEL is Premiere because of three defaults

- Extend already works and clamps correctly at real source frames (CapCut clamps
  identically; a freshly dropped clip genuinely has nothing more to reveal).
- The Premiere feel comes from: (a) ripple editing defaults OFF, (b) the next clip is a
  hard wall (no push, no auto close-gap), (c) zero UI feedback when an edge is at its
  source limit (the handle silently refuses).
- CapCut's core difference is the **magnetic main track**: main-track clips stay
  butted, deleting/trimming auto-closes the gap, visible toggle. Overlay/audio lanes
  stay free-position. CapCut keeps audio embedded with manual "Detach audio"; we
  auto-separate. Dan likes our auto-separation: keep it, fix the drop logic.
- Missing entirely today: roll edit, slip, left-handle cross-track ripple.
- The 2026-07-17 fixes for linked-clip trim and head snap-back are in the code with
  unit tests but were NEVER hand-verified (docs/LIVE-TEST-ISSUES.md items 5/6/10 still
  open, docs/TO-VERIFY.md checkboxes unticked).

### 0.3 Transcript: 4 of Dan's 5 asks already exist; the 5th is 90% pre-built internally

- EXISTS: transcript panel (auto-transcribes 5s after timeline settles),
  click-word-to-seek, search, export txt (timecodes toggle) / SRT / CSV, and
  delete-selected-words which ripple-removes the range from ALL tracks as one undo.
- Transcription is **Groq** `whisper-large-v3-turbo` (cloud, BYO key) or in-browser
  Whisper (default). "Grok" is a misnomer; xAI is not involved.
- MISSING (Dan's key ask): the Director and the transcript panel are completely
  disconnected. No cut markers, no deleted-words window, no per-word restore.
- The enabling math already exists as Director prompt-building code, unexported to UI:
  `mergeAcceptedRemovalSpans` (exact removed spans), `assembled-transcript.ts` (dropped
  words + seam flags + a literal [CUT] marker convention), `virtual-timeline.ts`
  (assembled-to-source coordinate map).
- Two structural blockers: (1) any timeline change invalidates the whole transcript
  cache and triggers a FULL re-transcription, so pre-cut words are forgotten exactly
  when we need them; (2) there is no restore command, only whole-batch undo.

### 0.4 Panel inventory vs CapCut (the gap list)

- EXISTS and competitive: masks (9 shapes, feather/stroke/invert), captions (generate +
  SRT/ASS import + 6 styles), keyframes with a bezier graph editor, 17 blend modes,
  nesting, markers, scenes, rebindable shortcuts, AI Director, remove silences.
- PARTIAL: speed (constant 0.01x-5x only), effects (exactly ONE effect, Blur, tab
  flag-hidden), sounds library (built, flag-hidden), export (no resolution/bitrate
  picker).
- MISSING entirely: transitions, filters/color adjust, crop, reverse, freeze frame,
  chroma key, background removal, audio fade handles, sticker panel (module orphaned),
  speed curves, mask tracking, multi-mask combine.
- CapCut reference specs captured: mask shapes and params, speed curve presets
  (Custom, Montage, Hero, Bullet, Jump Cut, Flash In, Flash Out), inspector layout
  (Video/Audio/Speed/Animation/Adjust; Basic/Cutout/Mask sub-tabs), timeline toolbar
  toggles (main-track magnet, auto snapping, linkage).

### 0.5 Entry flow, branding, AI-assistant groundwork

- `/` is an inherited OpenCut MARKETING landing page ("Try early beta" -> /projects).
- `/projects` is a functional project list (grid/list, search, sort,
  rename/dupe/delete).
- Branding: SITE_INFO.title is already "VibeCut" but the logo asset is still OpenCut's
  SVG, OG metadata says @opencutapp, package is @opencut/web.
- Prompt-window groundwork already exists, flagged off: `HIDE_ASSISTANT_PROMPT = true`
  hides `preview/components/assistant-prompt.tsx`, and an `/api/assistant` route
  exists. The prompt-to-edit round builds on these, not from scratch.
- HyperFrames surfaces exist, flagged off: hyperframes assets tab, Run-HyperFrames
  cluster, drafts panel, auto-assemble, highlight. hf-bridge has author/plan/render
  API routes. Remotion is NOT in this repo (2026-07-22 findings doc); Dan's Remotion
  kit and playbook live in the dan-video skill (D:\Hermes\remotion-v2, canonical kit
  src/anthropic/sketch) whose render-reliability rules (probe-render short clips
  first, segmented renders, audio never from segments) inform Round 20.
- Dev launch config declares port 3000; CLAUDE.md's docker note says 3100.
  Ground-truth the port per the dev-server memory before any browser verification.

## 1. Decisions settled by Dan (2026-08-01). Agents do not relitigate these.

1. Keep auto-separated audio on drop; CapCut's embedded-audio model is NOT adopted.
   The fix is in drop targeting, not separation.
2. Main-track magnet defaults ON.
3. Track model: up to 8 video tracks and up to 8 audio tracks, user-addable and
   user-deletable. BRIEF.md/CLAUDE.md's "4-track hard cap" wording is superseded and
   gets updated (PATCHES.md rows in the same commits).
4. Order: Round 15 timeline, Round 16 transcript, then the rest. Rounds 17/18 may run
   in parallel worktrees where files do not collide.
5. VibeCut branding: simple home page; logo is a designed-by-us bold wordmark reading
   "VibeCut" in the spirit of CapCut's clean look. We never copy or imitate CapCut's
   actual mark or trade dress.
6. Single-drop audio separation joins the insert's command batch (one undo step).
7. "Grok" becomes "Groq" anywhere it refers to transcription.
8. HyperFrames/Remotion generation is UN-PARKED by Dan's 2026-08-01 directive, scoped
   as Round 20 with its own plan doc (auto-memory gets updated to reflect this).
9. Productization is in scope (Round 21): BYO-keys onboarding ships early (with
   Round 18, it is cheap); the hosted credit/billing tier gets its own plan doc.
10. Assistant ambiguity rule: ask a clarifying question about the video/edit; never
    guess destructively.

## 2. Gates and the 9/10 rating loop

Standard worktree preamble for every task (process contract): branch from
feat/director-eval (or its successor), `git reset --hard`, `bun install`, copy
`apps/web/.content-collections` (+ `.env.local`, `.eval-cache`, `eval-fixtures` when
the eval/diag is needed). Edit tool only; no em dashes in added lines; PATCHES.md row
in the SAME commit for upstream-originated files; marker-grep before commit AND push.

Gates:
- G1 `bun test` apps/web (1705+/0) and hf-bridge (204+/0)
- G2 `bunx tsc --noEmit` FROM apps/web
- G3 new unit tests for the changed area (each task lists its own)
- G4 hands-on browser check in the dev preview (each task lists its script)
- G5 Director rounds only: diag-join-the-group green, diag-join-verdicts recall >=
  11/14 precision 11/11, four-fixture eval --runs 3 for any essLost claim
- **G6 rating loop (new, Dan's 2026-08-01 directive):** the round-closing verification
  agent scores EACH shipped feature 1-10 on (a) quality and (b) functionality, with
  evidence attached (screenshots, test output, the G4 script transcript). Any score
  below 9 reopens the task with the verifier's specific defects list; the implementing
  agent fixes and the verifier re-scores. A round is not reported DONE to Dan until
  every feature in it carries >= 9/9. The rating rubric: functionality = does every
  spec point work including edge cases; quality = does it feel CapCut-grade (no jank,
  no silent failures, discoverable UI, correct undo). Dan's own acceptance supersedes
  any agent score.

## 3. Model capability map (who builds what)

| Model | Assign | Examples in this plan |
|---|---|---|
| **Fable** | planning only, all rounds; the Round 19/20 sub-plan docs | this doc |
| **Opus** | cross-cutting architecture, gnarly state/undo/coordinate code, LLM tool schemas, renderer-touching work | T15.1, T15.2, T16.1, T16.2, T17.1, T17.2 |
| **Sonnet** | well-scoped features with clear specs, UI panels, browser verification + G6 rating | T15.3, T15.4, T15.5, T16.3, T17.3, T17.4, all of Round 18 except docs |
| **Haiku** | docs, copy, config, small isolated UI, flag flips with existing tests | T18.4 export options, doc updates, changelog, memory/PATCHES hygiene |

Parallelism rule: tasks in the same round run in separate worktrees simultaneously
UNLESS they touch the same files (each task lists its files; the round sections flag
known collisions and the required rebase order).

## 4. Round 15 - Timeline trust (CapCut feel)

Goal: Dan drops, drags, trims, extends, and deletes with zero surprises. This is the
round that makes it FEEL like CapCut.

### T15.1 Drop targeting: a video drop lands on V1 unless you clearly meant an overlay
Status: MERGED, VERIFIED (round 15 T15.5, 2026-08-01). See docs/TO-VERIFY.md Import to V1 entry.

Agent: **Opus**. Size: L (1-2 days). Worktree: yes.

Behavior spec (CapCut-derived, adapted to our auto-separation):
1. Empty main track: ANY media drop anywhere in the timeline panel lands on V1 (main)
   at the drop x (head gravity still applies). Includes bin drags, which today have no
   empty-timeline case at all.
2. Occupied timeline: dropping below main (over audio lanes or the empty area under
   them) targets the main track, NOT a new track. Audio lanes are never a valid target
   for video; the dropped clip's audio still auto-separates to the first free audio
   lane exactly as today.
3. Dropping over the ruler/toolbar strip targets the main track at that x (never a new
   top track). Fix by wiring the real header height into the hit-test or excluding the
   header from the drop surface; pick the simpler and test it.
4. Dropping in the overlay area above main keeps today's behavior (new overlay track at
   the drop position = V2+); that part is correct CapCut behavior.
5. Fix causes 4 and 5 outright (hit-test drift incl. expansion rows and top padding;
   the discarded existing-track result fallthrough).
6. If V1 is occupied at the drop point, keep the on-clip ripple-insert/overwrite
   behavior; for a too-short gap, target main with the existing insert flow rather
   than silently spawning a new track.
7. Fold in settled decision 6: single-drop separation joins the insert batch (one undo).

Files: `timeline/components/drop-target.ts`, `timeline/placement/resolve.ts`,
`timeline/placement/insert-index.ts`, `timeline/controllers/drag-drop-controller.ts`,
`timeline/hooks/use-timeline-drag-drop.ts`. All upstream-originated: PATCHES.md rows.

G3: create `drop-target.test.ts` (none exists). Cover: empty-timeline bin drop -> main;
drop below tracks with audio lanes present -> main; ruler drop -> main;
expanded-keyframe-row hit-test; the fallthrough case; V1-occupied cases; overlay area
-> new overlay. Keep `placement/resolve.test.ts` green.

G4: dev server, import one video, drop it 6 ways (center, below tracks, on ruler,
above main, on an existing clip, in a too-small gap), screenshot each, confirm lane
labels. Repeat the first three with a SECOND video while an audio lane exists (the
exact reported bug).

### T15.2 Magnetic main track (the CapCut core behavior), as a visible toggle
Status: MERGED, VERIFIED (round 15 T15.5, 2026-08-01). Ripple-drag live preview items in docs/TO-VERIFY.md are checked.

Agent: **Opus**. Size: L (2-3 days). Worktree: yes; rebases on T15.1 before merge
(both touch placement code).

1. New timeline-toolbar toggle "Main track magnet", **default ON** (Dan, 2026-08-01).
   Persisted per project like snapping.
2. Magnet ON, main track only: deleting a clip closes the gap; trimming a clip's right
   edge ripples downstream main-track clips (and their linked separated audio) to stay
   butted; dragging a main-track clip out re-butts the remainder; dropping between two
   clips ripple-inserts. Overlay and audio lanes never auto-move except linked
   partners.
3. Magnet OFF: exactly today's free placement.
4. Left-handle trims get a ripple path too (today only the right handle has one).
5. The existing global "Ripple editing" toggle remains for cross-track ripple; the
   magnet is main-track-scoped. Document the difference in the toggle tooltips.
6. Migration note: existing projects open with magnet ON; the toggle is one click and
   persisted, and magnet ON never destroys layout by itself (it only affects future
   edits), so no data migration is needed.

Build note: reuse `ripple-trim.ts` and `RippleShiftElementsCommand`; this task is
mostly scoping them to the main track by default and adding the left-handle path.
Respect linked audio via existing linkId propagation.

G3: magnet-on delete closes gap (main only); magnet-on right-trim ripples downstream +
linked audio; magnet-on left-trim; magnet-off regression suite unchanged;
overlay/audio lanes untouched by magnet.

G4: three-clip main track; delete the middle (gap closes); extend clip 1 over a
Director-style cut (downstream slides, audio follows, no desync badge); toggle off and
confirm free placement returns.

### T15.3 Edge-drag polish: show the user why an edge stops
Status: MERGED, VERIFIED (round 15 T15.5, 2026-08-01).

Agent: **Sonnet**. Size: M (0.5-1 day). Worktree: yes (UI-layer files, low collision).

1. When a drag hits the source-media limit, clamp visually and show a subtle edge
   flash or tooltip ("No more footage"), CapCut-style, instead of silently refusing.
2. When the edge is blocked by a neighbor with magnet/ripple off, highlight the wall.
3. Images/text (no sourceDuration) keep free extension; verify and fix the
   duration/trim desync guard for media missing sourceDuration (latent bug flagged in
   research).

G3: unit-test the clamp-reason computation (new pure helper). G4: drag a fresh clip's
right edge (clamps with feedback), a trimmed clip's edge (extends), an image (free).

### T15.4 Track management: add/delete tracks, 8 video + 8 audio caps
Status: MERGED, VERIFIED (round 15 T15.5, 2026-08-01).

Agent: **Sonnet**. Size: M (1 day). Worktree: yes; rebases on T15.1 if placement files
collide.

1. Caps: keep `MAX_VIDEO_TRACKS = 8`; add `MAX_AUDIO_TRACKS = 8` and enforce it
   everywhere audio tracks are created (separation path included: at the cap,
   separation reuses the least-occupied audio lane instead of failing).
2. Add: right-click on the track-label column -> "Add video track" / "Add audio track"
   (insert position follows CapCut: video above the clicked lane, audio below), plus
   the same in the timeline toolbar overflow. Disabled at cap with a tooltip.
3. Delete: right-click a track -> "Delete track"; if it holds clips, a confirm dialog
   ("Delete track and N clips?"); main track (V1) is never deletable; deleting is one
   undoable command.
4. Empty-implicit-track pruning (the existing reactor) must respect user-added tracks
   (`keepWhenEmpty` flag exists; user-added tracks get it).
5. Docs: update BRIEF.md and CLAUDE.md's "4-track hard cap" wording to "main + up to 7
   more video tracks, up to 8 audio tracks, text/graphic/effect lanes as needed";
   PATCHES.md rows in the same commit.

G3: cap enforcement both types; add/delete commands round-trip undo; separation at
audio cap; prune-vs-keepWhenEmpty. G4: add tracks to both caps, delete a loaded track,
undo, confirm V1 undeletable.

### T15.5 Hands-on verification round + G6 rating
Status: MERGED, VERIFIED (2026-08-01). Ran and closed out; see docs/TO-VERIFY.md for the itemized checks.

Agent: **Sonnet** (browser driving), after T15.1-T15.4 merge. Size: M.

Full pass of docs/LIVE-TEST-ISSUES.md items 5/6/10 (linked extend, head snap-back,
sync badge) plus every G4 script above, on a real multi-clip project with separated
audio. Update LIVE-TEST-ISSUES.md and TO-VERIFY.md checkboxes with results in the same
PR. Score every T15.x feature per G6; anything under 9 reopens its task. NOTE: this
does not replace Dan's own SMOKE-20MIN pass (still owed; only he judges feel); it
de-risks it.

## 5. Round 16 - Transcript x Director (red pipe bars + restore)

### T16.1 Transcript lineage: remember the pre-cut transcript across edits
Status: MERGED. G6 RE-RATE 2026-08-01 (T16.4 re-rate, tip `97a61dfa`): **9/10 functionality, 9/10 quality.** Hands-on VERIFIED 2026-08-01 (T16.4): a second manual delete right after a prior delete/restore/undo cycle applies immediately with no "Timeline changed - refresh" block, matching the fast-path spec. A right-edge trim on a fragment (an edit outside the word journal) did not trigger a stale/refresh flag either; recorded as a finding for T16.4, not a code change. The G5 diag-join-verdicts regression check that flagged recall 9/16 / precision 9/10 in the first T16.4 pass was CLOSED by cross-commit forensics during the G6 fix cycle: byte-identical diag output at the pre-round-15 commit vs tip with the `.eval-cache` held fixed proves the reading was an instrumentation artifact, not a real regression from the lineage/journal work. Re-baselined reproducible number: recall 12/16, precision 12/13, 19 fragments (see docs/TO-VERIFY.md). The export-segment fix that depends on this lineage (segments derived from the word journal) was re-verified in the G6 re-rate pass across three scenarios including a segment-boundary-crossing delete not in the original repro; see T16.2.

Agent: **Opus**. Size: L. Worktree: yes.

1. Per-project "transcript lineage" record: the last full transcript (words +
   segments) plus an edit journal of removed source ranges (from RemoveRangesCommand
   and Director applies), so the panel renders surviving AND deleted words without
   re-transcribing.
2. Reuse `virtual-timeline.ts` / `source-map.ts` math; export them properly from the
   director module (currently prompt-internal).
3. Re-transcription still happens on genuinely new audio (new media, edits the journal
   cannot explain); the journal is a fast path, not a replacement.
4. The existing stale/refresh flow keeps working; refresh with an intact lineage does
   a remap instead of a full re-transcribe.

G3: journal round-trip (delete -> remap -> words match); Director apply -> lineage
records accepted spans; invalidation still fires on real audio changes.

### T16.2 Red pipe bars + deleted-words window + per-word restore
Status: MERGED. G6 RE-RATE 2026-08-01 (T16.4 re-rate, tip `97a61dfa`): **9/10 functionality, 9/10 quality.** Hands-on VERIFIED 2026-08-01 (T16.4) for the manual-delete path: red pipe renders between surviving words after a 3+ word delete, the timeline range is removed on all tracks in one undo, clicking the pipe opens the deleted-words window with source "Manual delete" + timecodes + struck-through words, selecting a subset shows "Restore N words", restore reopens the exact gap and shifts downstream + linked audio, the pipe stays with only still-cut words on reopen, an undo reverts a restore, and "Restore all" clears the pipe and merges fragments (also undo-able). Director-sourced pipes (category + reason) were NOT exercised live: the only fixture available in this environment was a clean TTS reading with no fillers/retakes/repeats, so the one Director op the LLM proposed was a trailing dead-air cut at the very end of the clip with no words on either side, which does not produce a pipe by design; needs Dan's real footage (Dan-owed check, does not block this score). Director dock itself was confirmed to stay fully functional (no lock-up, panel still interactive) after a manual transcript delete following an applied Director cut. The SRT/TXT/CSV export bug (silently dropping any segment containing a cut) found in the first T16.4 pass is FIXED and RE-VERIFIED: baseline export correct, a delete inside the first sentence correct (segment shrinks, timecodes shift, SRT still numbered 1-6), a delete crossing a segment boundary correct (both segments shrink independently, neither dropped nor merged), and a full restore-all produces byte-identical exports to the pre-delete baseline (diffed). The full delete-pipe-restore-undo spot-check chain was re-run this pass and traced exactly (113 -> 108 -> 110 -> 113 words through delete / restore-2 / restore-all and back via three undos).

Agent: **Opus**. Size: L-XL. Worktree: yes; depends on T16.1 (same lineage module),
so it branches from T16.1's worktree branch, not from the round base.

1. Wherever a cut removed words between two surviving words, the transcript shows a
   thin RED VERTICAL BAR (pipe) between them. Sources: Director-applied ops (via
   `mergeAcceptedRemovalSpans` + seam flags) and manual transcript deletions (via the
   T16.1 journal). Both look identical.
2. Clicking a pipe opens a window: the deleted words rendered readable
   (strikethrough), the cut's source (Director category + reason string, or "manual")
   and its timecodes.
3. In that window, select any subset of words -> "Restore" re-inserts exactly that
   source range at the seam as ONE undoable command (new RestoreRangeCommand, the
   sub-range inverse of RemoveRangesCommand). Linked separated audio restores
   together. The journal updates; the pipe stays if only part was restored.
4. Hovering a pipe pre-highlights it. Pipes in the scrollbar/minimap region are
   nice-to-have; cut if it drags.
5. Director-dock interaction rule (documented in-code): a restore counts as an
   external edit, so the dock re-syncs from the undo stack exactly as the 2026-07-28
   dock-resync fix already does.

G3: seam computation from applied ops; pipe positions vs assembled words; restore
round-trip (remove -> restore subset -> word timings correct, av-sync intact); dock
re-sync after restore. G4: run AI CUT on the four-fixture project, apply, open
transcript, click pipes, restore a phrase, undo, redo. G5 applies if any Director
prompt/logic changes (version-constant bump rule).

### T16.3 Transcript panel UX finishers
Status: MERGED. G6 RE-RATE 2026-08-01 (T16.4 re-rate, tip `97a61dfa`): **9/10 functionality, 9/10 quality.** Hands-on VERIFIED 2026-08-01 (T16.4) for points 1-3: header shows "Transcribing..." then "Transcript ready - N words", follow-playback toggle defaults ON (visually active), active-word highlight tracked the playhead during playback, click-word-to-seek works, search highlighting works, the restore window/button described in T16.2 renders correctly. Point 4 (Groq path) was RE-VERIFIED FIXED in the G6 re-rate pass: with cloud transcription on and an invalid key stored, a fresh transcription attempt was proven at the network level to call `POST /api/transcribe`, get a 401 with body `{"error":"Groq key rejected - check your key."}`, and fall through automatically to a normal local-Whisper transcript ("Transcript ready - 113 words") with no error screen and no hang; cloud was disabled and the test key cleared afterward. Toggle-state-survives-reload was explicitly re-tested this pass (off, reload, still off, back on) and PASSES. Auto-scroll during playback, hover-suspend, and manual-scroll-suspend-then-resume-after-2s were set up correctly (a genuine overflow condition was reproduced on the 113-word/41s clip) but could not be exercised live: the automated browser tab reported `document.hidden`/no focus for the whole session, which throttles Chrome's requestAnimationFrame-driven playback timer, so Play never advanced past under one frame across multiple fresh loads. This reads as a tab-visibility limitation of the automation environment, not a product defect - the underlying suspend/resume timing logic is unit-tested (`follow-playback-suspend.test.ts`, 5 cases, passing in the G1 gate) and is recorded as a Dan-owed live check rather than counted against this score. Full detail in docs/TO-VERIFY.md round 16 G6 re-rate section.

Agent: **Sonnet**. Size: M. Worktree: yes (panel files only; parallel with T16.1).

1. Auto-scroll follow: active word stays in view during playback (toggle, default on).
2. In-panel restore for plain manual deletions (same window as T16.2 point 3; if
   T16.2 has not merged yet, land the window shell here and T16.2 fills it).
3. "Transcript ready" affordance and progress in the panel header (today a word-level
   pass can block with no ambient signal).
4. Verify-and-fix the Groq path end to end with a real key: generate, click-seek,
   delete a word, export SRT and TXT, confirm timecodes in the files. Rename "Grok"
   -> "Groq" anywhere it appears in UI copy or docs.

### T16.4 Round 16 verification + G6 rating + docs
Status: DONE, RE-RATE COMPLETE (2026-08-01, tip `97a61dfa`). First pass (2026-08-01) found the export bug that kept T16.2/T16.3 below 9; a G6 fix cycle addressed all three flagged defects (export bug, diag gate, Groq silent failure). This re-rate pass re-ran the gates (apps/web 1976 pass, hf-bridge 210 pass, tsc 0 errors, all green) and re-verified each fix live: the export bug is fixed and confirmed across baseline / first-sentence-delete / boundary-crossing-delete / restore-all-byte-identical; the Groq error path is fixed and confirmed at the network level (401 "Groq key rejected - check your key." then automatic local fallback to a normal transcript); the diag-join-verdicts regression reading is closed as an instrumentation artifact per cross-commit forensics (byte-identical diag output pre-round-15 vs tip with the cache held fixed). All three round-16 features (T16.1-T16.3) now score 9/10 on both functionality and quality. Auto-scroll-follow-during-playback could not be exercised live (automated tab lacked focus/visibility, throttling requestAnimationFrame) but its logic is unit-tested and passing; recorded as a Dan-owed check, not a defect. Full detail in docs/TO-VERIFY.md round 16 G6 re-rate section.

Agent: **Sonnet** (browser + rating) and **Haiku** (docs). Size: S-M.
Full transcript workflow on real footage incl. Director apply, pipes, restore,
exports. G6 scores for T16.1-T16.3. Docs: BRIEF feature list, findings-doc addendum
row if Director behavior measurably changed.

## 6. Round 17 - Prompt-to-edit (the timeline prompt window)

Dan's spec: a prompt window where the user types what they want (cuts, changes,
extending something, adding graphics somewhere) and the changes are actively
reflected in the timeline. Groundwork: `/api/assistant` route and the flagged-off
`assistant-prompt.tsx` surface. Architecture principle: the LLM never touches
timeline state directly; it emits typed edit intents that map to the EXISTING command
layer, applied as one undoable batch per prompt, so undo/redo and the Director dock
stay coherent.

May run in parallel with Round 18 (disjoint files) once Round 16 merges.

### T17.1 Timeline context + edit-tool schema
Agent: **Opus**. Size: L. Worktree: yes.

1. A compact serializer: tracks, clips (ids, times, media names, link pairs),
   markers, selected elements, and the transcript window around the playhead, sized
   to fit an LLM context cheaply (target < 8k tokens for a 30-min project; truncate
   by relevance to the prompt: playhead region + named/selected clips first).
2. A typed tool schema the LLM calls: cut_range, delete_clip, extend_clip (with
   source-headroom validation), move_clip, split_at, set_speed, add_text,
   add_motion_template (the 6 existing templates with typed params), add_marker,
   select_clips. Each tool validates against the same clamps the UI uses (source
   limits, track caps, protected spans) and returns a machine-readable refusal
   reason on violation (the LLM sees it and can retry differently).
3. New route `/api/assistant/edit` (or extend the existing assistant route),
   Anthropic provider via the existing ai-generate store config. New prompt version
   constant ASSISTANT_EDIT_PROMPT_VERSION = 1 (process contract: wording changes bump
   it).

G3: serializer snapshot tests (fixture projects); every tool's validator (accept +
refuse cases); schema round-trip (a canned tool-call transcript replays to the
expected command list).

### T17.2 Executor: intents -> commands, actively reflected
Agent: **Opus**. Size: L. Worktree: yes; branches from T17.1's branch (shared schema
module).

1. Map each validated tool call to existing commands; a whole prompt-turn's calls
   become ONE BatchCommand (one undo step), executed only after the full turn
   validates (no half-applied prompts).
2. Active reflection: commands execute against the live editor, so the timeline
   updates the moment the turn applies; the chat shows an "Applied: N changes" chip
   with a one-click Undo (drives the normal undo stack).
3. Failure UX: if any call fails validation, the turn applies nothing and the
   assistant explains what it could not do and why (surfacing the refusal reasons
   from T17.1), plain language.
4. Ambiguity rule (Dan, 2026-08-01): when the prompt is ambiguous ("cut the boring
   part"), the assistant asks a short clarifying question RELEVANT TO THE VIDEO/EDIT
   ("The section from 2:10-2:45 has three long pauses; is that the boring part, or
   did you mean the intro?"), grounded in the serialized context, then applies. For
   multi-op destructive turns it may additionally show the op list for one-click
   confirm. It never guesses destructively. (Lightweight; does NOT reuse the
   Director dock.)
5. Director coexistence: an assistant apply is an external edit to the Director dock
   (re-sync rule, same as T16.2 point 5).

G3: batch atomicity (one failing op -> nothing applied); undo round-trip; the
3-op confirmation threshold; dock re-sync. G4: scripted conversation against a
seeded project: "delete the second clip", "extend the intro clip by 2 seconds",
"add a lower third saying Hello at 0:30", "speed up clip 3 to 2x", verify each lands
in the timeline and one Ctrl+Z reverts each turn.

### T17.3 Chat window UI
Agent: **Sonnet**. Size: M. Worktree: yes; parallel with T17.2 against a mocked
executor interface, integrates when T17.2 merges.

1. A dockable "Assistant" tab in the right dock (Properties | Director | Assistant),
   plus a floating mini-prompt entry point in the preview toolbar replacing the
   flagged-off assistant-prompt surface (retire HIDE_ASSISTANT_PROMPT).
2. Message history per project (persisted), streaming responses, the Applied chip
   with Undo, the confirmation list UI from T17.2 point 4.
3. Keyboard: Ctrl+/ focuses the prompt. Escape returns focus to the timeline.

G4: layout at min panel widths, dark mode, history survives reload.

### T17.4 Graphics-via-prompt polish
Agent: **Sonnet**. Size: S-M. Worktree: yes.

1. Motion-template insertion quality: sensible defaults per template (position
   presets, palette from project background, duration 4s default), so "add a title
   that says X" looks designed, not default-stamped.
2. A "show me" mode: the assistant can place a template at the playhead paused for
   inspection; user says "apply" or tweaks in the Template tab (which already
   exists).

### T17.5 Round 17 verification + G6 rating
Agent: **Sonnet**. Size: M. The T17.2 G4 conversation script expanded to 12+
prompts incl. ambiguous and impossible asks (verify refusal UX), rate all T17.x
features per G6, evidence attached.

## 7. Round 18 - Parity quick wins + VibeCut home

All tasks parallel in worktrees except T18.6. May overlap Round 17.

### T18.1 Freeze frame + Reverse + Crop (Sonnet, M-L)
Status: MERGED. G6 RATED 2026-08-01 (T18.6, tip `70cb9fb5`): **7/10 functionality, 7/10 quality. REOPENED** with two defects. (1) Freeze frame does not shift the linked separated audio: the video track ripples right by 3s but the audio clip stays put, so everything after the still plays 3s out of sync, silently (no desync badge appears either). Verified live and in an exported file. Since every normal project auto-separates audio, this hits the default path. Fix direction: the freeze batch (features/editing/freeze-frame.ts buildFreezeFrameBatch) ripples only the target track via RippleShiftAtCommand; it needs to shift the linked audio (and arguably other downstream tracks) the way magnet ripple already does. (2) Crop ships non-keyframable with an in-UI note "Not keyframable yet" while this spec line says keyframable; implement or have Dan descope it explicitly. Everything else in the set passed hands-on: freeze via toolbar AND context menu splits at the playhead, inserts a real captured 1280x720 still (frame-exact in the export, held for the full 3s), one undo reverts all, off-clip click toasts correctly; reverse toggles per-clip, disables the speed field at 1x, propagates to linked audio, mutes audio through the single gain choke point, splits frame-continuously, and the T18.2 reversed-trim fix was verified live in both directions (left edge eats source TAIL trimEnd 2 to 3, right edge eats source HEAD trimStart 0 to 1); reversed export sampling proven by extracted frames (timeline 14 shows source 19, timeline 16 shows source 17); crop numeric fields commit live with one undo, the Crop button swaps in exactly 4 DOM handle buttons plus a mask overlay, Escape exits, and an old 8-clip project loads uncropped.
- Freeze: toolbar + context-menu "Freeze frame" at playhead: split and insert a still
  (CapCut parity); implement as a captured-frame image element OR a rate-0 segment,
  whichever the renderer supports cleanly; the task brief must record the choice and
  why.
- Reverse: per-clip toggle in Speed tab; renderer plays source backwards; audio mutes
  on reverse (CapCut default).
- Crop: per-clip crop rect in the Transform group with on-canvas handles like the
  existing transform handles; keyframable.

### T18.2 Speed curves (Sonnet, M)
Status: MERGED. G6 RATED 2026-08-01 (T18.6, tip `70cb9fb5`): **9/10 functionality, 9/10 quality.** Hands-on: all 7 preset chips exist and each one set a distinct curve and changed the timeline clip duration correctly on a 38.07s clip (Montage 30.45s, Hero 45.32s, Bullet 15.60s, Jump Cut 14.45s, Flash In 27.69s, Flash Out 27.69s, Custom back to 38.07s with an editable 3-point flat curve). Dragging the middle graph point up committed rate 2.73 at t=0.5 and re-timed the clip 38.07s to 20.43s as one undoable command (the graph tracks live during the drag; duration commits on release, CapCut-like). Toggling Reverse with a curve active cleared the curve exactly as specced. The curve propagates to the linked separated audio element (verified in state), and the roadmap-required renderer-sync test exists and passes (curve-renderer-sync.test.ts: preview and export resolve identical source times at inflections, per-frame, monotonic). Export evidence: the Bullet-curved tail segment shows source frame 26 at timeline 25 (2s in), i.e. the file really plays the curve. Audible pitch behavior is a Dan-owed speaker check, not scoreable here.
CapCut presets: Custom, Montage, Hero, Bullet, Jump Cut, Flash In, Flash Out, plus an
editable curve reusing the existing bezier graph editor. Extends RetimeConfig from
constant rate to piecewise; audio pitch per existing maintainPitch. Touches retime/,
renderer sampling, audio-stretch: the brief must include a renderer-sync test
(exported frames match preview at curve inflections).

### T18.3 Audio fade handles (Sonnet, M)
Status: MERGED. G6 RATED 2026-08-01 (T18.6, tip `70cb9fb5`): **9/10 functionality, 9/10 quality.** Hands-on: dragging the top-left corner handle of the waveform clip inward committed fadeInSec 2.0 (matching the drag distance at the current zoom), the top-right handle set fadeOutSec, the fade curve overlay renders, and each drag is exactly one undo step (undo reverted only the fade-out drag, leaving the fade-in intact; redo restored it). The Audio tab numeric fields mirror the handles both ways (read back 2/2 after the drags; typing commits on blur). Handles cannot cross: entering fade-in 40 on a 38.07s clip clamped to the clip duration and forced fade-out to 0 (edited side wins, resolveFadePair semantics). Trim shorter than the stored fades clamps at read time via clampFadesToDuration (raw params preserved by design, unit-tested). Export evidence: the exported file's first second measures mean -33.0 dB against -20.6 dB steady state, i.e. the 5s fade-in ramp is audibly in the mixdown.
Fade in/out per audio clip (and video-with-audio): corner handles on the waveform
clip UI + numeric fields in the Audio tab; implemented as volume ramps compatible
with existing volume keyframes.

### T18.4 Export options (Haiku, S)
Status: MERGED. G6 RATED 2026-08-01 (T18.6, tip `70cb9fb5`): **9/10 functionality, 9/10 quality.** Hands-on: the export popover shows the resolution picker (Project size 1280x720 / 2160p / 1080p / 720p) with a live "Output: WxH" label, and the quality tier labels scale with the selected resolution (2/6/12/24 Mbps at 720p becomes 18/54/108/216 Mbps at 2160p, tracking the 9x pixel count). "Also export captions (.srt)" appears when a transcript exists AND still appears after deleting words from the transcript (the lineage-aware follow-up). Exporting at 1080p (non-native for the 720p project) with SRT checked produced exactly two files: a 1920x1080@30 h264 MP4 (duration 38.06s, matching the timeline) and an SRT that reflects the cut (the deleted word is absent, its segment shrank instead of dropping, and the second segment's timecode lands where that word's audio actually plays). The full effects gauntlet exported correctly in the same file: the freeze still is pixel-identical for its whole 3s window, the reversed segment plays source frames backward, the curved segment is compressed, and the fade-in ramp is measurable in the audio.
Resolution picker (project size + 1080p/720p/4K scaled), unified bitrate/quality,
"Export SRT alongside" checkbox reusing the existing SRT writers. No new encoder
work.

### T18.5 VibeCut home + wordmark (Sonnet, M)
Status: MERGED. G6 RATED 2026-08-01 (T18.6, tip `70cb9fb5`): **9/10 functionality, 9/10 quality.** Hands-on: /projects renders the VibeCut wordmark (own SVG at /logos/vibecut/wordmark.svg, weight-900 text, theme-aware via invert classes), the four hero tiles with descriptions, and the project grid. Deep links verified live: the AI Cut tile opened the newest project with the Director dock active and the URL param stripped to a clean /editor/id; Edit by transcript landed with the Transcript panel open, also stripped. The favicon set was replaced in the T18.5 commit (b3b1f6eb). The footer component says VibeCut with the current-year copyright. Tiles are enabled with projects present; the disabled-with-hint empty state is covered by hero-tiles.test.ts and deep-link-open.test.ts in the passing suite (an empty profile was not reproducible live without deleting Dan's projects; Dan-owed). Visual dark/light readability could not be screenshotted in this environment (pane not compositing) but both themes are handled in markup.
1. `/projects` becomes the VibeCut home: keep the project grid, add a hero row of
   entry tiles CapCut-style: "New project", "AI Cut" (opens newest project +
   Director), "Edit by transcript" (opens transcript tab), "Auto captions". Simple
   page per Dan: no marketing clutter, grid + tiles + wordmark.
2. Wordmark: an SVG that just says "VibeCut", bold modern geometric sans, designed by
   us (CapCut-inspired spirit, zero imitation of their actual mark). Replace the
   OpenCut logo references (brand.ts DEFAULT_LOGO_URL, header, editor header, OG
   metadata, favicon). MIT attribution stays intact.
3. Marketing `/` updates CTA/copy to VibeCut naming. Package renames stay OUT of
   scope.

### T18.6 Round 18 verification + G6 rating (Sonnet, S)
Browser pass over every 18.x feature; export a real project at a non-native
resolution; G6 scores.
Status: DONE 2026-08-01 (tip `70cb9fb5`). Gates: apps/web 2405 pass 0 fail, hf-bridge 210 pass 0 fail, tsc 0 errors. Full hands-on pass in the dev preview on a 38.07s TTS-over-testsrc clip; export verified by pulling the produced MP4+SRT out of the browser and reading them back with ffprobe, extracted frames, and volumedetect. Result: T18.2 / T18.3 / T18.4 / T18.5 all at 9/9; T18.1 at 7/7 and REOPENED (freeze-frame linked-audio desync, crop not keyframable; exact defect notes on the T18.1 status line). Round 18 is NOT done until T18.1 re-scores at 9/9. Environment notes and the Dan-owed list live in docs/TO-VERIFY.md round 18 section.

## 8. Round 19 - Parity big rocks (each needs its own Fable plan before build)

Held at one-paragraph scope; each opens with its own plan doc because each touches
the renderer pipeline.

- **T19.1 Transitions**: transition concept between adjacent main-track clips (CapCut
  categories: MG, blur, split, slide, mask). Renderer cross-samples two clips; a
  timeline affordance at the join; starter set (cross dissolve, dip to black, slide,
  wipe) before fancy ones.
- **T19.2 Color adjust + filters**: Adjust tab (brightness, contrast, saturation,
  exposure, temperature, tint, highlights/shadows, sharpen) as GPU ops in the effects
  pipeline; filter presets on the same params.
- **T19.3 Chroma key**: keying shader (color pick, intensity, shadow) under a Cutout
  sub-tab. AI background removal stays out unless Dan asks (heavy, Round 20 adjacent).
- **T19.4 Effects registry expansion + Sounds tab unhide + stickers decision**: add
  pixelate, vignette, noise, glow, shake; QA then unhide the built Sounds tab; mount
  the orphaned stickers module as a panel or delete it (decide in the round plan).

## 9. Round 20 - HyperFrames + Remotion authoring (un-parked 2026-08-01)

Dan's directive: make it very easy for someone to start designing their own
preferences for both HyperFrames and Remotion, and always test a short sequence
before a full render. This round opens with its own Fable plan doc
(2026-07-22-hyperframes-remotion-findings.md preconditions reviewed there); the
direction is fixed now so that plan starts from decisions, not debate:

1. **Style preference profiles**: a saved, named design spec (palette, fonts, motion
   style, density) the user builds once and every generation honors, for HyperFrames
   authored compositions AND for Remotion kit exports. UI lives where the flagged-off
   HyperFrames panel already is; the panel gets a redesigned, simpler start flow
   before unhiding.
2. **Probe-render-first, always** (from the dan-video playbook): any render request
   first renders a short probe (a few seconds or 20-frame clips per distinct
   component, contact-sheeted) for approval before the full render is allowed. Full
   renders are segmented with resume guards. Audio is never taken from render
   segments; it muxes from source at the end. These are hard rules in the round plan,
   lifted from the skill's render-reliability section verbatim.
3. **Remotion integration shape** (decided in the round plan, two candidates): (a)
   VibeCut exports an EDL + transcript + media pack directly consumable by the
   dan-video Remotion kits; (b) embedded @remotion/player preview for probe review
   inside VibeCut. Candidate (a) is the cheap first step; (b) only if (a) proves out.
4. HyperFrames stays npm-pinned exact versions, never vendored (BRIEF rule
   unchanged). New code in packages/hf-bridge and features/ai-generate only.

## 10. Round 21 - Productization: onboarding, BYO keys, hosted credits + shop

Dan's directive (2026-08-01): sell VibeCut two ways. (1) A package where the user
connects their own AI keys; today that setup is buried, so onboarding must make it
obvious. (2) A hosted tier: $20/month subscription including at least $10 worth of
compute credits, top-up shop, revenue from the spread between metered credit rates
and raw provider cost.

Sequencing: T21.1 and T21.2 are cheap and ship WITH Round 18 (they share the home
page work). T21.3-T21.6 (accounts, billing, metering) open with their own Fable plan
doc; they are the largest single system in this roadmap and must not block the
editor rounds.

### T21.1 Get-started / onboarding page + first-run wizard
Agent: **Sonnet**. Size: M. Ships with Round 18.

1. A `/get-started` page linked from the home page and shown automatically on first
   run: what VibeCut does, the three AI tools (AI Cut Director, Edit by transcript,
   Prompt-to-edit) each with a 20-second explainer and a "try it" deep link.
2. Setup step "Connect your AI": provider picker (see T21.2), paste-key fields with
   a Test connection button per key (a cheap ping call), green check on success,
   plain-language guidance on where to get each key. Keys stay in local storage,
   never sent to our server (BYO mode); say so on the page.
3. The wizard is skippable and re-openable from Settings and from the home page
   ("Set up AI tools" tile that shows a warning badge until keys test green).
4. Naming hygiene: transcription is Groq (Whisper). If Dan also wants xAI's Grok as
   a chat-LLM option, that is T21.2's provider list; the onboarding copy must not
   confuse the two.

G4: fresh-profile run-through: land, wizard, paste bad key (clear error), paste
good key (green), reach editor, run a transcription. G6 rating applies.

### T21.2 LLM provider abstraction (bring your LLM of choice)
Agent: **Opus**. Size: M-L. Worktree: yes.

1. Today the Director/assistant are wired to Anthropic. Introduce a provider
   adapter layer (anthropic | openai | xai-grok | groq-llm) behind one interface
   for the Director, assistant, and any future LLM call. Anthropic stays the
   default and the quality-reference config; the eval suite (G5) runs against
   Anthropic only, and other providers get a "community quality" label until they
   pass the four-fixture eval.
2. Transcription providers stay as-is (Groq cloud / local Whisper).
3. Settings UI: one "AI providers" section (today's hidden AI settings surfaced),
   per-feature provider choice, key storage local-only in BYO mode.
4. Prompt-version constants remain provider-agnostic; provider-specific prompt
   tweaks are OUT of scope (one prompt, many providers, measured on Anthropic).

### T21.3 Hosted tier: accounts + credit ledger (own plan doc when opened)
Agent: **Opus** (service architecture). The repo has an inherited /api/auth route
(better-auth, currently unused in-app); the round plan decides reuse vs replace.
Core pieces: user accounts; a server-side credit ledger (append-only transactions:
grants, top-ups, holds, spends, refunds); metering middleware on every
compute-spending route (/api/transcribe, /api/director/*, /api/assistant/*), which
in hosted mode uses OUR provider keys and debits credits, and in BYO mode is
bypassed entirely; monthly grant job; hard-stop + top-up prompt at zero balance
with graceful mid-run handling (finish the in-flight op, hold-then-settle).

### T21.4 Billing + shop
Agent: **Sonnet** (UI) + **Opus** (Stripe integration). Stripe subscription
($20/month "Pro") + one-time credit top-up checkout; a /account page: balance,
usage history by feature, invoices, plan management; the shop: top-up packs with
bonus tiers. Regional pricing and annual plans are OUT of scope for v1.

### T21.5 Pricing recommendation (the numbers Dan asked for)

Recommendation, to be calibrated against the existing per-project run ledger (U3)
before launch; all numbers are the launch defaults, tunable server-side:

1. **Credit unit: 1 credit = $0.01 of face value. $20/month includes 1,000 credits
   ($10 face value), refreshed monthly, no rollover** (rollover is the single
   biggest margin leak in credit systems; revisit only if churn data demands it).
2. **Metered rates embed the margin: charge credits at ~2x raw provider cost.**
   Examples at today's raw prices: Groq transcription (whisper-large-v3-turbo,
   ~$0.04/audio-hour raw) meters at ~8 credits/audio-hour; a full Director
   multi-pass run on a 30-minute project (~$1.50-2.00 raw on Sonnet-class models)
   meters at ~300-400 credits; an assistant prompt-turn (~$0.02-0.05 raw) meters
   at ~5-10 credits. So the included 1,000 credits cover roughly 2-3 full Director
   runs plus generous transcription/assistant use, or one heavy editing month.
3. **Unit economics per subscriber**: $20 revenue; worst case (100% credit burn)
   raw compute <= $5.00 (because of the 2x markup), Stripe ~$0.88, hosting/egress
   ~$0.50 -> >= $13.60 gross margin floor. Typical utilization (industry 40-70%)
   pushes it to ~$16-17. This satisfies "they get at least $10 worth" (face value
   at our published metered rates) while structurally guaranteeing profit.
4. **Top-up packs** (one-time, never expire): 500 credits / $5.00; 1,050 / $10
   (5% bonus); 2,750 / $25 (10% bonus); 6,000 / $50 (20% bonus). Even the 20%
   bonus pack keeps >= 40% gross margin at full burn because of the metered
   markup.
5. **Cost-control guardrails** (launch requirements, not options): per-user daily
   spend cap (default 500 credits, raisable in settings), per-op cost preview for
   anything estimated > 100 credits ("This Director run will use ~350 credits.
   Continue?"), model routing that uses Haiku-class models for cheap passes
   exactly as the Director already does, and a kill switch per provider.
6. **Calibrate before launch**: run the four-fixture eval + three real projects
   through the metering in shadow mode, compare metered credits to actual provider
   invoices, adjust the 2x factor per route so no route is accidentally sold below
   cost. The U3 run ledger already records per-run usage; use it.

### T21.6 Licensing + packaging checklist for selling
Agent: **Haiku**. Size: S. The repo forks MIT-licensed opencut-classic: keep the
MIT attribution intact in the product and site (already partially done for masks);
audit all deps for license compatibility with commercial hosting (HyperFrames npm
terms explicitly); add a THIRD-PARTY-LICENSES page; pick the VibeCut terms of
service / privacy baseline (the inherited /privacy and /terms pages are OpenCut's
and must be rewritten before charging money).

### T21.7 Round 21 verification + G6
Agent: **Sonnet**. End-to-end in a fresh browser profile: onboard, BYO key flow;
then hosted flow in Stripe test mode: subscribe, see 1,000 credits, run a metered
Director run, watch the balance drop by the previewed amount, hit the daily cap,
buy a top-up, verify the ledger reconciles to the penny.

## 11. Open items for Dan (not blocking approval)

1. Deferred by Dan (2026-08-01, "we'll do that later"): the SMOKE-20MIN pass and
   the round-14 select-all question. Parked, not forgotten.
2. Round 21 pricing knobs that are Dan's call before T21.3 opens: no-rollover
   monthly credits (recommended) vs rollover cap; whether xAI Grok joins the
   provider list at launch; free-trial shape (recommend: BYO mode IS the free tier,
   no separate trial credits at launch).

## 12. Estimates (wall-clock, parallel worktrees)

- Round 15: ~4-6 agent-days (T15.1 first; T15.2/T15.3/T15.4 parallel after, T15.2
  rebases on T15.1; T15.5 last).
- Round 16: ~4-5 agent-days (T16.1 -> T16.2 serial; T16.3 parallel; T16.4 last).
- Round 17: ~5-7 agent-days (T17.1 -> T17.2 serial; T17.3/T17.4 parallel; T17.5
  last).
- Round 18: ~3-4 agent-days, fully parallel except verification; may overlap 17.
  T21.1 onboarding (+~1 day) ships with it.
- Rounds 19/20: estimated in their own plan docs.
- Round 21: T21.1/T21.2 ~2-3 agent-days; T21.3-T21.7 (accounts/billing/metering)
  ~2-3 weeks, own plan doc, runs after the editor rounds or in parallel on a
  separate track if Dan wants revenue sooner.
- Every round ends with its G6 rating loop; re-scores add ~0.5-1 day when a feature
  misses 9.
