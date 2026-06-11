# FrameCut — session entry point

Read these before doing anything else:

1. `docs/BRIEF.md` — the project brief. **Start with the Amendment at the top** (this repo is a fork of the archived `opencut-classic`, not of the OpenCut rewrite — the upstream situation changed after the brief was written).
2. `PATCHES.md` — every modified upstream-originated file. Update it in the same commit as any such edit.

Hard rules live in BRIEF.md §3. The ones most often relevant while coding:

- New code goes in `packages/hf-bridge/`, `packages/taste-engine/`, or `apps/web/src/features/ai-generate/` — touching upstream-originated files is a last resort and must be logged in `PATCHES.md`.
- The timeline is hard-capped at 4 tracks: V1, V2, Overlay, Audio.
- HyperFrames is consumed via npm only, pinned to exact versions. Never vendor its source.
- Dan is a coding novice directing the project: plain-language explanations, copy-paste commands, no raw stack traces.

Build/run:

- `bun install`, then `bun run build:web` (needs `apps/web/.env.local` — copy from `.env.example`, placeholders are fine for building).
- Full local stack: `docker compose up -d` → editor at http://localhost:3100.
- Dev server: `bun run dev:web`.
