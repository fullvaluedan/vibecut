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

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    // Scalar slot map (see apps/web/src/effects/definitions/vignette.ts
    // buildPasses for the UI -> shader-space mapping):
    // scalars[0]: x amount (0..1), y radius (0..~1.2), z feather (0..1), w roundness (0..1)
    let amount = uniforms.scalars[0].x;
    let radius = uniforms.scalars[0].y;
    let feather = uniforms.scalars[0].z;
    let roundness = uniforms.scalars[0].w;

    let base = textureSample(input_texture, input_sampler, input.tex_coord);

    let aspect = uniforms.resolution.x / max(uniforms.resolution.y, 1.0);
    let centered = input.tex_coord - vec2f(0.5, 0.5);
    // Aspect-correct so a roundness of 1 draws a true ellipse inscribed in the
    // frame rather than a circle stretched by the aspect ratio.
    let corrected = vec2f(centered.x * aspect, centered.y);
    let half_extent = vec2f(aspect, 1.0);

    // Two distance metrics blended by roundness: 0 = rectangular falloff
    // (Chebyshev distance, corners darken at the same rate as edges), 1 = a
    // full ellipse (Euclidean distance, corners darken sooner than edges).
    let rect_dist = max(abs(corrected.x) / half_extent.x, abs(corrected.y) / half_extent.y);
    let circle_dist = length(corrected / half_extent);
    let dist = mix(rect_dist, circle_dist, roundness);

    let feather_amount = max(feather, 0.001);
    let inner = max(radius - feather_amount, 0.0);
    let outer = max(radius, inner + 0.001);
    // 1.0 near the center, falling to 0.0 past `outer`.
    let mask = 1.0 - smoothstep(inner, outer, dist);

    let darkened = base.rgb * mix(1.0, mask, amount);
    return vec4f(darkened, base.a);
}
