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

## AI Director — Vision v0 (the cut gets eyes)
Turn on **Settings → AI → Director vision** (default OFF), then run **AI CUT → AI Director** on a clip where the speaker leaves frame / freezes / cuts to black, using an **API key** auth mode (the claude-code CLI can't take images and will degrade to text):

- [ ] **Vision toggle (U3)** — the "Director vision" switch persists across reloads; with it OFF the Director behaves exactly as before (text-only).
- [ ] **Visual cuts (U2)** — with vision ON, the Director proposes cuts whose reason references the *visual* (e.g. "speaker off-screen", "frozen frame") and the Review modal tags them with a **Vision** badge.
- [ ] **Cost notice (U4)** — a toast reports "Director vision analyzed N frames · ~Xk tokens" after a vision run.
- [ ] **Degrade fallback (U3/U4)** — on the claude-code CLI (no image support), vision ON still produces a text cut and shows "Director vision isn't available… used the transcript" (never an error).
- [ ] **Per-category taste** — rejecting vision cuts across runs makes the next run propose fewer (the "vision-based cuts" taste line steers it, separate from text cuts).
- [ ] **Frame budget** — long timelines never send more than 20 frames (an even spread across segments); the text-only path is unchanged when vision is off.

## Editor sweep — Properties panel state hygiene (U2)
Select different elements and switch the Properties panel between them:

- [ ] **Template-group switch no longer corrupts** — select template group A, then a different group B of the same template type; B's Template Controls show **B's** field values (not A's), and editing B does NOT overwrite it with A's old values. (Root cause: the tab subtree is now keyed by `element.id`, so React remounts and re-seeds every per-element `useState` on selection change.)
- [ ] **Uniform-Scale checkbox re-derives per element** — select an element whose X/Y scale differ (Uniform Scale OFF), then select one whose X==Y; the Effect Controls "Uniform Scale" checkbox reflects the NEW element's state (checked), not the previous element's. (Same remount; ScaleRows seeds `useState(sx === sy)` fresh.)
- [ ] **FxGroup collapse re-derives per element** — collapsing a Motion/Opacity group on one element does not carry the collapsed state to the next selected element (each starts at its default).
- [ ] **Multi-select header shows** — multi-select two UNRELATED clips → a compact "N elements selected — editing <name>" header renders above the tabs (edits apply to the representative). A single selection, a linked V/A pair, or a single template group does NOT show the header.

## Editor sweep — Keyboard shortcuts & native affordances (U3)
- [ ] **Bare key on a focused toolbar button** — Tab to (or focus) a toolbar toggle (Snapping/Ripple/etc.) and press **Space/Enter**; it ACTIVATES the button (native) instead of firing toggle-play / goto-start.
- [ ] **Shortcuts still fire on a focused clip** — click a clip (clip body is `<button tabindex="-1">`), then press **s** (split) / **Space** (play) — they still work (the interactive guard excludes `tabindex="-1"`, so clip focus doesn't suppress shortcuts).
- [ ] **Ctrl+C with no timeline selection** — select some page text (a transcript line / label) with nothing selected on the timeline and press **Ctrl/Cmd+C**; the native browser copy runs (text lands on the clipboard). With a clip selected, Ctrl+C still does the editor copy.
- [ ] **Ctrl+R with no selection** — press **Ctrl/Cmd+R** with nothing selected; the browser reloads (no longer eaten by the speed panel). With a clip selected it still opens the Speed panel.
- [ ] **Held key** — hold **s**; it splits once, not repeatedly (one-shot). Hold an arrow / seek key; it still auto-repeats (scrub).
- [ ] **Zoom-out chip** — Settings → Hotkeys: the *timeline zoom out* shortcut shows a single **-** chip (not two blank boxes / a duplicate "+").

## Open follow-ups (not yet built)
- [ ] **#6 playback stutter — BLOCKED on the wasm toolchain (vision-round U5 investigation).** Root-caused to the Rust compositor texture pool (`rust/crates/compositor/src/texture_pool.rs`), still unconfirmed as the *dominant* cause — needs pool-size instrumentation before any fix (don't change Rust blind). **Why it's blocked here:** the running app consumes the **published npm `opencut-wasm@^0.2.10`** (`apps/web/package.json`), not a local build — every web import is `from "opencut-wasm"`, nothing imports `rust/wasm/pkg`, and that dir was never built. This worktree also has **no Rust toolchain** (no cargo / wasm-pack / rustc). So instrumenting the Rust would (a) not run in the app and (b) not even compile-check here — exactly the unverifiable Rust the plan's gate forbids. **To unblock (needs a machine with the Rust + wasm-pack toolchain):** (1) add a pool-size readout to `texture_pool.rs` (count `available` + per-`(w,h)` bucket sizes), expose it via `rust/wasm/src/perf.rs`, surface it in `apps/web/src/diagnostics/render-perf.ts`; (2) `bun run build:wasm` → repoint `apps/web` at the local `rust/wasm/pkg` (or `bun run publish:wasm` to bump the npm package) and rebuild; (3) capture a long-session trace (`window.__renderPerf = true`) to confirm the pool climbs vs plateaus; (4) only then ship the cap/evict fix. Plan: `docs/plans/2026-06-18-002-feat-director-vision-v0-plan.md` (Phase B / KTD-6).
