# Third-party notices

FrameCut bundles or adapts third-party code. Each entry records the upstream
project, the files it covers, and the license text carried as required.

`PATCHES.md` tracks changes to files inherited from the `opencut-classic` fork
base. This file covers code taken from a DIFFERENT upstream that `PATCHES.md`
does not describe: the Rust mask compositor, ported from the OpenCut rewrite.

## OpenCut (Jump-Flooding-Algorithm mask feathering)

The Rust mask crate under `rust/crates/masks/` was ported wholesale from
OpenCut-app/OpenCut at tag `v0.3.0` (commit
`f4bd689f51cf12a4dd0a32f602f761be314d9686`). These files are byte-identical to
that tag as of this notice:

- `rust/crates/masks/src/sdf.rs`
- `rust/crates/masks/src/feather.rs`
- `rust/crates/masks/src/masks.rs`
- `rust/crates/masks/src/shaders/jfa_init.wgsl`
- `rust/crates/masks/src/shaders/jfa_step.wgsl`
- `rust/crates/masks/src/shaders/jfa_distance.wgsl`

Upstream: https://github.com/OpenCut-app/OpenCut (MIT). OpenCut removed this
crate from its default branch after `v0.3.0` (commit "chore: clean state",
2026-05-06), so `v0.3.0` is the reference version for any future re-diff.

License (MIT):

```
MIT License

Copyright 2025 OpenCut

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN
AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```
