# TO-VERIFY — live checks pending Dan's testing

Everything below is **shipped + committed** (tsc + lint clean, logic unit-tested where testable) but **not yet live-verified by Dan** on real footage. Branch: `feat/director-dupword` (dev server: `framecut-director` launch entry → localhost:3000). Tick items off as you confirm them.

## Long-video performance + transcription/preview (2026-06-20, branch `feat/director-importance`, plan `docs/plans/2026-06-20-001-...`)
Run **AI CUT → AI Director** on the long (16-min) recording that surfaced these. Pure cores are bun-tested (probe slice, analysis-model selector, streaming resampler, seek-supersede); the rest is browser-only.
- [ ] **U1 — single transcription pass.** The `[transcription] …word-level…falling back` warning appears ONCE and transcription does NOT run twice. On whisper-small the probe (~20s) catches the cross-attention failure before any full word pass. Wall-clock should be roughly half the doubled-pass time.
- [ ] **U2 — honest progress.** Within seconds of decoding, the status reads "Transcribing your video — Ns elapsed (long videos take a few minutes)", NOT "Initializing speech model — 903s". The elapsed counter advances during transcription.
- [ ] **U5 — faster model on long sources.** A >5-min timeline transcribes with **whisper-tiny** (faster); a short clip still uses **whisper-small**. Captions (Subtitles panel) are unchanged. Eyeball whether Tiny's transcript is still good enough for cut quality — if cuts get noticeably worse, raise `ANALYSIS_TINY_THRESHOLD_SECONDS` or revert to Small.
- [ ] **U4 — no audio OOM.** The 16-min source decodes for the Director WITHOUT the `createBuffer`/allocation crash at "Extracting timeline audio". Memory stays bounded. Also sanity-check that **export** audio still sounds right (export path kept the offline render — should be unchanged). Possible risk: linear-resample aliasing slightly degrades the 16k analysis audio → if transcription accuracy drops oddly, that's the suspect.
- [ ] **U3 — preview unfreezes (NEEDS RUNTIME CONFIRMATION).** Scrubbing the playhead across the cut 16-min timeline now UPDATES the preview frame (no freeze on frame 1). **This is the one fix I could not runtime-verify** — the root cause (same-time RAF repeats superseding a slow deep seek) is high-confidence from tracing + `window.__wasmPanic` being empty, and the fix (supersede by time, not count) is unit-tested, but confirm it on the actual long timeline. If it STILL freezes, capture console + tell me — do not assume the hypothesis held.

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

## Editor sweep — Cursor feedback (U4)
Sweep the cursor across the preview canvas and the timeline (no tool armed unless noted):

- [ ] **Canvas hover cursor** — hovering a selectable element on the preview shows the **move** cursor; hovering a **text** element shows the **text** cursor (hinting double-click-to-edit); over empty canvas it's the default arrow. While space-pan is armed the **grab/grabbing** pan cursor still takes precedence.
- [ ] **Clip grab cursor (idle)** — hovering a timeline clip body shows the **grab** (open-hand) cursor and a faint **brightness** lift on hover — distinct from the blue selection ring. The left/right resize handles still show **w-resize / e-resize** (unchanged).
- [ ] **Grabbing during drag (no flicker)** — press-drag a clip: the cursor stays **grabbing** for the WHOLE drag, even as the pointer leaves the clip rect and crosses other tracks/labels (no flicker to the underlying cursor). On drop/cancel it restores to normal.
- [ ] **ew-resize during resize** — drag a clip's edge handle: the cursor stays **ew-resize** for the whole resize gesture and restores on release/cancel.
- [ ] **Forward-tool track cursor** — press **A** (Track Select Forward): the track surface shows the distinguishing **e-resize** cursor; disarm the tool and it reverts.
- [ ] **Body cursor always restores** — after ANY drag/resize (commit, cancel via Esc, a drag that snaps back within threshold, or navigating away mid-gesture) the global page cursor returns to normal and text selection works again — the body cursor is never stuck.

## Editor sweep — Handle geometry & text-resize (U5)

**Handle viewport-clip (full-bleed rotation/top handles) — buildable, shipped:**
- [ ] **Rotation handle grabbable on a full-bleed element** — select an element that fills the whole canvas (e.g. a full-frame background image/video). Its **rotation** handle (the round icon ~24px above top-center) and the **top-left/top-right corner** handles are now visible and grabbable — they paint just past the canvas top edge instead of being clipped away.
- [ ] **Handles don't escape into neighbor panels** — those edge handles paint at most ~36px (`HANDLE_OVERLAY_HEADROOM_PX`) past the viewport top/bottom; they do NOT spill over the preview toolbar, the panel border, or adjacent panels.
- [ ] **Scene still clips (zoom in)** — zoom the preview past 100% so the canvas is larger than the viewport: the rendered scene + letterbox are still clipped at the viewport edge (no canvas bleed). Pan around — still clipped. (The scene moved into its own `overflow-hidden` wrapper; only the handle overlay escapes.)
- [ ] **Masks unaffected** — enter the Masks tab on an element: mask handles/outline render correctly (the mask-handle root went `overflow-visible` too).
- [ ] **Normal centered elements unchanged** — a normally-sized, centered element's handles look and grab exactly as before.

**Narrow-clip resize-handle overlap — buildable, shipped:**
- [ ] **A 1–2-frame clip is still movable** — zoom the timeline so a clip renders narrower than ~16px, select it: only a single thin (4px) RIGHT resize handle shows; the rest of the clip body is a **move** zone (press-drag the body to reposition it). Previously the two 8px handles covered the whole body and you could only resize, never move.
- [ ] **Narrow clip still resizable** — that thin right handle still trims the clip (e-resize cursor).
- [ ] **Normal-width clips unchanged** — a normal clip still shows BOTH (8px) left + right handles at `-left-1`/`-right-1` as before.

**Text-resize discoverability (ANCHOR — gated on a live repro you must confirm):**
- [ ] **Placing text leaves handles visible** — arm the Text tool, click on the canvas to place text. The new text element is auto-selected and its **transform handles are visible immediately** (static analysis confirms `InsertElementCommand` returns a selection result and placement does NOT auto-enter edit mode). You should be able to resize from a corner right away.
- [ ] **Edit-mode affordance** — double-click a text element to enter caret-edit mode: a **dashed ring** now outlines the editable box and a small **"Esc or click away to resize"** hint appears just below it. Press Esc (or click away) → handles return → resize from a corner works.
- [ ] **ANCHOR (Dan's report) — confirm the exact repro:** place text → try to resize from a corner. **Does placing text drop you into edit mode (no handles)?** Per static analysis it should NOT — placement auto-selects with handles visible, and only double-click enters edit mode. Confirm this fix (the edit-mode ring + hint) makes resize reachable/discoverable. **If the cursor / handles are ALSO missing during plain SELECTION (not edit mode), REOPEN** — that would be a live-only bug static analysis could not reproduce (the cursor pipeline + handle render are correct in isolation; U4 already wired the `move`/`text` hover cursor). In that case capture which state you're actually in (selected vs editing) when the corner-resize cursor is missing.

## Editor sweep — Accessibility (U6)
Best checked with a screen reader (VoiceOver / NVDA) plus a keyboard pass:

- [ ] **Icon buttons named** — the preview Play/Pause button announces "Play"/"Pause" (state-dependent) and Fullscreen announces "Toggle fullscreen"; the timeline zoom in/out buttons announce "Zoom in/out timeline"; the assets-bin Assemble / view-mode / sort icon buttons announce their action (not an empty/"button" label). Tooltips still show on hover.
- [ ] **Toggles announce pressed** — the timeline toolbar toggles (Auto snapping, Ripple editing, Audio waveforms, Linked selection, Bookmark) expose `aria-pressed` — a screen reader says "pressed"/"not pressed" as you toggle them, and each has an accessible name (the tooltip string). The momentary buttons (Split, Duplicate, Delete, etc.) do NOT report a pressed state.
- [ ] **Ruler no longer a frozen slider** — the timeline ruler is no longer announced as a slider stuck at 0 (it dropped `role="slider"`/`tabIndex`/`aria-value*`). The real slider is the playhead (still announces live position + arrow-key seek). Mouse scrub on the ruler is unchanged.
- [ ] **Director modal — checkbox styled + described** — open the AI Director review modal: each op row uses the app `Checkbox` (matches the rest of the UI, clicking the row toggles it), and the dialog has an accessible description ("Review each proposed change and apply the ones you want — Ctrl+Z restores everything") read by the screen reader on open. (Dialog padding is handled separately in U7.)
- [ ] **Alt+← / Alt+→ nudges a selected clip one frame** — select a clip, press **Alt+ArrowLeft/Right**: it moves exactly one frame (collision/track rules match a mouse drag — an overlap on the destination blocks the move). Holding the key repeats the nudge. The selection stays on the moved element(s). Ctrl+Z undoes each nudge.
- [ ] **Unbound actions appear in the Hotkeys editor** — Settings → Hotkeys: `Stop playback` and `Toggle ripple editing` (and any other action shipped without a default key, e.g. the new nudge actions show their Alt+Arrow keys) now appear in the list with a **"Not set"** record button so they can be bound. Previously the editor listed bound keys only and hid them.

## Editor sweep — Visual polish (U7)
Mostly compile/visual-trivial; sweep the editor once:

- [ ] **Theme icon reflects mode** — toggle the theme: in **dark** mode the button shows a **sun** (Sun03Icon → "switch to light"), in **light** mode a **moon** (Moon02Icon → "switch to dark"). The icon now flips (previously frozen on the sun); the sr-only label ("Light"/"Dark") matches the icon's target mode.
- [ ] **Director review dialog has padding** — open the AI Director review modal (AI CUT → AI Director): its content (title, description, op rows, Cancel/Apply) is no longer flush against the dialog border — there's `p-6` breathing room all around.
- [ ] **Variant picker dialog has padding** — RUN HYPERFRAMES (authored engine) → "Versions ×3" → open the picker: same `p-6` padding; the version cards no longer touch the dialog edge.
- [ ] **Source-audio context-menu icon reflects state** — right-click a video clip with source audio: the "Separate / Re-merge source audio" item now shows an **Unlink** icon when the source audio is already separated and a **Link** icon when it isn't (previously both states showed a frozen scissor icon).
- [ ] **"Export clips" is disabled** — right-click a bin asset: the **Export clips** item is now greyed-out / non-clickable (it had no handler — a silent no-op — and now matches the disabled "Replace media" convention).
- [ ] **Promotions tooltip text color** — (compile-trivial) the `promotions` tooltip variant uses a valid `text-red-900` (was the invalid `text-redb-900`, which Tailwind dropped → no color). The light-mode promotions tooltip text is now the intended dark red.
- [ ] **HyperFrames Stop button placed correctly** — start a RUN HYPERFRAMES run: the destructive **Stop** button appears next to the run button (in the flex row, `gap-1` spacing) and aborts the run. It's no longer a stray child inside the Radix `<Tooltip>` (between trigger and content) — the run-button tooltip still shows on hover with no layout glitch.
- [ ] **Font params use the full FontPicker** — select a text/template element with a font property; the font control is now the full **FontPicker** popover (Google Fonts + system fonts + search, with live previews), not the old 12-font hardcoded dropdown. Picking a font previews + commits it (same onPreview/onCommit path); the value shows in the trigger.
- [ ] **Timecode field doesn't trap you on invalid input** — (low-nit) click a timecode to edit, type garbage (e.g. "abc"), then click away: the field now **reverts to the displayed time and exits edit mode** (was: stuck in the red error state with Escape the only way out). Pressing **Enter** on invalid input still shows the inline error (active commit gets feedback); a valid entry still commits on blur or Enter.

## Editor sweep — Error/edge hardening (U8)
The pure pieces (empty-export decision, audio finite-duration guard) are unit-tested (`export/__tests__/can-export.test.ts`, `media/__tests__/duration.test.ts`); the toast + Director paths are live-verify:

- [ ] **Empty-project export is blocked before the save dialog** — open Export on a project with a **0-duration timeline** (no clips, or all clips trimmed to nothing): the **Export button is disabled** (with a "Add footage to the timeline to export." hint), and if reached programmatically `handleExport` shows `"Add footage to the timeline first"` and returns **without opening the OS save-location picker**. Previously you picked a save destination first, THEN got "Project is empty". Add a clip → Export re-enables and the picker shows as normal.
- [ ] **Malformed / streaming audio imports with a sane default** — import an audio file whose `HTMLMediaElement.duration` is non-finite (Infinity for a live/streaming source, or 0 for a malformed/truncated file): it imports as a normal asset using `DEFAULT_NEW_ELEMENT_DURATION` (no throw, no zero-length element on paste/drop to the timeline). A normal finite-duration audio file imports with its real length (unchanged). *(Hard to hit with everyday files — a 0-byte/truncated `.mp3` or a live HLS handle is the repro; the finite-check itself is unit-tested.)*
- [ ] **Zero-import shows a neutral (not green-success) toast** — drop ONLY unsupported files (e.g. a `.txt` + a `.zip`) into the bin so 0 assets are actually added: you now see per-file **error** toasts AND a single neutral **info** toast "No media assets were uploaded" — NOT the old **green success** "No media assets were uploaded" that contradicted the errors. A normal import (1+ added) still shows the green success ("X media assets have been uploaded").
- [ ] **Director cancel is signposted as reversible (MINIMAL fix — NOT one-undo rollback)** — run **AI CUT → AI Director**, let it assemble + remove silences + open the Review modal, then **Cancel** (or click outside / Esc / the X). The timeline is **still mutated** (footage assembled, silences cut) — this fix does NOT roll it back. Instead you now get a neutral toast: **"Director: review cancelled — Footage was assembled and silences removed — Ctrl+Z to undo."** Confirm the toast fires on every dismissal path (Cancel button, outside-click, Esc, the X), and that **Apply** does NOT also fire this cancel toast (only its own success/"nothing applied" toast). **Note on undo depth:** `assembleBinToTimeline` and `runRemoveSilences` each execute their own command(s) internally and do NOT expose them, so it is currently **N+1 undo entries**, not a single Ctrl+Z. Batching them into one `BatchCommand` (true one-undo rollback-on-cancel) needs both functions refactored to RETURN their commands instead of executing — that's the flagged **follow-up** (the plan said ship the safe cancel toast now, defer the risky pipeline refactor). So: pressing Ctrl+Z repeatedly DOES walk back the assemble+silence steps; a single Ctrl+Z restores only the last step.

## Bug fix — AI CUT createBuffer crash on long timelines
- [ ] **Long-timeline AI CUT** — re-run **AI CUT → AI Director** on the ~21-min timeline that crashed with `createBuffer(2, 57460830, 44100) failed`. It should get PAST "Extracting timeline audio…" now (analysis audio mixes at 16kHz mono ≈ 83MB instead of 44.1kHz stereo ≈ 459MB). Transcription/cut quality should be unaffected (every consumer already resampled to 16kHz). Short timelines unchanged.

## AI Director — repeated-phrase cuts (cut-quality)
Re-run **AI CUT → AI Director** on the continuous recording where repeats survived:
- [ ] **Verbatim repeats caught** — when you said the same ~4+ word phrase twice nearby, the EARLIER instance shows as a cut row labeled *Repeated phrase "…"* with a **Repeat** badge (keeps the last take). Triples cut the first two.
- [ ] **No false repeats** — a phrase repeated far apart (a deliberate callback / outro recap) is NOT cut (60s window); short/common 3-word overlaps aren't cut (4-word minimum).
- [ ] **Paraphrased repeats** — re-explaining the same point in different words is now in the LLM cut prompt (REDUNDANT RESTATEMENTS + DEAD TIME); the LLM should propose more cuts for redundancy/fumbling. (LLM judgment — verify it's noticeably more aggressive; if it still leaves obvious redundancy, the detector/prompt thresholds are tunable.)
- [ ] **Per-category taste** — rejecting repeat cuts across runs makes the next run propose fewer (the "repeated-phrase cuts" taste line, separate from duplicate-word cuts).
- [ ] **Dead-air cuts** — the "figuring something out" mutter time (a dense run of *um/uh/okay…* with little content, ≥3 hesitations over ≥2.5s) shows as a cut row labeled *Dead air — N hesitations…* with a **Dead air** badge. It's conservative by design: a 2+ word real-content gap breaks the run (it never cuts real speech between two clusters), so it may UNDER-cut — if it leaves obvious mumbling in, tell me and I'll loosen the `MAX_BRIDGE_CONTENT` / span thresholds. Rejecting dead-air cuts trains its own taste line.

## AI Director — take-aware redundancy (asset-context, branch `feat/director-asset-context`)
The deterministic foundation (U1–U4) + the orchestrator wiring + keeper-safe merge (U6) are shipped (tsc + lint clean, 148 director unit tests pass). The LLM-prompt catalog enrichment (U5) and the review-modal UX for take/near-tie rows (U7) are **deliberately held** behind this gate. **This section IS the plan's R9 validation** — run it on your real multi-take footage before I wire U5.

Drop **several take clips of the same lines** into the bin, then run **AI CUT → AI Director**:
- [ ] **Cross-take dedup** — when two clips cover the same line, the weaker/earlier take shows as a cut row reading *Alternate take of "…" — kept the later/clearer version (NN% match)* with a **Take** badge. Accept it and apply: the kept take survives; the redundant one is removed.
- [ ] **Keeper safety (the P0 guard)** — across a cluster of 2–3 takes, you NEVER lose every copy of a line. Exactly one take survives even if the LLM and the deterministic layer disagree on which take to keep.
- [ ] **Far-apart repeat within one clip** — a line restated much later in a single recording shows as a *Repeat*-badge cut, but at **low confidence** (easy to reject) so a deliberate callback/recap isn't aggressively removed.
- [ ] **Near-ties are surfaced, not auto-cut (U7)** — two equally-good (equally loud) takes produce **no** destructive removal; instead an amber **"Near-identical takes — pick one to cut yourself"** panel lists each take's time range + text so you can trim the weaker one manually. Confirm no coin-flip take is silently deleted on apply.
- [ ] **Single-take footage unchanged** — a single continuous recording with no cross-clip repeats produces **no new flags** from this layer (the take-cluster path is a no-op when nothing clusters; the rest of the Director behaves exactly as before).
- [ ] **R9 dial check** — count the real duplicates in your footage by hand and compare against what got flagged. If genuine repeats **survive** (likely true paraphrase — different words), that's expected of the lexical layer and is the LLM-channel's job; if **distinct** lines get merged, tell me and I'll tighten the dials (`HIGH_SIMILAR`, `AUDIO_EPSILON`, `MIN_SAME_ASSET_GAP_SEC` are one-line constants; local embeddings are the documented escalation).

**LLM prompt enrichment (U5) + review UX (U7) — also shipped on this branch:**
- [ ] **Asset catalog in the prompt (U5)** — with ≥2 clips in the bin, the Director's planning prompt now opens with an `ASSET CATALOG` block (one line per clip: name, duration, line count, how it opens/closes) so the LLM's own cut/take judgment is grounded in the bin. A `grp` column marks alternate-take rows and tells the LLM not to re-cut them. **Single-clip input is byte-identical to before** (no catalog block, no grp column) — confirm a one-recording run is unchanged.
- [ ] **Kept-line + match % on take rows (U4/U7)** — each take/repeat row reads *"Alternate take of '…' — kept the later/clearer version (NN% match)"* so you can vet the cut without hunting for the other take.
- [ ] **Rejected-state clarity (U7)** — UN-checking a **Take** row shows *"· Keeping both takes"*; un-checking a **Repeat** row shows *"· Keeping the restatement"* — so you understand that rejecting a de-dup keeps the duplicate. Plain filler/cut rows show no such hint.

## AI Director — keep-side Phase B (importance signal, branch `feat/director-importance`)
The keep-side **pure engine** (U1 emphasis/anchor score, U5 inverse-apply ranges, U6 contiguity budget-select) + **Phase B** (the score wired into the *normal* Director: imp column, capped protection, LLM keep-pass) are shipped (tsc + lint clean, all director/hf-bridge unit tests pass). **The Highlight mode UI (Phase D) is NOT built** — gated by this validation + the LLM-keep-pass-role decision (plan Open Questions). **This IS the R9 validation vehicle** — the imp column makes the score observable; run it on real footage before Phase D.

Run **AI CUT → AI Director** on a normal recording (single recording is fine):
- [ ] **imp column reaches the planner** — the Director prompt now carries an `imp` (0-1) column per line; the LLM is told to lean toward keeping high-imp lines and cutting low-imp ones, and to emit `keep` ops on load-bearing spans. (Not directly visible in the UI — confirm via the cut quality / a debug log of the prompt if you instrument it.)
- [ ] **R9 pick-quality check** — eyeball whether the high-imp lines actually correspond to the *good* parts on your footage. On flat/monotone delivery the score flattens (emphasis-anchor, not taste — by design); if the top-imp spans aren't the good bits, that's the signal that Highlight (Phase D) needs the **LLM keep-pass as primary**, not the deterministic floor. Tell me what you see — the weights (`W_EMPHASIS`/`W_RATE`/`W_LEXICAL`, the wpm band, `PROTECT_FLOOR`) are one-line dials.
- [ ] **Protection doesn't null the cut** — on dense/energetic footage the Director still proposes a *non-trivial* cut (protection is capped at ≤8 spans / ≤40% of the timeline — it shouldn't protect everything). If the Director suddenly cuts almost nothing, the cap needs lowering.
- [ ] **No stray "Keep" rows** — the review modal shows cut/take/repeat rows as before; the LLM's `keep` ops are used silently for protection and do NOT appear as no-op checkboxes (KTD6).
- [ ] **Cut-only behavior unchanged where importance is absent** — the hf-bridge functions stay byte-identical without an imp score (regression-tested); the normal Director now always includes importance, so expect a slightly different (importance-aware) cut than before — that's the intended Phase-B lift.

## AI Director — Highlight mode / Phase D (branch `feat/director-importance`)
The keep-side is now **fully built** (U1–U8): the pure engine, Phase B (normal-Director signal), and **Phase D — the Highlight mode** (tsc + lint clean; pure cores bun-tested; 225 director/hf-bridge tests pass). The UI is **live-verify only** (bun has no DOM). Crossed the R9 gate per your call; LLM-keep-pass defaulted to **primary** for the un-budgeted highlight.

Run **AI CUT → Highlight — keep the best parts**:
- [ ] **Duration dialog** — selecting "Highlight" opens a small dialog with an optional "Target length (seconds)" field + "Build highlight" (NOT a bare menu item). Blank = keep all the good parts; a number (e.g. 60) = fit a ~Ns short.
- [ ] **Keep review surface (inverted semantics)** — the modal reads **"Highlight — review what to keep"**, rows show **Keep/Drop** (accept = keep, the OPPOSITE of cut mode), with a live **"keeping N of M · Xs of Ys (−Z%)"** preview that updates as you toggle. Bulk **Select all / Deselect all**. Confirm you don't confuse it with the cut modal.
- [ ] **Inverse apply** — "Apply highlight" KEEPS the checked spans and cuts everything else; one **Ctrl+Z** restores the whole timeline. Empty selection disables Apply ("Select at least one span to keep") — it never deletes the whole video.
- [ ] **Budget = contiguity-biased short** — a ~60s target returns a *coherent* cut (contiguous-ish runs), not a jump-cut salad of scattered 1s fragments. If it's choppy, the contiguity/min-span dials (`keep-select.ts` MIN_SPAN_SEC / MAX_RUNS) need tuning.
- [ ] **Un-budgeted = LLM-primary** — with no budget, the kept set is the LLM's load-bearing picks (keep ops) ∪ the emphasis floor; on `claude-code`/offline it degrades silently to the deterministic floor (no crash).
- [ ] **R9 pick-quality (the real test)** — are the kept spans actually the good parts? On flat delivery the deterministic floor flattens by design — that's when the LLM-primary path matters. Tell me if the picks are weak; weights are one-line dials.

## Word-timestamp blocker fix (2026-06-20, branch `feat/director-importance`)
The cross-attention crash that blocked **every** AI Director/Highlight run is fixed by a **graceful degrade**: word mode now tries `return_timestamps:"word"`, and on the "Model outputs must contain cross attentions … output_attentions=True" error falls back to a segment-level decode instead of throwing (worker.ts), flags the result `wordsUnavailable`, and the transcript cache treats that as a hit so it never re-transcribes the same timeline. tsc + lint clean; 207 director unit tests pass. **Browser-only — live-verify on real footage:**
- [ ] **AI CUT → AI Director completes on a real recording** — it no longer dies at "Transcribing…" with the cross-attention error; the plan/review modal appears.
- [ ] **AI CUT → Highlight completes** too (same `ensureTimelineTranscript({wantWords:true})` path).
- [ ] **Degrade is one-time / cached** — first Director run on a fresh timeline does the (possibly double) transcription once; a second run on the same timeline is instant (cache hit, not a re-transcribe). Check the console for the one `[transcription] This model can't produce word-level timestamps…` warning — it should appear at most once per session.
- [ ] **Word-detectors silently no-op when degraded** — on the default `onnx-community/whisper-small` (which triggers the degrade) the duplicate-word/filler/dead-air/phrase-repeat cuts simply produce nothing; the LLM cut, pacing, take/redundancy, and the keep-side importance score still work. If you WANT the word detectors back, the fix's option 2 is open: configure a Whisper export that ships cross-attentions (`models.ts`) and re-test — degrade will then keep words instead of dropping them.
- [ ] **Captions unaffected** — the subtitles/caption flow was always segment-level (no words requested); confirm caption generation still works.

## Open follow-ups (not yet built)
- [ ] **Long EXPORT hits the same createBuffer wall (latent).** `createTimelineAudioBuffer`'s export path still mixes at 44.1kHz STEREO (it needs full quality), so exporting a ~21-min+ video would throw the same oversized-`createBuffer` error — now surfaced as an actionable "too large (~N min)" message instead of a raw DOMException, but still a hard fail. The real fix is **chunked audio mixing** (mix the timeline in windows + stream to the encoder, never allocating the full buffer) — a bigger, separate change to the shared `media/audio.ts` mix path. Same root cause as the AI-CUT crash above.
- [ ] **#6 playback stutter — BLOCKED on the wasm toolchain (vision-round U5 investigation).** Root-caused to the Rust compositor texture pool (`rust/crates/compositor/src/texture_pool.rs`), still unconfirmed as the *dominant* cause — needs pool-size instrumentation before any fix (don't change Rust blind). **Why it's blocked here:** the running app consumes the **published npm `opencut-wasm@^0.2.10`** (`apps/web/package.json`), not a local build — every web import is `from "opencut-wasm"`, nothing imports `rust/wasm/pkg`, and that dir was never built. This worktree also has **no Rust toolchain** (no cargo / wasm-pack / rustc). So instrumenting the Rust would (a) not run in the app and (b) not even compile-check here — exactly the unverifiable Rust the plan's gate forbids. **To unblock (needs a machine with the Rust + wasm-pack toolchain):** (1) add a pool-size readout to `texture_pool.rs` (count `available` + per-`(w,h)` bucket sizes), expose it via `rust/wasm/src/perf.rs`, surface it in `apps/web/src/diagnostics/render-perf.ts`; (2) `bun run build:wasm` → repoint `apps/web` at the local `rust/wasm/pkg` (or `bun run publish:wasm` to bump the npm package) and rebuild; (3) capture a long-session trace (`window.__renderPerf = true`) to confirm the pool climbs vs plateaus; (4) only then ship the cap/evict fix. Plan: `docs/plans/2026-06-18-002-feat-director-vision-v0-plan.md` (Phase B / KTD-6).
