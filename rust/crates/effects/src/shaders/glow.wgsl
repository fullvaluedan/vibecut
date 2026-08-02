struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) tex_coord: vec2f,
}

// Shared by every effect shader. See the EffectUniformBuffer doc comment in
// src/pipeline.rs for the byte layout and the slot -> field mapping.
struct EffectUniforms {
    resolution: vec2f,
    direction: vec2f,
    scalars: array<vec4f, 3>,
    color: vec4f,
    direction_b: vec2f,
    _padding: vec2f,
}

@group(0) @binding(0) var input_texture: texture_2d<f32>;
@group(0) @binding(1) var input_sampler: sampler;
@group(1) @binding(0) var<uniform> uniforms: EffectUniforms;

const LUMA_WEIGHTS = vec3f(0.2126, 0.7152, 0.0722);
const TAP_COUNT = 8;

// GLOW / BLOOM, SOFT-BLOOM APPROXIMATION (see the T19.4b note in PATCHES.md
// and apps/web/src/effects/definitions/glow.ts for the full writeup).
//
// A "real" bloom is bright-pass extract -> blur -> ADDITIVE COMBINE WITH THE
// ORIGINAL frame. `apply_with_encoder` in pipeline.rs chains passes linearly:
// each pass reads only the PREVIOUS pass's output texture, so a later pass
// cannot also read the untouched original - there is no second texture input
// to combine against. Rather than change that shared chaining contract for
// one effect, this shader folds "extract + blur + combine" into a single
// separable two-pass filter that ADDS TO ITS OWN INPUT at every pass (same
// H-then-V split as gaussian_blur.wgsl, reusing `direction`):
//
//   pass 1 (horizontal): output = input + horizontalBloom(input)
//   pass 2 (vertical):   output = input + verticalBloom(input)
//
// Pass 2's "input" is pass 1's output (original + h-bloom already mixed in),
// so the vertical tap's own threshold/blur reads a slightly-glowing image
// instead of the pristine original. That is the one place this departs from
// a textbook separable bloom; visually the difference is negligible because
// the horizontal contribution added in pass 1 is itself small and already
// bright-weighted. This keeps glow expressible with zero changes to the
// pipeline's chaining model.
@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    // scalars[0]: x threshold (0..1 luma), y intensity (additive strength), z radius (tap spread, px)
    let threshold = uniforms.scalars[0].x;
    let intensity = uniforms.scalars[0].y;
    let radius = max(uniforms.scalars[0].z, 0.001);

    let texel = vec2f(1.0, 1.0) / uniforms.resolution;
    let base = textureSample(input_texture, input_sampler, input.tex_coord);

    var bloom = vec3f(0.0, 0.0, 0.0);
    var total_weight = 0.0;
    let step_size = max(radius / f32(TAP_COUNT), 0.5);

    for (var index = -TAP_COUNT; index <= TAP_COUNT; index = index + 1) {
        let offset = f32(index) * step_size;
        let sample_uv = input.tex_coord + (texel * uniforms.direction * offset);
        let sample_color = textureSample(input_texture, input_sampler, sample_uv).rgb;
        let luma = dot(sample_color, LUMA_WEIGHTS);
        let excess = max(luma - threshold, 0.0);
        let weight = exp(-(offset * offset) / (2.0 * radius * radius));
        bloom = bloom + sample_color * excess * weight;
        total_weight = total_weight + weight;
    }
    if (total_weight > 0.0) {
        bloom = bloom / total_weight;
    }

    let glowed = base.rgb + (bloom * intensity);
    return vec4f(clamp(glowed, vec3f(0.0), vec3f(1.0)), base.a);
}
