# VibeCut Roadmap: Premiere Power, CapCut Simplicity

**Date:** 2026-07-06 · **Author:** Claude (Fable 5) + 3 parallel audit agents · **Status:** PROPOSED, awaiting Dan's cut-down
**Inputs:** full-codebase audits (UX surface, architecture/reliability, feature parity), BRIEF.md, HANDOFF.md, TO-VERIFY.md (299 lines), QUALITY-PLAYBOOK.md

---

## 0. The one-paragraph diagnosis

VibeCut has a world-class engine and a scattered cockpit. The AI cutting brain (Director, take clustering, dead-air, filler, redundancy) is genuinely ahead of CapCut and rivals anything Premiere ships. But that engine is reached through 6+ unrelated doors, 23 toolbar controls with no hierarchy, three different result-review paradigms, and a reliability layer that has zero error boundaries and a 299-line backlog of features nobody has verified on real footage. The path to "Premiere power, CapCut simplicity" is not more features. It is: make the product stop breaking quietly (Phase 0), give it ONE front door (Phase 1), add the CapCut ease layer (Phase 2), close the visible Premiere gaps (Phase 3), then scale and showcase (Phases 4-5).

---

## 1. Blindspots (ranked by how much they hurt)

### B1. Verification debt is the product's biggest risk (CRITICAL)
- `docs/TO-VERIFY.md` is 299 lines of shipped-but-untested features. Dan is the only QA, and testing is the standing bottleneck (HANDOFF Mistakes #1 exists because of this exact failure mode).
- 979 source files vs 132 test files, and the tested areas are the wrong ones for user trust: Director logic is heavily tested, while **playback, export, error recovery, and concurrency have zero tests**.
- Consequence: every session adds to the untested pile faster than it drains. Quality perception will rot even if the code is right.

### B2. Zero crash safety (CRITICAL)
- No React ErrorBoundary anywhere in the tree. One render error = white screen.
- IndexedDB migrations are not atomic (`services/storage/migrations/`); a crash mid-migration can leave a project unloadable, and there is no backup/restore or "revert to last good".
- Projects load from IndexedDB with no runtime validation (no zod gate); corrupt data is discovered at render time as a hard crash.
- Export failures mid-render are silent. Transcription worker failures are swallowed.

### B3. Long-video export still OOMs (CRITICAL, known and latent)
- The AI-CUT analysis path was fixed to 16 kHz mono, but **export still allocates the full 44.1 kHz stereo buffer** (`media/audio.ts` → `scene-exporter.ts`). A 21+ minute export throws `createBuffer` OOM. For a talking-head/tutorial product, long video IS the use case.

### B4. Six-plus AI doors, no hub (HIGH, the core UX problem)
- Entry points today: RUN HYPERFRAMES (+ engine dropdown + Versions ×3 + Versions-ready), AI CUT menu (4 modes), REMOTION, HF GRAPHICS, the assistant prompt box under the preview, right-click "Run through HyperFrames", the HyperFrames panel + drafts panel, bake-library Add buttons, motion-template gallery.
- Users cannot form a mental model. CapCut groups by *task* ("Captions", "Effects"); Premiere groups by *workflow*. We group by *implementation history*.

### B5. Inconsistent result-review paradigms (HIGH)
- Variants → modal picker. Director → modal review. Auto-assemble → hijacks the Properties panel. Graphics → inline proof-gate panel. Same conceptual action ("AI proposes, I review, I apply") is presented four different ways, and the Properties panel silently changes content based on app state (`panels/properties/index.tsx:79-98`).

### B6. Naming chaos (HIGH, cheap to fix)
- "RUN HYPERFRAMES" vs "HF GRAPHICS" vs "REMOTION" vs "AI CUT" vs "Director" vs "Versions ×3". These are implementation names, not user-intent names. Onboarding still shows a different product name than parts of the code.

### B7. Discoverability: 35 shortcuts, no command palette (MEDIUM)
- The action registry exists (`actions/definitions.ts`, 35 actions) but there is no Ctrl+K palette and the shortcuts dialog is buried. Non-standard keys (S for blade instead of X) will fight Premiere muscle memory.

### B8. Media organization does not scale (MEDIUM)
- Flat asset list: no bins, no search, no tags, no relink-missing-media, no proxies. Fine at 5 clips, unusable at 50.

### B9. Visual polish gaps vs both competitors (MEDIUM)
- No transitions library. Effects library is essentially just blur. No color correction/LUTs. Export has quality presets but no resolution/aspect/social presets. These are the D-grade rows in the parity matrix.

### B10. Resource-lifecycle debt in the AI infra (MEDIUM)
- Render queue has no timeout/heartbeat, a hung render blocks forever. Graphics jobs (the new detached worker) have no TTL or orphan cleanup, `D:\Claude\_temp` will grow unbounded. Undo history holds up to 200 full-track snapshots in RAM. Transcription can re-run redundantly during fast edits.

### B11. Setup burden blocks any future user who is not Dan (LOW now, fatal later)
- Working install requires: Docker (db/redis), Bun + Node, ffmpeg, pinned hyperframes CLI, claude CLI auth, optional Groq/HeyGen/SerpAPI keys, a Remotion project at a hard-coded path. BRIEF's ADR-5 (hosted backend) is the eventual answer; a `doctor` command is the near-term one.

### Corrections to the audit agents (for the record)
- Director Vision v0 DOES exist (opt-in frame sampling, 2026-06-18); the parity agent missed it.
- HF GRAPHICS renders via the hyperframes CLI, not HeyGen.

---

## 2. The interface vision: one editor, two altitudes

The organizing idea for "Premiere power with CapCut simplicity" is **progressive disclosure, not two products**:

1. **One layout, CapCut-shaped by default.** Media/left, preview/center, inspector/right, timeline/bottom (already true). Default workspace hides pro-only chrome (graph editor, ripple toggles, track badges) behind a single **Simple / Pro workspace toggle** persisted per user. Pro reveals everything Premiere users expect.
2. **One front door for AI: the Create menu.** A single primary button ("✨ Create") replaces RUN HYPERFRAMES / REMOTION / HF GRAPHICS / AI CUT as top-level toolbar items. Inside, task-named actions:
   - **Cut my video** (Director; silence/filler/repeats live here as options, not siblings)
   - **Assemble from my clips** (auto-assemble)
   - **Cut to length** (highlight)
   - **Add graphics** (engine = a dropdown INSIDE the flow: Native templates / HyperFrames / Remotion, replacing three toolbar buttons)
   - **Add captions**
   - The assistant prompt box moves here too, as the search field at the top of the menu.
3. **One review paradigm: the Review panel.** Every AI action resolves to the same docked right-panel review (rows, accept/reject, one undo step), which the Director review already models well. Kill the Properties-panel hijack and the one-off modals. "AI proposes → I review in the same place every time → apply is one undo."
4. **One progress paradigm: the Jobs tray.** The graphics job panel (heartbeat dot + phases + proof gate) becomes the global pattern: a Jobs button in the header with a dropdown listing every long-running task (transcription, HF render, graphics, export) with progress, heartbeat, cancel. Toasts only announce start/finish; they are not the progress UI.
5. **Ctrl+K command palette** over the existing 35-action registry, so Pro power is searchable instead of memorized, and every Create-menu action is also reachable by typing.
6. **Verification is a feature.** Nothing ships to `main` without either an automated E2E check or a ticked TO-VERIFY box. The pile must shrink monotonically.

---

## 3. Roadmap

Effort unit = one focused session/round (~half a day of agent work + Dan's verify pass). Phases are ordered by dependency; within a phase, items are ranked.

### Phase 0 — Stop the bleeding (reliability + verification) · ~6-8 sessions
*Goal: the app stops losing work, and shipped features stop piling up unverified.*

| # | Item | What / where | Effort |
|---|------|--------------|--------|
| 0.1 | Global ErrorBoundary + persistent error surface | New `components/error-boundary.tsx`, wrap editor page; export/transcription catches emit persistent (not fleeting) toasts with a copy-details button | 0.5 |
| 0.2 | Atomic migrations + pre-migration backup | Rewrite `services/storage/migrations/runner` to single-transaction batches; snapshot the project record before migrating; add "restore backup" path | 1 |
| 0.3 | Validate projects on load | Lightweight zod schemas for `TProject`/`TimelineElement`; strip/repair invalid fields with a warning toast instead of crashing at render | 1 |
| 0.4 | Fix long-video EXPORT audio OOM | Chunked/streaming audio mix on the export path (analysis path already fixed); gate: export a 25-min project | 1-2 |
| 0.5 | Resource lifecycle sweep | Render-queue timeout + heartbeat (hf-bridge renderer); graphics-job TTL + orphan cleanup on start; transcription debounce + in-flight guard | 1 |
| 0.6 | **E2E verification harness (the compounding fix)** | Playwright suite driving the real editor with synthetic media (the SAPI+testsrc recipe from HANDOFF §6, scripted): import → cut → undo → export smoke; runs in CI on PR. Then burn down TO-VERIFY.md by converting each top item into either an E2E test or a 10-min Dan checklist session | 2-3 to seed |

**Exit gate:** a corrupted project loads with a warning instead of white-screening; a 25-min export completes; CI runs the E2E smoke on every PR; TO-VERIFY.md is net-shrinking.

### Phase 1 — One front door (UX consolidation) · ~6-8 sessions
*Goal: a stranger can find every AI feature in 10 seconds and always knows where results appear.*

| # | Item | What / where | Effort |
|---|------|--------------|--------|
| 1.1 | Naming pass | One product name everywhere; task-named labels ("Add graphics", "Cut my video"); kill "×3"/"(ready)" suffixes from buttons (status moves to the Jobs tray) | 0.5 |
| 1.2 | The Create menu | Single primary toolbar button consolidating RUN HYPERFRAMES + AI CUT + REMOTION + HF GRAPHICS + assistant prompt; engines become dropdowns inside flows (`timeline-toolbar.tsx` right section shrinks from ~14 controls to ~7) | 1-2 |
| 1.3 | Unified Review panel | Extract the Director review into a shared docked review surface; migrate variants picker, auto-assemble, highlight, and the graphics proof gate onto it; Properties panel never gets hijacked again (`panels/properties/index.tsx:79-98` conditions removed) | 2 |
| 1.4 | Jobs tray | Generalize `features/graphics/graphics-job-store` + panel into a global job registry (transcription, HF renders, graphics, export) with heartbeat, progress, cancel; header button + dropdown | 1-2 |
| 1.5 | Ctrl+K command palette | cmdk over `actions/definitions.ts`; include Create-menu actions; "recently used" on top | 1 |
| 1.6 | Toolbar diet | Editing toggles (snap/ripple/linked/waveforms) collapse into one settings popover; remove the disabled Freeze Frame button; zoom stays | 0.5 |

**Exit gate:** toolbar has ≤8 top-level controls; every AI flow starts from Create and ends in the Review panel; every long task is visible in the Jobs tray.

### Phase 2 — The CapCut layer (simplicity) · ~6-8 sessions
*Goal: a first-time creator gets from import to exported social video without reading anything.*

| # | Item | What / where | Effort |
|---|------|--------------|--------|
| 2.1 | Simple/Pro workspace toggle | Persisted flag; Simple hides graph editor, ripple/track chrome, pro tabs; Pro = today's surface. Default: Simple | 1 |
| 2.2 | Real onboarding | Replace the 3-step modal with: sample project (bundled tiny footage) + 5-step guided first edit (import → AI cut → caption → graphic → export) + shortcut hints | 1-2 |
| 2.3 | Social export presets | YouTube 16:9 / Shorts-TikTok 9:16 / Square 1:1 presets in the export dialog: resolution + aspect + sensible bitrate; auto-reframe canvas option | 1 |
| 2.4 | Asset bins + search | Folder tree + search/filter in the assets panel; tags optional later (`panels/assets/`, `commands/media/`) | 1-2 |
| 2.5 | One-click captions flow | "Add captions" in Create runs transcribe → style picker → apply-to-timeline as one gated flow (pieces all exist, the flow does not) | 1 |
| 2.6 | Track lock + solo | `locked`/`solo` on BaseTrack, enforcement in drag/trim controllers, header buttons. Cheap Premiere-parity win | 0.5 |

**Exit gate:** a screen-recorded new-user run: import → finished 9:16 export in under 10 minutes with zero docs.

### Phase 3 — The Premiere layer (power gaps) · ~8-10 sessions
*Goal: the D/C rows of the parity matrix reach B+; Premiere refugees stop missing things hourly.*

| # | Item | What / where | Effort |
|---|------|--------------|--------|
| 3.1 | Transitions library | Cross-dissolve, dip-to-black/white, slide, wipe; clip-edge drop targets + duration handles; render via the existing effects/keyframe pipeline | 2-3 |
| 3.2 | Core effects pack | Vignette, sat/hue, exposure, sharpen, glow: registered like `effects/definitions/blur.ts`, keyframable | 2 |
| 3.3 | Basic color panel | Exposure/contrast/temp/tint/sat + shadows-mids-highlights wheels; LUT import later | 2-3 |
| 3.4 | Trim power tools | Slip and roll edits + standard keymap option (X blade, JKL shuttle with true rates); ship as a "Premiere keymap" preset in the existing remapper | 1-2 |
| 3.5 | Audio mix pass | Track meters, per-track gain, one-click music ducking under speech (VAD already exists to drive it) | 2 |

**Exit gate:** parity matrix re-run: no row below B for the talking-head workflow.

### Phase 4 — Scale (performance + long video) · ~4-6 sessions
*Goal: a 30-min 4K project feels like a 3-min 1080p one.*

- 4.1 Proxy pipeline: auto low-res proxies on import (toggle), full-res at export (the transcode route exists as a seed).
- 4.2 Timeline virtualization audit: windowed rendering of clips beyond `memo(Timeline)`; measure with the 137-element project first.
- 4.3 Waveform/thumbnail workers: move generation fully off the main thread, cache per asset.
- 4.4 Undo memory diet: delta-based snapshots or capped deep-clone size; measure a 4-hour session.
- 4.5 Texture-pool stutter: still blocked on the Rust toolchain (documented); revisit when unblocked.

### Phase 5 — The showcase (public-beta shape) · ~4-6 sessions
- 5.1 **"Edit for me"**: the queued one-button pipeline (assemble → Director cut → captions → graphics → export) with the Jobs tray + Review panel as its spine. This is the marketing moment and it is mostly wiring now.
- 5.2 Setup doctor: one command/screen that checks ffmpeg, CLI auth, Docker, model downloads, and says exactly what to fix (extends the `hyperframes doctor` idea product-wide).
- 5.3 Hosted-render decision (ADR-5): pick HeyGen compose vs Lambda for non-local users.
- 5.4 Taste engine v2 + marketplace groundwork per BRIEF §6-7, only after the above holds.

### Explicitly NOT doing (for now)
- Multicam (effort 10/10, niche for the core use case)
- Full LUT/scopes color suite (basic panel first)
- Mobile/touch layout
- Rewrite-repo port (upstream-watch keeps monitoring)

---

## 4. Sequencing logic (why this order)

1. **Phase 0 before everything:** consolidating UX on top of silent crashes just makes the crashes easier to find. And every later phase ships faster once the E2E harness exists, because Dan's verify bottleneck (B1) is the current rate limiter.
2. **Phase 1 before Phase 2:** the Simple mode can only hide chrome that is already organized; hiding today's scattered buttons would just relocate confusion.
3. **Phase 3 after 2:** transitions/color are high-effort polish; the product sells on the AI spine + ease first (CapCut won on ease, not on Lumetri).
4. **Phase 4 whenever pain demands:** any OOM/freeze report on real footage can pull a 4.x item forward.

## 5. Measures that matter

- TO-VERIFY.md line count (must go down every week)
- Toolbar top-level control count (23 → ≤8)
- AI entry points (6+ → 1 Create menu + palette)
- New-user time to first export (target <10 min, measured by the 2.2 sample run)
- Longest exportable video (20 min today with OOM risk → 60 min)
- Crash-with-data-loss reports (→ zero after 0.1-0.3)
