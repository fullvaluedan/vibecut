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

// Cheap deterministic pixel hash (no texture lookup needed), standard
// "hash13"-style dot/fract chain. Good enough for film-grain style noise;
// not cryptographic, not a physically based grain model.
fn hash(seed: vec2f) -> f32 {
    var p3 = fract(vec3f(seed.x, seed.y, seed.x) * 0.1031);
    p3 = p3 + dot(p3, p3.yzx + vec3f(33.33, 33.33, 33.33));
    return fract((p3.x + p3.y) * p3.z);
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    // scalars[0]: x amount (0..1 blend), y grain size (px per cell), z time (seconds, animates the seed)
    let amount = uniforms.scalars[0].x;
    let grain_size = max(uniforms.scalars[0].y, 1.0);
    let time = uniforms.scalars[0].z;

    let base = textureSample(input_texture, input_sampler, input.tex_coord);

    let pixel_coord = input.tex_coord * uniforms.resolution;
    let cell = floor(pixel_coord / grain_size);
    // Offsetting the hash seed by time (scaled and irrationally weighted so it
    // never lines back up on a short loop) reseeds the grain pattern every
    // frame, matching how film grain and digital noise both look "alive"
    // rather than a single static dither baked onto the image.
    let seed = cell + vec2f(time * 91.7, time * 63.1);
    let grain = (hash(seed) - 0.5) * 2.0;

    let graded = base.rgb + vec3f(grain, grain, grain) * amount;
    return vec4f(clamp(graded, vec3f(0.0), vec3f(1.0)), base.a);
}
