# Remotion media pack format v1

Date: 2026-08-03. Task: T20.3 (round 20, candidate (a) Remotion integration).
Status: DRAFT CONTRACT. The dan-video Remotion kits live outside this repo
(`D:\Hermes\remotion-v2`); nothing kit-side was read while writing this. This
document IS the contract until Dan validates consumption kit-side. Bump
`version` in the manifest on any breaking change.

## What a pack is

One export of a VibeCut timeline, packaged so an external Remotion kit can
rebuild the edit programmatically without talking to VibeCut:

- an EDL of the timeline (`edl.json`)
- the transcript with word timings (`transcript.json`, omitted when the
  project has no exportable transcript)
- every media file the timeline references, source footage and AI-generated
  overlays alike (`media/`)
- a manifest tying all of it together (`manifest.json`)

## Packaging: directory first, JSON bundle fallback

Two physical shapes, one logical content:

1. **Directory (primary).** Where the File System Access API's
   `showDirectoryPicker` exists (Chromium), the pack is written as a real
   folder. Media stays binary on disk, the kit can `fs.readFile` straight
   from it, and size is unbounded in practice. Layout:

   ```
   <picked dir>/
     manifest.json
     edl.json
     transcript.json        (only when a transcript exists)
     media/
       <assetId>-<slug>.<ext>
   ```

2. **Single JSON bundle (fallback).** Where the directory picker is missing
   (Firefox, Safari), one `<project>.remotion-pack.json` file:

   ```json
   {
     "format": "framecut-remotion-pack-bundle",
     "version": 1,
     "manifest": { "...": "same manifest object as the directory shape" },
     "files": [
       { "path": "edl.json", "encoding": "utf8", "text": "..." },
       { "path": "transcript.json", "encoding": "utf8", "text": "..." },
       { "path": "media/<assetId>-<slug>.<ext>", "encoding": "base64", "data": "..." }
     ]
   }
   ```

   `path` values are exactly the directory-shape relative paths, so a kit
   unpacks the bundle into the directory shape and then reads only that.

   **Size tradeoff (accepted for v1):** base64 inflates media bytes by ~4/3
   and the whole pack must fit in one in-memory JSON string, so the bundle
   is a poor fit for large source footage (a 500 MB project becomes a
   ~670 MB+ JSON document). This is tolerated because the fallback exists
   only for non-Chromium browsers; the primary path is the directory write.
   If kit-side validation shows non-Chromium export matters, v2 should add a
   zip container (no zip library is in the dependency tree today, which is
   the only reason v1 does not use one).

## EDL choice: JSON, not CMX3600

The EDL is `framecut-edl` JSON. CMX3600 was rejected:

- The consumer is a programmatic JS kit, not a classic NLE. CMX3600's
  fixed-width records, 8-character reel names, and frame-quantized timecode
  addressing (with drop-frame ambiguity) are pure loss and parse risk for a
  consumer that can read typed JSON natively.
- The pack must carry data CMX3600 cannot express at all: per-clip source
  trims in seconds, retime rate, linked-clip ids, alpha flags, and
  `framecutAi` composition references.
- VibeCut times are tick-based floats; CMX3600 would force a lossy
  timecode round-trip. JSON keeps seconds as plain numbers.

If a classic-NLE interchange is ever wanted, that is a separate exporter,
not a revision of this one.

## `manifest.json`

```json
{
  "format": "framecut-remotion-pack",
  "version": 1,
  "generatedAt": "2026-08-03T14:00:00.000Z",
  "generator": "vibecut",
  "project": {
    "id": "project uuid",
    "name": "My edit",
    "fps": { "numerator": 30, "denominator": 1 },
    "canvas": { "width": 1920, "height": 1080 },
    "durationSec": 12.5
  },
  "files": {
    "edl": "edl.json",
    "transcript": "transcript.json"
  },
  "styleProfile": null,
  "tracks": [
    {
      "id": "track id",
      "name": "V1",
      "role": "main-video",
      "clipCount": 3,
      "durationSec": 12.5
    }
  ],
  "media": [
    {
      "id": "asset id",
      "name": "interview.mp4",
      "path": "media/<assetId>-interview.mp4",
      "kind": "video",
      "durationSec": 95.4,
      "fps": 30,
      "width": 1920,
      "height": 1080,
      "hasAudio": true,
      "hasAlpha": false,
      "roles": ["main"],
      "generated": false
    },
    {
      "id": "asset id",
      "name": "overlay.webm",
      "path": "media/<assetId>-overlay.webm",
      "kind": "video",
      "roles": ["overlay"],
      "generated": true,
      "framecutAi": {
        "compId": "authored:abc123",
        "templateId": "kinetic-title",
        "registryBlock": "lower-third-slide",
        "groupId": "run group id"
      }
    }
  ],
  "framecutAi": [
    {
      "compId": "authored:abc123",
      "templateId": "kinetic-title",
      "registryBlock": "lower-third-slide",
      "mediaId": "asset id",
      "clipIds": ["timeline element id"]
    }
  ]
}
```

Field notes:

- `files.transcript` is `null` when no transcript is packed (the file is
  then absent from the pack).
- `tracks[].role`: `main-video` (the V1 track), `overlay-video`,
  `overlay-text`, `overlay-graphic`, `overlay-effect`, `audio`.
  `durationSec` is the track's content extent (max clip end), not the
  project duration.
- `media[]` contains ONLY assets referenced by a timeline clip.
  `roles` is the deduplicated set of usage classes: `main` (referenced on
  the main track), `overlay` (any overlay track), `audio` (audio track).
  `generated: true` marks FrameCut AI renders (HyperFrames comps and baked
  registry blocks); their `framecutAi` carries the comp reference a kit
  needs to re-render or restyle the overlay instead of reusing the baked
  pixels. Optional metadata fields (`durationSec`, `fps`, `width`,
  `height`, `hasAudio`, `hasAlpha`) are present only when known.
- `framecutAi[]` (top level) is the deduplicated comp list across the whole
  timeline: one entry per generated asset, with every clip id that places
  it. `templateId` / `registryBlock` are mutually exclusive in practice
  (template comp vs baked block) and either may be absent.

## `styleProfile` slot

`styleProfile` is forward compatibility for the round-20 style preference
profiles (T20.1, built in parallel). Schema when present:

```json
"styleProfile": {
  "palette": { "accent": "#38BDF8", "supporting": ["#2567EC"] },
  "fonts": { "display": "Inter", "body": "Inter" },
  "motionStyle": "calm | standard | punchy",
  "density": "sparse | balanced | dense"
}
```

Until the profile system lands, the exporter ALWAYS serializes
`"styleProfile": null`. Kit-side code must treat `null` (or a missing key)
as "no profile, use kit defaults". When T20.1 merges, the active profile
serializes in under exactly these field names with no other manifest
change.

## `edl.json`

```json
{
  "format": "framecut-edl",
  "version": 1,
  "fps": { "numerator": 30, "denominator": 1 },
  "durationSec": 12.5,
  "tracks": [
    {
      "id": "track id",
      "name": "V1",
      "role": "main-video",
      "muted": false,
      "hidden": false,
      "clips": [
        {
          "id": "element id",
          "name": "interview.mp4",
          "kind": "video",
          "timelineStartSec": 0,
          "durationSec": 4.2,
          "mediaId": "asset id",
          "mediaPath": "media/<assetId>-interview.mp4",
          "trimStartSec": 1.0,
          "trimEndSec": 0,
          "sourceDurationSec": 95.4,
          "retime": { "rate": 1.25, "reversed": false },
          "linkId": "shared video+audio link id",
          "framecutAi": { "compId": "..." }
        },
        {
          "id": "element id",
          "name": "Title",
          "kind": "text",
          "timelineStartSec": 1.0,
          "durationSec": 2.0
        }
      ]
    }
  ]
}
```

Field notes:

- All times are SECONDS on the timeline (`timelineStartSec`, `durationSec`)
  or in the source (`trimStartSec`, `trimEndSec`, `sourceDurationSec`).
- `kind`: `video | image | audio | text | sticker | graphic | effect`.
  Only `video`, `image` and upload `audio` clips carry `mediaId` /
  `mediaPath`; library audio carries `sourceUrl` instead (library audio is
  a URL reference, not packed media); text/sticker/graphic/effect clips
  carry neither and exist so a kit can rebuild or skip them knowingly.
- `retime` is present only on retimed clips, as `{ "rate": 1.25 }` or
  `{ "rate": 1, "reversed": true }`. `reversed` is omitted unless true.
- `linkId` groups a video clip with audio separated from it; kits should
  keep linked clips in lockstep.
- `muted` / `hidden` appear on tracks and `hidden` on clips only when the
  track type supports them; a kit should treat a hidden clip or muted
  track as excluded from picture/sound respectively.

Retime curves (T18.2 piecewise speed profiles) are NOT expressible in v1;
a clip with a curve exports its `rate` field only when the rate differs
from 1, and kits should treat such clips as "re-cut from source if frame
accuracy matters". This is a known v1 limitation, documented rather than
lossy-approximated.

## `transcript.json`

Round-16 lineage data (cache entry when the timeline is unchanged since
transcription, lineage-remapped segments/words after removals):

```json
{
  "format": "framecut-transcript",
  "version": 1,
  "segments": [{ "startSec": 0.0, "endSec": 1.84, "text": "..." }],
  "words": [{ "startSec": 0.0, "endSec": 0.32, "text": "Hello" }]
}
```

Times are timeline seconds, matching the EDL coordinate space exactly, so
a kit can align captions to clips without further mapping. `words` is
absent when the producing model could not emit word timings (segment-only
transcript); kits must fall back to segment-level captioning. The file
itself is absent from the pack when the project has no exportable
transcript at all (never transcribed, or an edit the lineage cannot
explain).

## Media file naming

`media/<assetId>-<slug>.<ext>`: the asset id guarantees uniqueness, the
slug (lowercased, non-alphanumerics collapsed to `-`, max 40 chars) keeps
the folder human-browsable, and the extension comes from the stored file
name with a mime-type fallback (`video/webm` -> `webm`, `video/mp4` ->
`mp4`, `audio/mpeg` -> `mp3`, `image/png` -> `png`, `image/jpeg` ->
`jpg`, default `bin`).

## Round-trip invariants (pinned by tests)

1. Every EDL clip with a `mediaId` resolves to exactly one `media[]`
   entry, and the clip's `mediaPath` equals that entry's `path` and a real
   file in the pack.
2. Main-track clip durations sum to the project `durationSec` for a
   contiguous main track; every track's `durationSec` equals the max clip
   end in the EDL.
3. `manifest`, `edl`, and `transcript` survive
   `JSON.parse(JSON.stringify(x))` unchanged (no Dates, no undefined).
4. `styleProfile` is `null` until T20.1 lands.
