# 20-Minute Smoke Test

## The cut flow

**1. Run AI CUT on a talking-head clip**
Expect: Menu shows two options only ("AI CUT", "Remove silences"). Review modal opens with a "Director's cut ready - N proposed changes" toast.
- [ ]

**2. No sliver clips after Director apply**
Expect: Review the cuts, hit Apply, then scrub the timeline. No tiny 1-2 frame remnants between cuts; clips butt cleanly.
- [ ]

**3. Join rows read sensibly**
Expect: Any "Join" or "Stranded between two cuts" rows in the review match what's actually left behind on the timeline after the run.
- [ ]

**4. Error card on a failed run**
Expect: Force a failure mid-run (kill network, or force an error some other way). A persistent card appears in the dock with the error message and a "Retry" button, not a fleeting toast you can miss.
- [ ]

**5. Review defaults match your taste (rounds 9-10)**
Expect: In the review list, your coherent trailing musings show as unchecked "Speculation" rows (kept by default), mid-flow "um/uh" fillers start unchecked while fillers next to a real pause start checked, and clicking a row's timestamp jumps 1 second before the cut and plays. Does each default match what you would have picked?
- [ ]

**16. Second-pass stage label shows in run feedback (round 14)**
Expect: Run AI CUT on a real talking-head clip. In the run-feedback toast sequence, watch for "Second pass: reading the assembled cut..." followed by "Final read: verifying the assembled cut...". Both stage labels should appear in the feedback as the run progresses.
- [ ]

**17. Second-pass rows show as unchecked offered rows (round 14)**
Expect: In the review dock after a full Director run, look for rows whose reason begins with "Second pass:". These should be displayed as UNCHECKED offered rows (defaultAccept:false), not auto-checked.
- [ ]

**18. Clicking the timeline during playback pauses at the click point (round 14)**
Expect: Start playback on a clip. While playing, click the timeline ruler at a different point. Playback should PAUSE immediately, and the playhead should stay at the point you clicked, not jump elsewhere. (Bookmark-marker clicks and keyboard seeks still seek without pausing; this applies only to direct timeline ruler clicks.)
- [ ]

**19. Short barely-edited clip skips second-pass stage (round 14)**
Expect: Run AI CUT on a very short clip or a clip with minimal edits needed (few cuts proposed). If the second pass has nothing new to find, the run should skip the second-pass stage entirely and go straight to final read. No "Second pass: ..." label should appear in the feedback for clips where P2 proposes zero new changes.
- [ ]

## The timeline

**6. Linked-clip extend gesture**
Expect: Extract audio from a video clip (right-click, "Extract Audio"). Grab the video's right edge, drag right. Audio extends with it, stays in sync.
- [ ]

**7. Timeline snap-back and head gravity**
Expect: Drag the first clip away from the start. Within about 2 seconds of 0:00 it snaps back to the start; farther than that it stays where you drop it. No more "cannot move a clip off the head at all".
- [ ]

**8. Forward-select drag does not explode tracks**
Expect: Press A, click and drag from early on the timeline to grab everything forward. Drag to a new spot. Video track count stays 8 or under. (The bug was 100+ tracks suddenly.)
- [ ]

**9. Multi-select bin drag separates audio**
Expect: Select 2-3 videos in the Assets panel (Ctrl+click). Drag the group onto the timeline. All land with audio separated onto a shared audio track below. Ctrl+Z removes everything together.
- [ ]

## New this week

**10. Export the 29-minute project (THE critical check)**
Expect: Click Export on your real long project. Save dialog opens before the encode starts. Progress bar moves through the audio stage instead of freezing. No hang, no memory error. The final video plays cleanly with sound in sync at the end. This is the one fix that was only proven synthetically; your real project is the true test.
- [ ]

**11. Place text, resize from corner**
Expect: Text tool, click on canvas to place. Corner handles appear immediately. Grab a corner and drag to resize without double-clicking or mode switches.
- [ ]

**12. Masks: draw, handle drag, and feather**
Expect: Select a clip, open Masks tab. Draw an ellipse by click-drag; dashed outline appears on preview. Drag feather handle to blur the edge. Try a pen mask (click to place points, click-drag for curves). Do handles feel responsive?
- [ ]

**13. Transcript: click word and export**
Expect: With a transcribed video, open the Transcript tab. Click a word; the playhead jumps to that moment. During playback the current word highlights. Use the Export menu (top of the tab) to save .txt and .srt; both download with the transcript and timecodes.
- [ ]

**14. Add a Solid, recolor it**
Expect: Media tab, click "Solid color" (next to Import). A full-frame color card lands at the playhead in one click, no dialog. Select it; the Properties panel opens on a Color tab whose picker recolors it live. Add a second solid and recolor it; the first one keeps its own color.
- [ ]

**15. Left panel tabs and AI CUT menu**
Expect: Left panel shows exactly 6 tabs: Media, Text, Shapes, Captions, Transcript, Settings. Sounds, Effects, and HyperFrames are hidden. AI CUT menu shows 2 options only.
- [ ]

## If something fails

For any check that does not work as described, tell the AI three things:

1. **What you did** - the clicks or drags, step by step
2. **What you saw** - the actual result, error message, or unexpected behavior
3. **Clip time** - playhead position when it happened (if relevant to the test)

Each failure becomes a named bug with a repro. Anything that passes gets checked off
here AND closed out of the long TO-VERIFY backlog for good.
