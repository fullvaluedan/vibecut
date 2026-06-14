# VibeCut — Session Handoff

> Read this first in a new session, together with `docs/BRIEF.md` (product brief),
> `PATCHES.md` (every upstream file we've modified), and `docs/QUALITY-PLAYBOOK.md`
> (the hardening patterns + keep-it-alive checklist distilled from rounds 1–24).
> This file is the working memory: goals, state, architecture, mistakes, and the rules
> that keep rounds shipping cleanly.
> Last updated: 2026-06-13, after round 21 (template sizing root cause + Swiss grid rebuild).

## 1. What this is

**VibeCut** (formerly FrameCut) is Dan's AI-native video editor: a fork of the archived
`OpenCut-app/opencut-classic` (Next.js + Bun + WebCodecs/WASM editor) with HyperFrames
AI generation built in. Repo: `https://github.com/fullvaluedan/vibecut`. Local clone:
`C:\Users\danom\Videos\framecut` (folder intentionally not renamed).

**North-star goals (Dan's words):**
- "A simplified version of Premiere Pro with similar toolsets and functionality" —
  when building an editor feature, RESEARCH how Premiere does it first, then match it.
- "Provide assets and get an edited video" — import a bin of footage, press AI Cut,
  get a YouTube-quality edit with motion graphics, export fast.
- Everything AI places must be **editable** like a normal clip (this was re-asserted
  hard in round 17 — see Mistakes).

**Dan's profile:** coding novice, tests every round on real footage, gives blunt
feedback with screenshots. Standing directives: *keep running to fix all issues; test
everything before saying a task is complete; be thorough — verify features actually
work end-to-end, not just that code compiles.*

## 2. Dev setup & workflow (per round)

- Dev server: `bun run dev:web` via launch.json name **framecut-dev**, port 3000.
  Docker containers `framecut-db-1`, `framecut-redis-1`, `framecut-serverless-redis-http-1`
  must be running (web container stays stopped).
- **Build gate:** `bun run build:web` (run from repo root!) must exit 0 before shipping.
  Needs `apps/web/.env.local`.
- Round ritual: `git checkout main && git pull` → `feat/roundN` branch → code →
  build → **live-verify in the preview browser** → add rows to `PATCHES.md` for any
  upstream-origin file touched → commit via `git commit -F tempfile` (PowerShell 5.1:
  write files with `[System.IO.File]::WriteAllText(..., UTF8Encoding($false))`, never
  `Set-Content` for source — BOM breaks things; no `&&` in PS 5.1) → `gh pr create
  --body-file` → `gh pr merge --merge --delete-branch`. PRs #2–#37 so far.
- Commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- The Claude session also keeps a memory file (vibecut.md) — keep both updated.

## 3. What's shipped (compressed)

- **Core AI loop (R1–3):** Settings→AI (Claude subscription via `claude -p`, or API
  key, device-local), `packages/hf-bridge` (5 parametrized HyperFrames templates,
  Claude planner, local transparent-WebM renderer), RUN HYPERFRAMES
  (transcribe→plan→render→place), AI CUT (Remove silences = RMS math; Remove repeats =
  Claude keeps last take; Autocut = assemble+silences) on `RemoveRangesCommand`
  (multi-track ripple cut, single undo), VP9-alpha fix (AI clips render via DOM overlay
  in preview, ffmpeg burn-in at export), convert-for-editing transcode, rebrand.
- **Premiere parity (R4–12):** Effect Controls panel (fx Motion/Opacity/Audio, blue
  scrub values, full keyframe model with stopwatch/◀◆▶), drag-on-number scrubbing,
  pen→freeform MASKS on clips (close on first vertex; feather/invert in Masks tab),
  markers (M), tool rail + V1/A1 track badges, persistent tracks (`keepWhenEmpty`
  defeats the empty-track pruning reactor in `core/index.ts`), track move up/down,
  panel maximize (` on the active panel, glow ring), `\` fit toggle, Up/Down edit-point
  nav, full hotkey set (Q/W ripple trims, Ctrl+K, Shift+Delete ripple delete
  cross-track, D, A=Track Select Forward TOOL, Ctrl+L, Ctrl+R), gap click-to-select +
  ripple delete with Premiere's blocked-by-other-tracks rule, caption styles.
- **AI & UX expansion (R13–15):** Settings→Hotkeys (full remapping UI) + Help tab,
  AI Cut "YouTube edit" mode (assemble + whole-transcript pacing/hook brief),
  export-diff self-learning (kept/restored/trimmed after AI Cut → planner notes),
  HeyGen Music & SFX search in Sounds panel (key in Settings→AI→Integrations),
  AI prompt box under the preview (strict command rails: ai_cut, hyperframes,
  find_broll via SerpAPI, find_audio, add_text, captions; off-topic → reject),
  background transcription cache (hash of timeline audio → localStorage; AI CUT and
  RUN HYPERFRAMES start instantly on warm cache), playback speed slider 0.5x–3x
  (clock + audio engine scaled), AI Cut no-double-assemble fix, stage-aware error
  toasts, export save-dialog (remembers folder), self-learning v1
  (template deletions + undone cut runs + export diff → prompt notes; Settings→AI).
- **Native motion templates (R16–18):** `features/motion-templates/` — 14 native
  templates (callout-pill, kinetic-title, lower-third, number-pop, section-break,
  title-subtitle, quote-card, social-handle, stat-bar, bullet-list, location-tag,
  banner, end-card + Swiss-grid layout apply) built as text elements with PRE-BAKED
  keyframes through the real pipeline (`resolveAnimationTarget`+`upsertPathKeyframe`).
  **Template Controls tab** (default tab for template elements): edit fields + duration,
  rebuilds params+animations via `template.build()` in one undo; detach button.
  Engine toggle on RUN HYPERFRAMES: **Instant (native, default)** places templates
  with zero Chrome renders; **Cinematic** keeps the HyperFrames CLI render path.
  MOGRT feel: all elements of a template share `linkId` → linked selection moves/
  trims/deletes the group as one (Alt-click = single piece). Canvas-proportional
  sizing (×height/1080). Uniform Scale defaults ON. Pin-to-end: resizing a template
  re-times exits to the new end (`animation/template-retime.ts` + update-pipeline rule,
  skipped when a patch already carries `animations`).
- **Linked A/V (R17):** `linkId` stamped on video + separated audio; linked selection
  (default ON, chain toggle in toolbar, Alt = solo); A/V sync frame badge (`⚠ Nf`) on
  drifted clips + Audio-tab readout with one-click **Realign**.
- **Export speed:** pure-edit and native-template projects never touch ffmpeg
  (WebCodecs only = CapCut-class). Cinematic burn-ins auto-use hardware H.264
  (nvenc→qsv→amf probe with libx264 fallback) in `/api/media/composite`.
- **Bake library (R19):** registry **blocks** (maps, charts, social cards, YT
  lower-third, logo-outro — the rich assets native templates can't reproduce)
  are now renderable & droppable. A block is a complete standalone HyperFrames
  composition; `packages/hf-bridge/bake.ts` fetches its registry-item +
  composition HTML + assets, renders ONCE through the pinned CLI to a transparent
  WebM, and caches it under `~/.framecut/baked/<name>-<WxH>-<fps>-<hash>/`
  (content-hash key → registry updates auto-re-bake). `/api/hyperframes/bake`
  serves it (`x-framecut-cached` header). The HyperFrames panel "Blocks" cards
  gained an **Add** button → bakes (once, ~render-time; then instant) and drops
  the clip on an AI overlay lane at the playhead, stamped
  `framecutAi.registryBlock` so it rides the existing alpha-preview + export-burn
  path and gets a re-bake properties tab (`RegistryBlockTab`) instead of an
  inapplicable template swap. Blocks render at NATIVE dims (placed scalable);
  components/styles are not baked yet (see Queued). Lane placement was extracted
  to `features/ai-generate/placement.ts` (shared by RUN HYPERFRAMES + bake drop).
- **Template fixes (R20 phase 1):** from Dan's real-footage testing. (1) **Group-aware
  properties panel** — `properties/index.tsx` now detects when a multi-selection is
  ONE motion-template group (all text pieces sharing a registered template's
  `motionTemplate.groupId`) and opens its Template Controls instead of the "N
  selected" placeholder (`singleTemplateGroupRepresentative`); this was why templates
  felt un-editable (linked-selection grabs all pieces → multi-select → placeholder).
  (2) **Scale control** — Template Controls gains a Size field; a `scale` (default 1)
  threads through `MotionTemplateArgs`→`canvasScale`=(h/1080)×scale so the whole
  template resizes uniformly; persisted on `motionTemplate.scale`. (3) **Proportional
  animation timing** — `keyframes.ts resolveEnterExit` = clamp(dur×0.18, 0.45, 0.9)
  replaces the fixed 0.4s enter/exit (popIn overshoot times scale with it; section-break
  + stat-bar inline channels refactored). (4) **Canvas-fit for baked blocks** —
  `bake-block.ts` reads the `x-framecut-dims` header and places blocks with a
  contain-fit transform (min(canvasW/blockW, canvasH/blockH), centered) so they never
  overflow. (5) **Per-item groupId** in RUN HYPERFRAMES native branch (was one run-wide
  id → group-aware panel would've treated a whole run as one template).
- **Template sizing ROOT CAUSE + Swiss grid (R21):** the recurring oversizing was a
  fontSize UNIT bug (see §4: fontSize is /90-relative, ~15 normal; templates authored
  it as px ×height/1080 → ~5× too big, quadratic on big canvases — and we'd only ever
  checked fontSize VALUES, never rendered px). Fixed: new `fontScale(scale)` for fontSize
  (no height term), `canvasScale` kept for positions; re-authored all 14 templates'
  fontSize to the relative unit (kinetic 110→25, etc.). The R20 Scale control now works
  on a correct base. **Swiss grid rebuilt** (Dan chose "rebuild properly"): the V1 video
  reframe is now KEYFRAMED to revert to full-frame at the segment end (was a permanent
  base-param mutation → stayed shrunk forever); `swiss-grid-keypoint` registered as a
  real `internal`+`multiPoint` `MotionTemplate` (keypoints editable in Template Controls,
  built with `linkPieces:false` → shared groupId but no linkId → each times independently).
  Verified by MEASURING rendered px: kinetic-title 27.8% of height (was 122%), keypoints
  7.8% (was ~44%), reframe full-frame again at 12s.

## 4. Architecture map (where things live)

- `apps/web/src/core/` — EditorCore singleton + managers (playback [has playbackRate],
  audio-manager [sessionRate], renderer). **Reactor in core/index.ts prunes empty
  tracks** unless `keepWhenEmpty`.
- Commands: `apps/web/src/commands/**` — everything undoable goes through
  `editor.command.execute({command})`; `BatchCommand` = one undo step.
  Key: `RemoveRangesCommand`, `InsertElementCommand` (placement auto/explicit),
  `UpdateElementsCommand` (patch incl. params/animations/startTime), `AddTrackCommand`.
- Elements: `timeline/types.ts`. Custom fields we added: `framecutAi` (cinematic AI
  clips), `motionTemplate {templateId, groupId, variables}`, `linkId`. No zod gate on
  persistence — optional fields just work.
- Animation: `animation/*` — `ElementAnimations` channels per path;
  `upsertPathKeyframe` + `resolveAnimationTarget` (timeline/animation-targets.ts) are
  the canonical write path. **fontSize animation does NOT render** (text measurement
  reads base params) — animate transform.scale instead.
- **Text fontSize is a /90-RELATIVE unit, NOT pixels** (`text/primitives.ts`: rendered
  px = `fontSize × canvasHeight/90`; `FONT_SIZE_SCALE_REFERENCE=90` in
  `text/typography.ts`; default text = 15 → 180px on 1080; rendered fraction of canvas
  height = `fontSize/90`). So native templates author fontSize via `fontScale(scale)`
  (the user scale ONLY — the /90 already makes text canvas-proportional); POSITIONS use
  `canvasScale` (×height/1080 × scale). Authoring fontSize as raw px AND ×height/1080
  = ~5× oversize + QUADRATIC on big canvases — this was the recurring R16–R20 oversizing
  bug, root-caused and fixed in R21. **When changing template sizes, VERIFY by measuring
  rendered px / canvas-height fraction (measureTextElement / `__vibeEditor`), never by
  reading fontSize values** — checking values (which looked plausible) is exactly how the
  bug survived three rounds.
- Update pipeline: `timeline/update-pipeline.ts` — rules on element patches (retime
  derive, template re-time, keyframe clamp, startTime clamp).
- AI: `features/ai-generate/` (run-hyperframes orchestrator, store with keys/engine/
  direction/tokens, preference-store self-learning, hyperframes-panel with Showcase
  presets + engine toggle), `features/editing/` (silences/repeats/cleanup/youtube/
  autocut/assemble), `features/assistant/` (prompt box), `features/transcription/`
  (transcript cache + background transcriber), `features/motion-templates/`.
  Server: `app/api/hyperframes/{plan,cuts,render,registry}`, `app/api/assistant`,
  `app/api/media/{composite,transcode}`, `app/api/heygen/*`, `app/api/broll/*`.
- hf-bridge (`packages/hf-bridge/`): templates catalog, Claude calls
  (`planEffects`, `planRepeatCuts` modes repeats/cleanup/youtube, generic `planJson`),
  renderer (spawns hyperframes CLI with real node — dev server runs under Bun),
  Studio (`startStudio` port 3217).
- Selection: `editor.selection.setSelectedElements({elements: ElementRef[]})`;
  linked-selection expansion hooks the user-interaction commits only.

## 5. Mistakes & lessons (do not repeat)

1. **Shipping without proving the user-facing flow.** Round 16 shipped templates whose
   editing path didn't actually work (no Template Controls; baked keyframes silently
   overrode panel edits). Dan: *"This is not true at all, it doesn't work. You need to
   test your changes."* → Every feature now gets a per-item verification matrix:
   insert → edit each field → move/trim → undo → re-edit, observed via DOM/eval, not
   assumed. "It compiled and the toast fired" is not verification.
2. **Assemble doubled footage already on the timeline** (round 15): Dan's video sat on
   V2; AI Cut appended a second copy at 0:00 → broken 9-minute run. Lesson: think about
   the user's real timeline shapes (footage on overlay tracks, multiple scenes), not
   the happy path.
3. **Silent fallbacks hide bugs**: pen quietly created a shape when the mask path
   failed; claude-code mode returned nested JSON the client silently ignored. Both now
   error loudly/normalize. Always surface the failure stage (AI CUT toasts include
   "While '<stage>': ...").
4. **requestPointerLock leaves the cursor invisible** after exit in Chromium → use
   setPointerCapture + body cursor for scrubs.
5. **Premiere research first.** Several features needed rework because the first build
   guessed semantics (pen close behavior, A-key as tool vs action, gap delete blocking
   rule). WebSearch the Premiere behavior, cite it, then build.
6. **Keyframes override base params by design** — any "edit a templated thing" surface
   must regenerate params AND animations together (Template Controls does).
7. **PowerShell 5.1 traps:** BOM from Set-Content corrupts JSON/source; `&&` invalid;
   batch regex replaces on source files are BANNED (caused an a→p disaster pre-R4).
8. **Don't edit watched source files while Dan has a RUN in flight** — HMR full-reload
   kills his run.
9. **Self-learning data hygiene:** clear synthetic test signals (undo-spam runs) from
   the preference store after testing.

## 6. Preview-browser verification playbook

- Start via `preview_start` name `framecut-dev`; **resize to 1600×900 immediately**;
  the browser profile is EPHEMERAL — restarts wipe OPFS media, IndexedDB projects and
  the Whisper model cache. Recreate test media: SAPI TTS → wav (PromptBuilder with
  AppendBreak pauses + a repeated sentence), `ffmpeg testsrc2` mux to mp4, drop in
  `apps/web/public/`, import via fetch→File→`input.files`+change event. **Delete from
  public/ before committing.**
- Long sessions degrade: viewport shrinks to a tiny render, screenshots time out while
  the renderer is busy — eval-based DOM checks keep working; restart server when it
  gets bad. Keep evals <30s (cap); split long sequences.
- Synthetic input gotchas: Radix menus/tabs ignore `.click()` → `focus()` + keydown
  Enter (submenus: ArrowRight). React `onMouseEnter` needs `mouseover`. Hotkeys:
  dispatch keydown on document with `code` set (`KeyD` etc.). Set input values via the
  native value setter + `input` event.
- Useful observables: selection count = `[aria-label="Left resize handle"]` (only on
  selected clips); timeline duration regex `/\/[\s\S]{0,4}(00:\d\d:\d\d:\d\d)/`;
  clip names gain "(left)/(right)" after splits; the Shapes panel has a "Rectangle"
  button — filter timeline clips by `closest('div.relative.h-full.min-w-full')`.
  `window.__vibeEditor` exposes EditorCore in dev (added R17) — use it for state
  assertions instead of DOM scraping where possible.
- Toasts expire — capture them promptly or check network/console instead.
- The full RUN HYPERFRAMES/AI CUT pipelines work headless with claude-code auth;
  watch `/api/hyperframes/plan` vs `/render` in `preview_network` to confirm engine.

## 7. Queued / next steps (in rough priority)

0. **Template work — what's left after R21.** R20 P1 (group-aware panel, per-item
   groupId, canvas-fit blocks, proportional timing) + R21 (sizing root cause + Swiss
   grid rebuild: reverting reframe, registered editable keypoints, independent timing)
   are shipped. Remaining:
   - **Manual insertion at quality.** Extract `insertTemplate` (in
     `motion-templates-section.tsx`) into `features/motion-templates/insert-template.ts`;
     add "Add" buttons to the HyperFrames panel Templates section + an all-14 "Motion
     templates" gallery section (panel already has AddButton/Section infra from R19).
     Native, instant, auto-selects → opens Template Controls. Answers "no way to bring
     in HyperFrames templates manually." (`swiss-grid-keypoint` is `internal:true` —
     exclude internal templates from the gallery.)
   - **RUN HYPERFRAMES auto-times the Swiss key points** from the planner's
     `key-points` moments (each keypoint placed at its spoken time; they're already
     independently-timed unlinked elements). Drag-a-template-to-a-track.
   - **Background-color field + fade-timing slider** in Template Controls (deferred).
   - Plan: `C:\Users\danom\.claude\plans\there-are-quite-a-wise-teapot.md`.
1. **Bake library — beyond blocks.** R19 shipped the bake path for registry
   **blocks** (gallery-drop, cached). Still to do for "pre-bake EVERY element":
   (a) **components** (snippets like grain-overlay, caption styles — need a host
   comp to render meaningfully; bake them over a placeholder or wire as effects);
   (b) **examples/styles** (multi-file looks — bigger lift); (c) **AI-run
   integration** — let the RUN HYPERFRAMES planner pick baked blocks, not just
   templates (auto-bake on selection); (d) **canvas-fit** — blocks bake at native
   dims today (a portrait block on a landscape canvas is sized native + scalable);
   per-canvas re-bake or auto-fit transform would polish placement; (e) **param
   support** — some blocks expose CSS-var params (e.g. data-chart `--bg-color`);
   fold a param-set into the cache key for "× style accent" variants.
2. **Single-clip compound container** (true MOGRT): one timeline chip rendering a
   whole template group. Engine-level; linked-group behavior is the stopgap.
3. **Embedded Studio preview** for cinematic effects (iframe of `startStudio` 3217)
   instead of render-to-see.
4. **AI-filled Swiss-grid keypoints** from the transcript (Showcase preset).
5. "EDIT FOR ME" one-button pipeline (assemble → YouTube cut → HyperFrames → export
   with one progress bar) — natural showcase of the whole product.
6. Smaller queued: workspaces/saved layouts (#49), ValueField styling port (#42),
   mask expansion param, per-track lock/solo enforcement, text vertical alignment,
   stereo pan, stock-video b-roll provider (SerpAPI images are stills only),
   true JKL shuttle rates, fontSize-animation engine fix.

## 8. Current state of the test environment

Preview project (ephemeral) has scratch content from round-19 testing (a baked
yt-lower-third + instagram-follow block on an AI overlay lane). Two blocks are
cached under `~/.framecut/baked/` — safe to keep (the cache is the point). Dan's
real projects live in his own Chrome profile — untouched by preview-browser resets.
Self-learning store was cleared after synthetic tests in R12; R18/R19 testing added
no learning data (no undo-attributed runs; bake drops aren't template placements).

## 9. Round 25 (2026-06-14) — HyperFrames skill-as-producer + editor reliability

**The big shift: "the HyperFrames panel is a PROMPT GENERATOR."** Panel selections +
picked registry assets (new ★ allow-list) + the clip/whole-video transcript + the
active look + the direction box compile into a brief; Claude AUTHORS a custom
HyperFrames composition (HTML, via `claude -p` text output — it never writes files,
the product does), which is rendered to a transparent overlay and placed on a NEW
track (non-destructive). Verified end-to-end live (the "Aurora" and "Q4 RESULTS"
overlays). Both entry points now use this author path:
- **Right-click a clip → "Run through HyperFrames"** (`run-hyperframes-scoped.ts`
  `runHyperframesOnClip`) → graphic over that segment.
- **RUN HYPERFRAMES + the new "Authored" engine** (`runHyperframesWholeTimeline`) →
  one composition for the whole video on a new track at t=0.

New files: `packages/hf-bridge/src/author-composition.ts` (`authorComposition` —
claude-code spawn OR api-key, strip-to-HTML, write comp dir, render), API route
`app/api/hyperframes/author/route.ts`, `features/ai-generate/{compile-hyperframes-prompt,
place-hyperframes-render,run-hyperframes-scoped,run-log-store}.ts` + `run-log-panel.tsx`,
`assets/media-preview-dialog.tsx`.

Also shipped this round (all tsc-clean, most live-verified): editor-correctness fixes
from a 26-agent audit — ripple-delete track-scoping (Shift+Del on an overlay no longer
rips the footage under it), drag→V1 (was V2), Transform Effect-Controls always shown for
paired/multi selection, V=Selection tool, honest RUN HYPERFRAMES placement count; export
rotation/flip for alpha overlays (preview==export, verified via ffmpeg); transcription
inFlight progress broadcast (fixed frozen "Reading audio 5%"); a live "Log" terminal next
to RUN; Stop/cancel; transcript-on-demand (audio-guarded); launch-video showcase presets;
double-click asset → preview modal. Plus a HyperFrames RELIABILITY sweep (45-agent
adversarial audit, 22 confirmed) — fixed 7: missing-claude-CLI → actionable error,
right-click re-entrancy guard, authored-engine token counter, no-speech transcript cache
hit (was re-running Whisper), transcription 'error' status wired, plan-response JSON guard,
encoder-cache demotion.

**IMMEDIATE NEXT STEPS (in order):**
1. **Server-side CANCEL** (HIGH — Cancel is currently cosmetic): thread `req.signal`
   through `app/api/hyperframes/author/route.ts` → `authorComposition` → kill the
   `claude -p` child on abort (spawn uses shell:true → kill the process group), and
   forward the signal into `ensureTimelineTranscript`; add a post-fetch abort re-check
   in `run-hyperframes-scoped.ts` before placement.
2. **Self-learning** (HIGH): currently a rule-based loop in `features/ai-generate/preference-store.ts`
   (templates placed/deleted + AI-Cut runs/undone + export diff → notes injected into
   the planner/cut prompts). Extend it to learn b-roll/music/graphics taste and to feed
   the AUTHOR brief (not just the template planner).
3. LLM-connection settings (let users connect Claude / Hermes / an API key) — HIGH.
4. Low/later: automatic transcript-driven b-roll (SerpAPI images + HyperFrames graphics +
   auto-using fitting standalone footage from the bin); punch-in/auto-zoom centered on
   the speaker's eyes; the remaining reliability fixes (placement undo atomicity = 3 history
   entries → BatchCommand; concurrent-author back-pressure; orphaned comp-dir cleanup);
   the structural overlay-into-compositor fix (collapses z-order/snapshot/animated-export).

Per-increment detail + gotchas are in the `vibecut.md` auto-memory (read at session start).
