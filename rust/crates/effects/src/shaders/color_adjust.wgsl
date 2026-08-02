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

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    // Scalar slot map (see apps/web/src/effects/definitions/color-adjust.ts
    // buildPasses for the UI -> shader-space mapping):
    // scalars[0]: x exposure (stops), y temperature, z tint, w contrast
    // scalars[1]: x highlights, y shadows, z saturation (0..2), w brightness
    // scalars[2]: x sharpen (0 = off)
    let exposure = uniforms.scalars[0].x;
    let temperature = uniforms.scalars[0].y;
    let tint = uniforms.scalars[0].z;
    let contrast = uniforms.scalars[0].w;
    let highlights = uniforms.scalars[1].x;
    let shadows = uniforms.scalars[1].y;
    let saturation = uniforms.scalars[1].z;
    let brightness = uniforms.scalars[1].w;
    let sharpen = uniforms.scalars[2].x;

    let base = textureSample(input_texture, input_sampler, input.tex_coord);
    var color = base.rgb;

    // Sharpen: a 5-tap unsharp mask sampled from the ORIGINAL (pre-grade)
    // neighborhood, so it never doubles up with the contrast/saturation
    // changes applied below. Skipped entirely when the amount is 0, matching
    // the TS-side neutral early-out.
    if (sharpen > 0.0) {
        let texel = vec2f(1.0, 1.0) / uniforms.resolution;
        let up = textureSample(input_texture, input_sampler, input.tex_coord + vec2f(0.0, -texel.y)).rgb;
        let down = textureSample(input_texture, input_sampler, input.tex_coord + vec2f(0.0, texel.y)).rgb;
        let left = textureSample(input_texture, input_sampler, input.tex_coord + vec2f(-texel.x, 0.0)).rgb;
        let right = textureSample(input_texture, input_sampler, input.tex_coord + vec2f(texel.x, 0.0)).rgb;
        let blurred = (up + down + left + right) * 0.25;
        color = color + (color - blurred) * sharpen;
    }

    // 1. Exposure: multiplicative stops (mult = 2^exposure), applied first so
    // every downstream op grades the exposed image, same as a camera raw
    // pipeline.
    color = color * pow(2.0, exposure);

    // 2. White balance (temperature + tint): a simple RGB channel-scaling
    // approximation, NOT a physically based Kelvin/Planckian model. Positive
    // temperature warms the image (boosts red, cuts blue); positive tint
    // pushes toward magenta (cuts green). This is the same class of cheap
    // approximation most consumer NLEs use for a single-pass white balance
    // control.
    color = vec3f(
        color.r * (1.0 + temperature * 0.3),
        color.g * (1.0 - tint * 0.3),
        color.b * (1.0 - temperature * 0.3),
    );

    // 3. Contrast: pivot at 0.5 in the display-referred (gamma-encoded) color
    // space the texture is already in. A true perceptual pivot would need a
    // linear/Lab round-trip; gamma-space 0.5 is the standard cheap stand-in
    // because gamma encoding is already closer to perceptually uniform than
    // linear light, and it matches how most consumer color tools implement a
    // single "contrast" slider.
    color = (color - vec3f(0.5)) * (1.0 + contrast) + vec3f(0.5);

    // 4. Highlights / shadows: luma-masked lift/gain with smooth masks so the
    // two controls blend into the midtones instead of hard-clipping.
    // Highlights is a GAIN (multiplicative) on the bright mask; shadows is a
    // LIFT (additive) on the dark mask, halved for finer control.
    let luma = dot(color, LUMA_WEIGHTS);
    let highlight_mask = smoothstep(0.3, 1.0, luma);
    let shadow_mask = 1.0 - smoothstep(0.0, 0.7, luma);
    color = color * (1.0 + highlights * highlight_mask);
    color = color + vec3f(shadows * shadow_mask * 0.5);

    // 5. Saturation: luma-preserving lerp between grayscale and the graded
    // color. `saturation` is already the final multiplier computed on the TS
    // side (0 = grayscale, 1 = unchanged, 2 = doubled).
    let gray = vec3f(dot(color, LUMA_WEIGHTS));
    color = mix(gray, color, saturation);

    // 6. Brightness: simple additive offset, applied last.
    color = color + vec3f(brightness);

    return vec4f(clamp(color, vec3f(0.0), vec3f(1.0)), base.a);
}
