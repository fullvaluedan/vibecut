# Live-verification checklist — Premiere-parity timeline (PR #48)

These features ship gated (tsc 0, lint clean, math unit-tested) but the **gesture
and visual behavior is not bun-testable** — the interaction controllers are
`useState`-held and don't hot-reload. Work through this list on a **hard reload**
of localhost. Each item: arm/trigger → expected result.

## Gesture stack (the trim tools — drag a clip; controllers need a hard reload)

Arm from the left tool rail or hotkey; **V** or **Escape** disarms any tool.

- [ ] **Rate-Stretch (R)** — drag a video/audio clip **edge**: the clip's *speed*
  changes (same footage, faster/slower), not its trim. Speed panel reflects the rate.
- [ ] **Ripple (B)** — drag a clip **edge**: the clip trims AND every downstream
  clip shifts by the same amount (no gap/overlap opens). Clip stays anchored at its start.
- [ ] **Roll** (rail button; no default key) — drag the **cut between two adjacent
  clips**: one grows, the other shrinks; combined span fixed; nothing else moves.
- [ ] **Slip (Y)** — drag a clip's **interior**: the visible footage shifts while the
  clip's timeline position + width stay fixed. Clamps at the source ends (never collapses).
- [ ] **Slide (U)** — drag a clip's **interior**: the clip moves between its neighbors,
  which absorb it (left tail / right head trimmed); trio span fixed, nothing ripples.
  A clip at a track edge slides against its one present neighbor.

## Overwrite / insert edit model (OQ7)

- [ ] **Overwrite drop** — drag a bin clip onto an **occupied** spot on a track →
  it overwrites the covered frames. Drop onto empty space → unchanged (as before).
- [ ] **Insert drop** — hold **Ctrl** while dropping onto an occupied spot → everything
  from the drop point ripples right (nothing overwritten). One undo reverts the whole drop.

## Non-gesture batch (plan 003)

- [ ] **Duplicate track** — right-click a track → *Duplicate track* → an adjacent copy
  with identical clips. Editing the copy does NOT touch the original.
  - [ ] **Linked A/V edge case** — duplicate a track whose video has *separated audio*
    (on an audio track): the copy's clips are cleanly **unlinked** (no broken link to the
    original's audio), not co-linked with the source.
- [ ] **Markers** — edit a marker's comment + pick a color (persists on reload);
  **Export CSV** downloads `timecode,comment,color`.
- [ ] **Mask Expand** — draw a mask, drag the **Expand** slider: the masked region
  grows/shrinks (distinct from Feather's soft edge). Check a freeform + a shape mask.
  Export matches preview.
- [ ] **Mask keyframing** — keyframe a mask's feather/position/scale (stopwatch in the
  Masks tab), scrub: the mask animates. Export matches preview.
- [ ] **Panel restyle** — the **Speed / Audio / Blending** panels match the Effect
  Controls fx-group look; every control still edits + keyframes (Speed's scrub ranges intact).

## Known v1 caveats (expected, not bugs)

- Freeform-mask **Expand contract** on a concave shape is a vertex-normal approximation
  (no self-intersection resolution) — large inward contracts may look rough.
- Mask **Expand is a no-op** for split and text masks (intentional).
- Overwrite/insert is **single-clip drops only** so far; multi-clip + overwrite-on-move
  are the next units (U4/U5, not yet built).

---
*Generated during the plan-003 build. Tick items as you confirm them; report any that
fail and the unit can be fixed before U4/U5 build on the gesture foundation.*
