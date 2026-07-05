---
title: "feat: graphics-generate buttons (Remotion + HyperFrames) driving the dan-video skill"
date: 2026-07-05
branch: feat/graphics-generate
---

# Graphics-generate: REMOTION + HYPERFRAMES-GRAPHICS buttons

Two toolbar buttons that generate a motion-graphics overlay pass for the current
video via Dan's `dan-video` skill, render it, and place the result on the timeline.

## Decisions (Dan, 2026-07-05)
- Render flow: **proof clip first**, then full render on approval (the skill mandates
  this; a 2hr render that crashes at frame 30k is a disaster).
- **Two buttons**, both driven by the dan-video style: REMOTION (primary, the skill's
  native engine) + HYPERFRAMES-GRAPHICS (HTML-render fallback, faster).
- Generation = **shell out to the `claude` CLI** (a real agentic session with the
  `danL` kit), reusing the codebase's existing claude-shell pattern.
- Output files -> `D:\Claude\_temp`.

## Per-button flow
1. **Extract**: flatten the current timeline's source video to one MP4 + export the
   transcript JSON -> the engine's project input dir.
2. **Generate** (agentic, minutes): spawn a headless `claude` in the engine project,
   loaded with the dan-video skill, to read transcript + video and WRITE the
   composition. Stream its output to the job log.
3. **Proof render** (~100s clip, fast): drop it on the timeline for review.
4. **Approve -> Full render** (~2hr, background job).
5. **Import**: final MP4 -> `D:\Claude\_temp` -> add to timeline as new video + audio
   tracks.

## Architecture
- **Background-job model**: `D:\Claude\_temp\<jobId>\job.json`
  `{ id, engine, phase, progress 0..1, heartbeatAt, log[], proofPath, fullPath, error }`.
  Survives page reload; the 2hr render must not be tied to a request lifecycle.
- **Detached worker**: `scripts/graphics-worker.mjs` runs the phases, writes job.json +
  a heartbeat every few seconds. Spawned `detached` by the API so it outlives requests.
- **API** (`apps/web/src/app/api/graphics/`): `start`, `status` (poll), `render-full`,
  `cancel`.
- **Client orchestrator**: `run-graphics.ts` (mirrors `run-hyperframes.ts`) - kicks
  start, polls status, on proof/done places output on the timeline.
- **UI**: REMOTION + HYPERFRAMES-GRAPHICS buttons in `timeline-toolbar.tsx`
  (ToolbarRightSection, next to RUN HYPERFRAMES) + a `GraphicsJobPanel` (progress bar,
  live log, heartbeat dot so it never looks frozen, proof preview + Approve / Cancel).
- **Placement**: reuse `buildAiLanes` / `claimLane` / `InsertElementCommand`; add BOTH
  the video and its separated audio track (`toggleSourceAudioSeparation`).

## Engines
- **Remotion**: `D:\Hermes\remotion-v2` (Remotion 4.0.484 + `src\danL` kit installed).
  Render `npx remotion render <entry> <compId> <out>`; proof `--frames=0-3000`.
- **HyperFrames-graphics**: adapt the same EDL/style into an HTML composition rendered
  via the existing hyperframes CLI path (phase 3; larger adaptation since the skill is
  Remotion-native).

## Phases
1. **Backend vertical slice**: job model + worker + API + Remotion extract -> generate
   -> proof render, driven from a minimal button. Prove the pipeline end to end.
2. **Remotion full**: full render + timeline import (video+audio) + the polished
   progress/heartbeat panel + the real REMOTION button.
3. **HyperFrames-graphics**: adapt the skill to an HTML beat set + the second button.

## Risks
- Agentic generation reliability (the "issues with hyperframes" class, worse for
  Remotion which fails hard on any code error). Mitigation: the proof-clip gate.
- 2hr detached render robustness on Windows (detached spawn, heartbeat, cancel, reload).
- Flattening a multi-clip timeline to one source MP4 for the engine input.
