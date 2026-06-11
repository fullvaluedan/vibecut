# Project Brief: FrameCut (working name)
## AI-native video editor — OpenCut fork + HyperFrames generation layer

**Owner:** Dan (fullvaluedan) · **Date:** 2026-06-11 · **Status:** Phase 0 in progress

---

## ⚠️ Amendment 2026-06-11 — base repo changed (Dan-approved)

The original brief said to fork `OpenCut-app/OpenCut`. That repo's `main` is now an **early-stage full rewrite** (Vite + TanStack Start + Cloudflare) with a blank, non-functional editor. The working editor lives in `OpenCut-app/opencut-classic`, which was **archived (read-only) on 2026-05-17**. Dan approved re-basing on Classic on 2026-06-11. Consequences:

1. **FrameCut is a fork of `opencut-classic`**, not of the rewrite. The fork is `fullvaluedan/framecut`; remote `upstream` points at the archived classic repo for reference only.
2. **There is no upstream sync.** Upstream is frozen forever. Phase 0's weekly sync workflow is replaced by `.github/workflows/upstream-watch.yml`, which watches the **rewrite** repo weekly and notifies (issue + optional Telegram) when it shows activity — so we know when a future port might become worthwhile.
3. **We own the codebase outright.** "Keep upstream merges cheap" rationales are moot for Classic; the isolation rules (Hard rule 1, ADR-1) are **kept anyway**, because they are what makes a future port to the rewrite affordable.
4. §2's "OpenCut facts" and Phase 4's "upstream as PRs to OpenCut" no longer apply to Classic (archived repos accept no PRs). Generic timeline improvements could still be PR'd to the rewrite later if relevant.
5. The archived `main` did not compile; build fixes are committed to this fork and logged in `PATCHES.md`.

Everything else below stands as written.

---

## 1. What we are building

A CapCut-style video editor where users generate motion-graphics assets with AI (HyperFrames) and edit them with a full traditional toolset. Generated comps do NOT sprawl across the timeline — they are translated into native editor clips, auto-placed A/B style across a hard-capped 4-track timeline, and remain editable directly on the preview canvas. The editor learns the user's taste from their edit behavior and (later) powers a community template marketplace ranked by behavioral data.

Eventually a public product. Built solo + Claude Code, orchestrated by Hermes.

## 2. Base repos

| Repo | Role | How we consume it |
|---|---|---|
| `OpenCut-app/opencut-classic` (MIT, archived) | Editor UI, timeline, preview, project mgmt | **Fork** → `fullvaluedan/framecut`. Next.js web app, Bun monorepo, Rust/WASM core (prebuilt, published) |
| `OpenCut-app/OpenCut` (rewrite) | Possible future base | **Watch only** via upstream-watch workflow; do not build on it yet |
| `heygen-com/hyperframes` (Apache 2.0) | HTML→MP4 deterministic renderer | **npm dependencies only. Never fork.** `hyperframes` (CLI), `@hyperframes/core` (parsers/types), `@hyperframes/player`. Pin exact versions |

### HyperFrames facts that constrain us
- Comps are HTML files with `data-start` / `data-duration` / `data-track-index` attributes; animation via GSAP/CSS/Lottie/Three.js adapters; rendered frame-by-frame in headless Chrome + FFmpeg. Deterministic: same input → same frames, **but only at a pinned version**.
- Ships constantly (180+ releases). Version bumps are deliberate, reviewed, never auto-merged.
- Requirements: Node 22+, FFmpeg. Has an AWS Lambda render path (our future hosted-render answer) and a hosted compose agent at HeyGen (our second backend).

## 3. Hard rules (every session must follow)

1. **Isolation rule:** all new code lives in our own packages/directories:
   - `packages/hf-bridge/` — HyperFrames importer, parser adapter, render queue
   - `packages/taste-engine/` — edit telemetry + taste profile
   - `apps/web/src/features/ai-generate/` — generation panel UI
   - Modifications to upstream-originated files are a last resort, kept minimal, and **every modified upstream file is logged in `PATCHES.md`** (path, reason, date, port notes).
2. **Never fork or vendor HyperFrames source.** npm only.
3. **Track cap is law:** the timeline never exceeds V1, V2, Overlay, Audio. The importer flattens rather than creating track 5.
4. **Taste telemetry never leaves the device.** Only anonymized recipes are ever uploaded (Phase 7, opt-in).
5. **Pin everything.** HyperFrames packages at exact versions in `package.json`. Renderer determinism depends on it.
6. Dan is a coding novice directing the project: explain decisions in plain language in PR descriptions and session summaries, give him copy-paste commands, never assume he'll debug raw stack traces.

## 4. Architecture decisions (settled — do not relitigate)

**ADR-1: Translation layer, not embedded renderer.** Generated HyperFrames comps are parsed (via `@hyperframes/core`) and converted into native OpenCut clips on import. OpenCut's preview/export never knows HyperFrames exists. This keeps the editor core swappable (e.g. a future move to the rewrite).

**ADR-2: Two element buckets at import.**
- *Native-mappable* (static/simple text, images, plain video, audio) → real OpenCut clips, fully canvas-editable.
- *Motion-heavy* (GSAP timelines, shaders, Lottie, Three.js) → background-rendered to video clips; WebM+alpha for overlay elements, MP4 for full-frame.

**ADR-3: A/B checkerboard placement.** The placement engine lays imported clips across V1/V2 alternately (transitions live on the overlap), text/graphics onto Overlay, sound onto Audio. Each import keeps a `compGroupId` so the group can be selected, moved, or regenerated as a unit.

**ADR-4: Canvas-edit → re-render loop for animated elements.** Animated text/graphic clips carry editable metadata (text content, position, scale, color). User edits them on the canvas like normal elements; a debounced (≥1500 ms idle) background job patches the comp HTML, re-renders the element, and hot-swaps the clip. Show a subtle "updating" badge on the clip during re-render. This is the hardest and most important feature in the product.

**ADR-5: Backend driver abstraction.** One `GenerationBackend` interface, two drivers: `LocalCliDriver` (spawns `npx hyperframes render` on the user's machine; free, slower) and `HeyGenComposeDriver` (HeyGen hosted compose API; fast, paid). Settings-level default + per-generation override. Hosted/public users get HeyGen or our own Lambda render stack; local CLI is dev/power-user only.

**ADR-6: Taste engine is prompt context, not model training.** Edit events → periodic LLM compression → structured taste profile JSON → injected into every generation prompt. See §6.

## 5. Build phases

### Phase 0 — Vanilla baseline + watch automation (amended)
**Goal:** stock OpenCut Classic building and running from the `fullvaluedan/framecut` fork.

1. ~~Fork~~ Done: `fullvaluedan/framecut` forked from `opencut-classic`, cloned at `C:\Users\danom\Videos\framecut`, `upstream` remote added.
2. Build fixes committed (see `PATCHES.md`); `bun run build:web` green; `docker compose up -d` → editor at http://localhost:3100.
3. `PATCHES.md` created.
4. `.github/workflows/upstream-watch.yml`: weekly cron (Mon 09:00 Asia/Taipei) + manual dispatch; reports new activity on the **rewrite** repo via issue + Telegram (secrets `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`). Hermes watches this chat.
5. Renovate config watching `hyperframes` + `@hyperframes/*`: PRs only, never auto-merge, grouped, weekly. (Takes effect when those deps land in Phase 1; Dan must install the Renovate GitHub App on the repo.)

**Done when:** editor runs from the fork, a manual workflow run completes green and (once secrets are set) produces a Telegram message.

### Phase 1 — Generate panel (loose mode)
**Goal:** prompt → MP4 in the media bin. Proves the whole pipe before the hard parts.
1. "Generate" panel in the editor sidebar: prompt box, duration, aspect (9:16 / 16:9 / 1:1), backend toggle (stub HeyGen for now, implement Local CLI).
2. `LocalCliDriver`: scaffold a temp comp dir, have a Claude API call (or the HyperFrames agent skill flow) write the comp HTML from the prompt, run `npx hyperframes lint` then `render`, return MP4 + comp source dir.
3. Store generated assets as **paired**: MP4 + comp source + prompt + backend + version, in project storage. The comp source is what makes Phase 2/3 possible — never discard it.
4. MP4 appears in media bin with an "AI" badge; right-click → "Regenerate" (re-prompt dialog).

**Done when:** Dan types a prompt and drags the result onto the timeline within ~60s on his RTX 3080 machine.

### Phase 2 — Importer + A/B placement (the differentiator)
**Goal:** comps explode into native clips, placed cleanly, capped at 4 tracks.
1. `packages/hf-bridge/importer`: parse comp via `@hyperframes/core`; classify each element into the two ADR-2 buckets (classification heuristics: has GSAP/Lottie/shader hooks → motion-heavy; plain `<h1>`/`<img>`/`<video>`/`<audio>` with no timeline entry → native).
2. Render motion-heavy elements individually (element-scoped comps) to WebM+alpha / MP4 in a background queue (concurrency 1-2, debounced, cancellable).
3. Placement engine: checkerboard video clips across V1/V2; text/graphics → Overlay; audio → Audio; never create a 5th track — overflow gets flattened into one rendered clip with a warning toast.
4. `compGroupId` on every imported clip; "select group" and "regenerate group" actions.
5. "Import as single clip" stays available as the simple path (Phase 1 behavior).

**Done when:** a generated comp with 6+ internal layers lands as ≤4 tracks of normal-feeling clips, all trimmable/draggable.

### Phase 3 — Canvas edit → re-render loop
**Goal:** ADR-4 working end to end.
1. Animated clips carry metadata: `{ text, x, y, scale, color, fontFamily }` mapped to selectors in their comp fragment.
2. Canvas gizmos (reuse OpenCut's text/transform tooling where possible) edit the metadata live; preview shows the static state immediately.
3. Debounced patch-and-re-render job; hot-swap clip media on completion; "updating" badge during render; failures revert with a toast.

**Done when:** Dan double-click-edits the text of an animated lower-third on the canvas and the animation survives, updated, within ~5s.

### Phase 4 — Ripple/nudge toolset + timeline UX
1. Select all / select-after-playhead.
2. Nudge selection ±1 frame, ±5 frames, ±1s (`,` `.` with modifiers — match CapCut muscle memory where sane).
3. Ripple delete + ripple trim across all 4 tracks.
4. Track-cap UX polish (clear affordances, no accidental track creation).
(Amended: upstream PRs to Classic are impossible — archived. Generic improvements could be offered to the rewrite repo later if its timeline code is comparable.)

### Phase 5 — Backend switcher + export
1. Implement `HeyGenComposeDriver` against the HeyGen compose API.
2. Settings: default backend, per-generation override, API key management (keys in OS keychain/env, never in project files).
3. Export pass: full-res re-render of any proxy-quality generated clips before final encode.

### Phase 6 — Taste engine (see §6)

### Phase 7 — Template marketplace (see §7) + productization
Auth, billing, hosted render (HyperFrames AWS Lambda stack), template gallery service. Spec separately when Phase 5 ships.

## 6. Taste engine spec (Phase 6)

**Capture (local only, SQLite or project-store JSON):** events on AI-generated clips only —
`trim` (original vs final duration), `reposition` (canvas deltas), `delete-element` (what kind), `restyle` (font/color changes), `regenerate` (with old vs new prompt), `kept-to-export` (boolean per element at export time).

**Compression:** every N events (start: 25) or on project export, send the event log + current profile to Claude → updated taste profile JSON:
```json
{
  "pacing": "cuts 25-40% shorter than generated defaults",
  "text": { "position": "lower-third bias", "fonts": ["Inter", "Anton"], "avoid": ["script fonts"] },
  "color": { "prefers": ["#0A0A0A", "#F5F0E8"], "avoid": ["purple gradients"] },
  "audio": "removes generated music 80% of the time — default to no music",
  "hooks": "favors number-led openers",
  "confidence": { "pacing": 0.9, "color": 0.6 }
}
```
**Injection:** profile JSON appended to every generation prompt as a constraints block. Per-project profile overrides global. UI: a viewable/editable "Taste" settings page — the user can read and correct what the system thinks it knows. Low-confidence entries are suggestions, not constraints.

## 7. Template marketplace spec (Phase 7 sketch)

- **Recipe** = comp structure + timing + styling + the edit-delta summary that produced the final cut, with all user media replaced by typed placeholders (`{video:9s}`, `{logo}`, `{headline}`).
- Publishing is explicit opt-in per project. Raw telemetry never uploads (Hard rule 4).
- Ranking signals: kept-vs-regenerated rate, export completion rate, fork count. No star ratings.
- Applying a template = recipe + the applying user's own taste profile → generation. Same template, personalized output.

## 8. Working conventions for Claude Code sessions

1. Read `PATCHES.md` and this brief at session start. Update `PATCHES.md` in the same commit as any upstream-file edit.
2. One phase-task per branch: `feat/p2-importer`, `chore/p0-sync-workflow`.
3. Conventional commits; PR descriptions in plain language with a "what Dan should test" section.
4. Default model claude-sonnet-4-6; escalate to opus on "max power" per Dan's standing workflow. Hermes is orchestrator: it receives Telegram alerts from CI and dispatches sessions.
5. When OpenCut internals are unclear, read `docs/` in this repo before guessing; when HyperFrames behavior is unclear, read the installed package source in `node_modules`, not the GitHub main branch (we are pinned).
6. The preview panel and export internals are ours now (upstream archived) — the old "stop and flag" rule is downgraded to: treat preview/export changes with extra care and test them.

## 9. Open questions (resolve before their phase starts)

1. Phase 1: comp authoring via Anthropic API call vs HyperFrames agent skills flow — pick after testing both for quality/latency.
2. Phase 2: exact classification heuristics for native vs motion-heavy — expect iteration.
3. Phase 5: HeyGen compose API auth + pricing model for end users.
4. Phase 7: hosting (Vercel + Supabase like GPC, or other), name (FrameCut is a placeholder), licensing of published recipes.
