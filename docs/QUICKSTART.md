# VibeCut — Quickstart

Two things: how to **run it locally**, and how to **use HyperFrames** (the AI motion-graphics feature) in the app. Kept deliberately short.

---

## A. Run VibeCut locally

**You need first (one-time):**
- **Node 22+** and **bun** (`bun@1.2.18` is pinned).
- **ffmpeg** on your PATH (used to render/export). Check: `ffmpeg -version`.
- **Docker Desktop** running (for the Postgres + Redis containers).
- A working **`claude` CLI** *or* an **Anthropic API key** — needed for the AI features (see section C if AI editing fails).
- `apps/web/.env.local` present (the app's local config).

**Start it (every time):**
1. Install deps (first run, or after a pull): `bun install`
2. Make sure the support containers are running in Docker Desktop:
   `framecut-db-1`, `framecut-redis-1`, `framecut-serverless-redis-http-1`. (The *web* container stays stopped — you run the dev server yourself.)
3. Start the dev server from the repo root:
   ```
   bun run dev:web
   ```
   (This is the VS Code launch entry **framecut-dev**.)
4. Open **http://localhost:3000**.

That's it — edit, and it hot-reloads. To sanity-check a production build before shipping: `bun run build:web` from the repo root (must exit 0).

---

## B. Use HyperFrames (AI motion graphics) in the app

HyperFrames is the AI that adds motion graphics (titles, lower-thirds, stat pops, section breaks, charts/maps) to your video. The flow is: **transcribe → Claude plans what to add → render → drop it on the timeline.**

**The 30-second version:**
1. Put your clips on the timeline (HyperFrames reads the spoken words, so it needs audio/dialogue).
2. *(Once)* Open **Settings → AI** and pick your connection (Claude subscription, or paste an Anthropic API key).
3. Click **RUN HYPERFRAMES** (the magic-wand button in the timeline toolbar).
4. Watch the progress (Transcribing → Claude is planning → Rendering → Placing). When it's done, the effects are on your timeline. **Ctrl+Z** undoes the whole thing.

**Optional knobs (in the HyperFrames panel) before you run:**
- **Templates** — check/uncheck which motion graphics it's allowed to use (lower-third, kinetic-title, number-pop, callout-pill, section-break).
- **Look / style** — pick a vibe (Ember, Electric, Acid, Magenta, Editorial, Terminal). It sets the colors/font and nudges the pacing.
- **Direction box** — free text, e.g. *"only lower thirds, keep it minimal"* or *"make it high-energy."* The AI follows it.
- **Engine** (Settings → AI):
  - **Native** — instant, fully-editable elements (no rendering wait). Best default.
  - **Cinematic** — renders each effect to video (slower, but exact). Also unlocks the registry **blocks** (charts, maps, social cards) in the panel — click **Add** to bake one onto the timeline.
  - **Authored** — Claude writes a custom graphic for the clip; adds a **Versions ×3** button to generate three and pick one.

**Tip:** every change is review-able and reversible — if you don't like a placement, just undo, tweak a knob, and run again.

---

## C. If AI editing fails ("nothing happens" / errors)

Almost always one of two things:

1. **The `claude` CLI got wiped.** A failed Claude Code auto-update can leave the Windows `claude.exe` missing, so the plan step dies silently. Confirm with the *cmd* resolution (not Git Bash):
   ```
   cmd //c "claude --version"
   ```
   If that errors, either restore the binary, or set **`FRAMECUT_CLAUDE`** to a working claude path (e.g. the one in `…\AppData\Roaming\npm`) and restart the dev server — VibeCut will use it for planning, authoring, and the doctor.
2. **A render prerequisite is missing** (ffmpeg or the headless Chrome HyperFrames renders with). The smoke scripts below will tell you exactly which.

**Verify the whole pipeline without the UI** (run from the repo root; handy after upgrading HyperFrames):
- Render engine: `bun packages/hf-bridge/scripts/render-smoke.ts` — renders every template + a few registry blocks and ffprobe-checks each (a green run means ffmpeg + Chrome are fine).
- Plan step: `bun packages/hf-bridge/scripts/plan-smoke.ts` — runs the real Claude planner on a sample transcript (a green run means your `claude` connection works).

If both pass, AI editing works end-to-end.
