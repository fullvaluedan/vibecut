---
title: "feat: edit by transcript (word-select ripple-delete, export, copy)"
date: 2026-07-02
type: feat
status: planned
branch: feat/director-importance
target_repo: framecut-director (clone at C:/Users/danom/Videos/framecut-director)
origin: none (planned directly from Dan's request, following live verification of the AI-CUT pauses/recall plan)
---

# feat: edit by transcript

## Summary

A new persistent left-side tab shows the current timeline's transcript as readable text. Click-drag selects a word range; deleting the selection ripple-cuts the corresponding timeline span using the same single-undo command every other AI-CUT path already uses. Two supporting actions: copy the full transcript to the clipboard, and export it to a plain-text file. Purpose (Dan's words): "if we use AI, we can ask it what to remove" — export/copy the transcript, get cut suggestions back from any external AI, then apply them by selecting and deleting in the transcript view. The AI step happens outside the app in this pass; the app is the manual apply-surface.

This is genuinely new UI — research confirmed no transcript-as-text viewer and no word-click-drag selection exist anywhere in the codebase today. But the mechanics underneath (word-level timing, ripple-delete, single-undo) are proven infrastructure this session's AI-CUT work already exercises live.

---

## Problem Frame

Right now the only way to trim VibeCut's timeline is by clip/keyframe manipulation or the AI-CUT menu's automated passes. There's no way to read the spoken content as text and cut by selecting words — and no way to get that text out of the app to hand to an external AI for review. Dan wants both: a transcript view you can edit directly, and an export/copy path so the transcript can leave the app, get reviewed by an AI, and the resulting cut list gets applied back through the same view.

---

## Requirements

- **R1:** A new left-side tab (alongside Media/HyperFrames/Sounds/Text/Shapes/etc.) shows the current timeline's transcript as readable text, triggering transcription on demand if not already cached.
- **R2:** The user can click-drag across the transcript text to select a contiguous word range (or segment range, when word-level timing is unavailable).
- **R3:** Deleting the selection ripple-cuts the corresponding time range out of the timeline, across all tracks, as a single undoable action.
- **R4:** A "Copy transcript" action copies the full transcript (readable, timestamped) to the clipboard.
- **R5:** An "Export transcript" action downloads the full transcript as a plain-text file.
- **R6 (degradation):** When word-level timestamps are unavailable (model/device limitation), the feature still works at segment granularity rather than being blocked entirely.

---

## Key Technical Decisions

- **KTD1 (word selection resolves through seconds, not ticks):** A selected word-index range resolves to `{startSec, endSec}` by reading `words[i].start` / `words[j].end`, then converts to ticks once at the ripple-delete boundary (`Math.round(sec * TICKS_PER_SECOND)`). This mirrors the exact pattern `apply-plan.ts`'s `planRemovalRanges` already uses for every AI-CUT op — no new time-representation convention introduced.
- **KTD2 (custom index-based selection, not the browser Selection API):** Word spans are tracked by array index (mousedown on word *i* → mousemove/mouseenter extends to word *j* → mouseup finalizes). The native `Selection`/`getSelection()` API was considered and rejected — mapping arbitrary DOM text-node ranges back to logical word indices across highlighted/padded spans is fragile, and the app already needs index-based selection state for highlight styling and the delete action. Index tracking is simpler and sufficient.
- **KTD3 (ripple ALL tracks, no per-track selection UI):** Deleting a transcript range calls `RemoveRangesCommand` with no `trackId` filter, exactly like every existing AI-CUT delete path (Remove Silences, AI Director, etc.). No new per-track selection mental model.
- **KTD4 (graceful degradation to segment granularity):** `ensureTimelineTranscript({wantWords: true})` may return `words: []` with `wordsUnavailable: true` (local model limitation) or omit `words` outright. The transcript view renders and behaves identically in both cases, just at segment granularity instead of word granularity — the feature is never blocked, only coarsened. Cloud/Groq transcription always returns word-level timing; local Whisper's word-level output depends on the selected model export.
- **KTD5 (optimistic post-delete display WITH local timestamp remapping, no auto-retranscribe):** After a ripple-delete, the view strikes/removes the deleted words from the CURRENT displayed transcript rather than immediately re-running transcription (which would be slow and unnecessary on every delete — cuts happen in bursts). **Critical correctness requirement, found during plan review:** the ripple-delete shifts everything downstream left on the live timeline (`RemoveRangesCommand`'s existing ripple behavior), so the in-memory `words`/`segments` arrays used to resolve the NEXT selection must be shifted by the same amount, or a second delete before refresh resolves against stale (too-large) coordinates and cuts the wrong footage. Concretely: after each successful delete, subtract the removed duration from the `start`/`end` of every remaining word/segment whose `start` was at or after the deleted range's end (mirroring the ripple the live timeline just performed). This is local, in-memory bookkeeping only — it does not touch the persisted transcript cache. A manual "Refresh transcript" affordance still exists and re-runs `ensureTimelineTranscript` for authoritative fresh timing (e.g. after many edits, to resync word boundaries that drift from re-encoding), but is no longer required for correctness between individual deletes — only for freshness.
- **KTD6 (export format = readable timestamped text, one line per segment):** `[mm:ss.s–mm:ss.s] text`, one line per transcript segment. This is the exact shape already used successfully this session (both for a human sanity read and for feeding an independent AI reviewer) — proven readable and AI-paste-friendly. SRT/VTT export is explicitly out of scope this round (Dan's call).
- **KTD7 (new tab, not a docked panel):** Dan chose a persistent left-side tab over docking in the properties panel (the pattern already shipped for the AI Director's cut review — see `director-cut-panel.tsx`). Rationale: the transcript should stay available while editing elsewhere, not require a re-open action. This means the new feature does NOT reuse `director-cut-panel.tsx`'s docking mechanism — it follows the ordinary tab-registration pattern (`assets-panel-store.tsx` / `tabbar.tsx` / `assets/index.tsx`) instead.

**Note on file placement:** all new files live under `apps/web/src/features/transcription/`, alongside `transcript-cache.ts` (the module that owns `ensureTimelineTranscript`/`getCachedWords`, which every unit here calls into). This is deliberately distinct from the existing top-level `apps/web/src/transcription/` directory, which holds unrelated caption/model/language utilities (`caption.ts`, `models.ts`, `languages.ts`, etc.) — do not confuse the two or place new files there.

---

## High-Level Technical Design

Selection-to-cut flow, including the degradation branch:

```
User opens Transcript tab
        |
        v
ensureTimelineTranscript({ wantWords: true })
        |
        +-- words present ---------> render WORD-level spans (fine-grained selection)
        |
        +-- wordsUnavailable/absent -> render SEGMENT-level spans (coarse-grained selection)
        |
        v
User mousedown on span i -> mousemove/enter through span j -> mouseup
        |
        v
selection = { startIndex: i, endIndex: j, granularity: 'word' | 'segment' }
        |
        v
User presses Delete (or clicks Delete button)
        |
        v
resolveSelectionToTimeRange(selection, words|segments) -> { startSec, endSec }
        |
        v
{ start: round(startSec * TICKS_PER_SECOND), end: round(endSec * TICKS_PER_SECOND) }
        |
        v
new RemoveRangesCommand({ ranges: [{ start, end }] })  // no trackId -> ripples ALL tracks
editor.command.execute({ command })                    // ONE undo
        |
        v
Optimistic view update: strike/remove selected span from displayed transcript
+ remap remaining words/segments: subtract removed duration from every
  start/end at or after the deleted range's end (mirrors the live ripple,
  keeps the NEXT delete's coordinates correct without a refresh)
        |
        v
(display is fresher than the persisted cache but not re-verified against
 the real audio; "Refresh transcript" re-syncs for authoritative timing)
```

---

## Implementation Units

### U1. Pure selection-to-cut resolver + ripple-delete action

**Goal:** A pure, testable function that turns a word/segment index range into a timeline time range, plus the wiring that executes the ripple-delete as one undo. This is the core mechanic — build and test it independent of any UI.

**Requirements:** R3, R6 (KTD1, KTD3, KTD4)

**Dependencies:** none

**Files:**
- Create `apps/web/src/features/transcription/resolve-selection-to-range.ts`
- Create `apps/web/src/features/transcription/__tests__/resolve-selection-to-range.test.ts`
- Create `apps/web/src/features/transcription/delete-transcript-selection.ts` (the command-execution wiring)
- Create `apps/web/src/features/transcription/__tests__/delete-transcript-selection.test.ts`

**Approach:** `resolveSelectionToTimeRange({ selection, words, segments })` reads `granularity` off the selection and indexes into the matching array (`words[startIndex].start` .. `words[endIndex].end`, or the segment equivalent), returning `{ startSec, endSec } | null` (null on an invalid/empty range). `deleteTranscriptSelection({ editor, selection, words, segments })` calls the resolver, converts seconds to ticks (`TICKS_PER_SECOND`, matching `apply-plan.ts`'s existing conversion), builds `new RemoveRangesCommand({ ranges: [{ start, end }] })`, and executes it as one command.

**Patterns to follow:** `apply-plan.ts`'s `planRemovalRanges` (seconds → ticks conversion, `RemoveRangesCommand` construction); `remove-ranges.ts` for the command's exact constructor shape.

**Test scenarios:**
- Happy path: a word-range selection `[5, 12]` resolves to `{startSec: words[5].start, endSec: words[12].end}`.
- Happy path: a segment-range selection resolves identically using `segments[i].start`/`segments[j].end`.
- Edge: single-word selection (`startIndex === endIndex`) resolves to that one word's own span.
- Edge: empty/invalid selection (`endIndex < startIndex`, or indices out of bounds) returns `null`, no command executed.
- Integration: `deleteTranscriptSelection` produces exactly ONE `RemoveRangesCommand` execution (single undo) and the range has no `trackId` (ripples all tracks).
- Error path: resolver called with `granularity: 'word'` but `words` is empty — falls back to `null` (caller's responsibility to not offer word-granularity selection when words are absent, per KTD4).

**Verification:** All scenarios pass under `bun test`; `bunx tsc --noEmit` clean; a single Ctrl+Z after a delete restores the exact pre-delete timeline state (existing `RemoveRangesCommand` undo behavior, unchanged).

---

### U2. Transcript tab registration + panel scaffold

**Goal:** Register a new "Transcript" tab in the left-side icon rail and stand up its panel shell (idle / transcribing / ready / error / no-speech states), reusing the existing transcription trigger.

**Requirements:** R1, R6

**Dependencies:** none (parallel-safe with U1)

**Files:**
- Modify `apps/web/src/components/editor/panels/assets/assets-panel-store.tsx` (add `"transcript"` to `TAB_KEYS` and the `tabs` registry)
- Modify `apps/web/src/components/editor/panels/assets/index.tsx` (register the new view in `viewMap`)
- Create `apps/web/src/features/transcription/components/assets-view.tsx`

**Approach:** Add the tab entry following the exact shape of existing entries (icon, label). The panel shell manages a small state machine (idle → transcribing → ready → error), triggering `ensureTimelineTranscript({ editor, wantWords: true, onProgress })` on mount/open — the SAME call `background-transcriber.tsx` and `run-director.ts` already make, so no new transcription code path. Note: the background transcriber calls `ensureTimelineTranscript` WITHOUT `wantWords`, so its cache entry is commonly segment-only; opening this tab with `wantWords: true` can still trigger a real (multi-second-to-minutes on local Whisper) word-level pass even when a segment-only cache entry already exists — the progress state must cover this case, not assume a near-instant cache hit is the common case. Show honest progress (mirror the existing "Transcribing…" pattern already shipped for background transcription) and a no-speech empty state when the timeline has no audio.

**Patterns to follow:** `assets-panel-store.tsx` / `tabbar.tsx` / `assets/index.tsx` tab-registration triad (exact pattern for all 10 existing tabs); the Captions panel's `PanelView`/`Section`/processing-reducer scaffold (`subtitles/components/assets-view.tsx`) for the idle/processing/ready/error STATE SHAPE only — the Captions panel runs its own bespoke transcription pipeline (`extractTimelineAudio` → `decodeAudioToFloat32` → `transcriptionService.transcribe`) and does NOT call `ensureTimelineTranscript`/`transcript-cache.ts`; do not copy its data-fetching call, only its state-shape scaffold. For data-fetching, follow `background-transcriber.tsx` / `run-director.ts`'s actual `ensureTimelineTranscript` usage instead.

**Test scenarios:**
- Happy path: opening the tab with an already-cached transcript renders immediately (cache hit, no re-transcription).
- Happy path: opening the tab with no cache triggers `ensureTimelineTranscript` and shows progress, then renders on completion.
- Edge: a timeline with no audio shows the no-speech empty state, not an error.
- Error path: transcription failure shows an actionable error state (mirror existing background-transcriber error handling), not a silent hang.

**Verification:** Tab appears in the rail with correct icon/label/position; clicking it switches the panel; all four states render correctly against a live project (manual check, since panel state depends on real transcription timing).

---

### U3. Word-level (or segment-level) selectable transcript rendering

**Goal:** Render the transcript as clickable/draggable spans and implement the click-drag selection interaction.

**Requirements:** R1, R2, R6 (KTD2, KTD4)

**Dependencies:** U2 (needs the panel shell to render into)

**Files:**
- Create `apps/web/src/features/transcription/components/transcript-text.tsx`
- Create `apps/web/src/features/transcription/transcript-selection-store.ts` (or a local `useState`/`useReducer` if scope stays small — decide during implementation per KTD2's index-tracking approach)
- Create `apps/web/src/features/transcription/__tests__/transcript-selection-store.test.ts` (if extracted as a store; otherwise cover via component-level tests)

**Approach:** Render each word (or segment, in degraded mode) as an inline span carrying its array index. Use ONE delegated `onMouseDown`/`onMouseOver`/`onMouseUp` listener set on the container (not one listener per word span) that reads the target span's index via `event.target` — a real transcript can run to thousands of words on a longer video, and per-span listeners at that count are an avoidable cost when delegation gives the identical interaction for free. `mousedown` on a span starts a selection at that index; `mouseover` on subsequent spans while the mouse button is held extends the selection to that index; `mouseup` finalizes it. A plain click (mousedown+mouseup on the same span with no drag) selects that single word/segment. Selected spans get a highlight style. Selection state is `{ startIndex, endIndex, granularity } | null`. If live testing on a long transcript later shows scroll/render jank independent of listener count, list virtualization is a follow-up, not part of this unit.

**Patterns to follow:** `selection/hooks/use-box-select.ts` for the general drag-selection interaction shape (mousedown/move/up lifecycle), adapted from box-select-on-canvas to index-tracking-on-inline-spans — the underlying mouse-event lifecycle is the same pattern, the hit-test target differs.

**Test scenarios:**
- Happy path: mousedown on word 3, drag through word 8, mouseup → selection is `{startIndex: 3, endIndex: 8}`.
- Happy path: single click on word 5 (no drag) → selection is `{startIndex: 5, endIndex: 5}`.
- Edge: dragging backwards (mousedown on word 8, drag to word 3) still normalizes to `{startIndex: 3, endIndex: 8}`.
- Edge: clicking empty space (outside any span) clears the current selection.
- Degradation: with `wordsUnavailable: true`, the same interaction operates over segment spans instead of word spans with no code-path branching in the interaction handlers themselves (only the data source differs).

**Verification:** Live check on a real project transcript — drag-select a multi-word range, confirm highlight matches the dragged span; single-click selects one word; clicking elsewhere clears selection.

---

### U4. Wire delete action end-to-end + optimistic view update

**Goal:** Connect U1's resolver/delete action to U3's selection state, with a visible Delete affordance and honest post-delete display.

**Requirements:** R3 (KTD5)

**Dependencies:** U1, U3

**Files:**
- Modify `apps/web/src/features/transcription/components/transcript-text.tsx` (or a sibling component) to add the Delete affordance (button + `Delete`/`Backspace` keyboard handling when the panel has focus and a selection exists)
- Modify `apps/web/src/features/transcription/transcript-selection-store.ts` (or wherever selection state lives) to support marking a range as optimistically removed AND to hold the shiftable local `words`/`segments` arrays (see KTD5)
- Create `apps/web/src/features/transcription/remap-transcript-timestamps.ts` (pure helper implementing KTD5's shift)
- Create `apps/web/src/features/transcription/__tests__/remap-transcript-timestamps.test.ts`
- Create/modify a "Refresh transcript" action that re-runs `ensureTimelineTranscript` and replaces the (possibly stale) displayed transcript

**Approach:** On Delete (button or keyboard), call U1's `deleteTranscriptSelection`. On success: (1) clear the selection, (2) mark the deleted span as removed in the CURRENT displayed transcript (strike-through fade-out or outright removal — implementer's call on the exact visual treatment, OQ1), and (3) per KTD5, call `remapTranscriptTimestamps({ words, segments, deletedEndSec, removedDurationSec })` to shift every remaining word/segment whose `start >= deletedEndSec` left by `removedDurationSec`, and replace the panel's local `words`/`segments` state with the remapped result — this is what keeps a SECOND delete (before refresh) resolving against correct coordinates. None of this touches the persisted transcript cache; it is local display state only. Add a small "stale" indicator once at least one delete has happened, with a "Refresh transcript" button that re-runs transcription and replaces the view with authoritative fresh data (clearing the stale indicator and superseding the local remap).

**Patterns to follow:** U1's `deleteTranscriptSelection`; the existing "Ctrl+Z to undo" messaging pattern used by the AI Director's cut review (same reassurance applies here — nothing is permanent, one undo reverts).

**Test scenarios:**
- Happy path: selecting a word range and pressing Delete removes it from the timeline (one undo) and strikes it from the view without a re-transcription call.
- **Critical regression (found during plan review — this is the unit's primary correctness test):** delete word range A (early in the transcript), then WITHOUT refreshing, select and delete word range B that originally started after A's end. Assert B's resolved time range reflects A's removal (i.e. matches the coordinates of the LIVE, already-shifted timeline) rather than B's original pre-shift timestamps — confirms `remapTranscriptTimestamps` is actually applied between deletes, not just computed and discarded.
- Happy path: after a delete, the stale indicator appears; clicking "Refresh transcript" re-runs transcription and the indicator clears.
- Edge: pressing Delete with no active selection is a no-op (no command executed).
- Integration: two sequential deletes are two separate undo steps (each ripple-delete stays its own single-undo command, per KTD3/U1 — deletes are not batched together across separate user actions), and each undo restores the timeline AND the local words/segments state to their pre-that-delete shift (undoing the second delete does not also undo the first delete's remap).

**Verification:** Live check — select and delete a real word range, confirm the timeline actually shortens by the right amount, confirm Ctrl+Z restores it, confirm the view shows the cut struck-through until refreshed. Then, in the SAME session without refreshing, delete a second range that was originally after the first — confirm it cuts the correct (post-first-delete) footage, not the pre-shift location.

---

### U5. Copy to clipboard + export to file

**Goal:** Two actions on the transcript panel: copy the full transcript to the clipboard, and download it as a plain-text file.

**Requirements:** R4, R5 (KTD6)

**Dependencies:** U2 (needs the panel and its transcript data)

**Files:**
- Modify `apps/web/src/features/transcription/components/assets-view.tsx` (or a new toolbar sub-component) to add Copy and Export buttons
- Create `apps/web/src/features/transcription/format-transcript-text.ts` (pure formatter, shared by both copy and export so the text is identical)
- Create `apps/web/src/features/transcription/__tests__/format-transcript-text.test.ts`

**Approach:** `formatTranscriptText({ segments })` produces one line per segment: `[mm:ss.s–mm:ss.s] text`. Copy uses `navigator.clipboard.writeText(formatted)` directly (mirror `copy-markdown-button.tsx`'s toast-confirmation pattern). Export wraps the same formatted text in a `Blob` and calls the existing `downloadBuffer({ buffer, filename, mimeType: 'text/plain' })` helper from `export/index.ts` — no new download mechanism.

**Patterns to follow:** `changelog/components/copy-markdown-button.tsx` (clipboard + toast pattern); `export/index.ts`'s `downloadBuffer` (reuse verbatim, do not reimplement).

**Test scenarios:**
- Happy path: `formatTranscriptText` on a 3-segment transcript produces exactly 3 lines in `[mm:ss.s–mm:ss.s] text` format, in order.
- Edge: empty transcript (no segments) produces an empty string, and the Copy/Export buttons are disabled or show an appropriate empty state rather than producing a blank file/clipboard write.
- Integration: Copy and Export both call `formatTranscriptText` (same formatter, not two divergent implementations) — verified by both producing byte-identical text for the same transcript.

**Verification:** Live check — click Copy, paste elsewhere, confirm the text matches; click Export, confirm a `.txt` file downloads with the expected filename and content.

---

## Scope Boundaries

**In scope:** transcript tab + text rendering, word/segment-range selection, ripple-delete via the existing single-undo command, copy-to-clipboard, export-to-file (plain text).

**Non-goals:**
- No in-app "paste an AI's response and auto-apply the suggested cuts" parser. The AI review step happens externally; this feature is the manual apply-surface for whatever the user (or a copy-pasted AI conversation) decides to cut.
- No insert/rearrange/reorder via the transcript — selection + delete only, matching Dan's stated request.
- No per-track selective delete UI — ripples all tracks like every other AI-CUT delete path (KTD3).

### Deferred to Follow-Up Work
- SRT/VTT export (Dan explicitly declined this round; plain text only).
- Non-contiguous (multi-range) selection.
- In-app AI-assisted "suggest cuts from this transcript" flow (a natural follow-up once the manual apply-surface is proven).

---

## Open Questions

- **OQ1 (exact visual treatment of a pending/optimistic delete):** Strike-through fade, outright removal from the list, or a collapsed "[cut]" marker — left to implementation-time judgment in U4; no product-behavior ambiguity, just a styling choice.
- **OQ2 (Delete vs Backspace vs both):** Both are reasonable; implementer's call in U4, mirroring whichever the rest of the editor already uses for element deletion (`Shift+Delete` is ripple-delete elsewhere per prior session work — confirm consistency during U4 rather than inventing a new binding).
- **OQ3 (keyboard accessibility of selection, deferred not decided):** The selection mechanic (R2/KTD2) is mouse-only (mousedown/mouseover/mouseup); there is no keyboard-only path to select a word range or a stated accessibility posture for this feature. Flagged during plan review (design-lens). Given this is a single-user internal tool at this stage, mouse-only is an acceptable v1 scope cut — but it is a deliberate deferral, not an oversight, and should be revisited if VibeCut gains other users.
- **OQ4 (does the external-AI round-trip actually work in practice?):** The feature's stated purpose assumes a user can take an external AI's cut suggestions (however it phrases them) and reliably re-locate the same words in the transcript view to select and delete. Flagged during plan review (adversarial) as unvalidated. No implementation change follows from this — it's a live-usage question, not a build decision — but Dan should sanity-check the round-trip on a real transcript early rather than assuming it's frictionless once U1-U5 ship.
- **OQ5 (does the stale-indicator + "Refresh transcript" affordance earn its keep?):** KTD5's local remapping already makes the refresh button unnecessary for correctness between individual deletes — it exists only for freshness (e.g. resyncing word-boundary drift after many edits). Once U4 ships and gets real usage, check whether users ever actually hit staleness in practice; if the optimistic strike-through is sufficient on its own, the stale-indicator + refresh button may be pulling its weight for nothing and could be simplified or removed. Revisit after a few sessions of real use, not at ship time.

---

## Verification

- `bunx tsc --noEmit` = 0 in `apps/web`.
- New unit tests green: `resolve-selection-to-range`, `delete-transcript-selection`, `remap-transcript-timestamps`, `format-transcript-text`, and any selection-store tests from U3.
- Live (Dan): open the Transcript tab on a real project, drag-select a word range, delete it, confirm the timeline shortens correctly and Ctrl+Z restores it; delete a SECOND range (originally located after the first) without refreshing and confirm it cuts the correct post-shift footage; confirm Copy and Export both produce the expected readable text.
