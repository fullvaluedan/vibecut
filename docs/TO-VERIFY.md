# TO-VERIFY — live checks pending Dan's testing

Everything below is **shipped + committed** (tsc + lint clean, logic unit-tested where testable) but **not yet live-verified by Dan** on real footage. Branch: `feat/director-dupword` (dev server: `framecut-director` launch entry → localhost:3000). Tick items off as you confirm them.

## AI Director — Round 2 (the cut)
Run **AI CUT → AI Director** on a talking-head clip with speech, then check the Review modal + apply:

- [ ] **Filler cuts (U2)** — standalone "um/uh/er", hedges ("you know"/"i mean"), and cut-off false-starts show as cut rows labeled *Filler "…"* / *False start "…"*. "like/so/well" are NOT auto-cut (left to the LLM).
- [ ] **Pacing cuts (U3)** — over-long pauses show as *Long pause (N.Ns) — tighten*; accepting one shortens the gap (doesn't delete the whole pause).
- [ ] **Reorder apply (U1)** — accept a reorder op and confirm the content actually MOVES; one Ctrl+Z restores everything (reorder + cuts undo together).
- [ ] **Take-selection (U3)** — the planner no longer merges unrelated lines (only near-identical re-takes).
- [ ] **Per-category taste (U4)** — reject filler cuts across two runs → the next run proposes fewer fillers (the taste note steers per category).

## AI Director — Round 1 (the dup-word fix)
- [ ] **Doubled "now" (~5:20 in ROUGH_CUT)** — re-run AI Director; the duplicate should now be offered as a cut (gap loosened to ~1s + breath/filler step-over + chunk-seam repair).

## Timeline / editor fixes
- [ ] **Import → V1** — importing a video lands on V1 (main), not V2, even when a V2 overlay track exists.
- [ ] **Multi-select move (forward tool)** — press **A**, then press-drag an unselected clip: it selects everything forward AND moves the group in one motion.
- [ ] **Shift + ← / →** nudges 15 frames (configurable in Settings → Hotkeys); timeline view follows the playhead; clicking the track area doesn't move the playhead (ruler does).

## Export
- [ ] **Save location first** — clicking Export opens the save dialog BEFORE the encode (cancelling costs no render); the file extension matches (mp4 when AI overlays are burned in).
- [ ] **Audio-stage progress** — exporting WITH audio shows the bar move through the first 5% instead of freezing; export no longer self-cancels when you click away from the popover.

## Move between tracks + unlink (#4 — built, needs drag verification)
- [ ] **Cross-track move (#4A)** — drag a linked video clip vertically onto another video track: the video moves, its linked audio **stays put** (no Alt needed). A genuine overlap on the target track still rejects the move.
- [ ] **Unlink (#4B)** — right-click a linked clip → **Unlink audio/video**; afterward the video and audio move/trim fully independently (the menu item only appears on linked clips; Ctrl+Z re-links).

## Open follow-ups (not yet built)
- [ ] **#6 playback stutter** — root-caused to the Rust compositor texture pool but unconfirmed as the dominant cause; needs pool-size instrumentation + a wasm rebuild before fixing (don't change Rust blind).
