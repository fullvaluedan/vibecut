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

// BT.601 luma. Keying happens in the CHROMA plane (Cb/Cr) rather than on raw
// RGB distance, so a shadow or a hotspot on the green screen still reads as
// "the same colour" to the key.
fn chroma_key_luma(color: vec3f) -> f32 {
    return dot(color, vec3f(0.299, 0.587, 0.114));
}

// BT.601 Cb/Cr.
fn chroma_key_chroma(color: vec3f) -> vec2f {
    return vec2f(
        dot(color, vec3f(-0.168736, -0.331264, 0.5)),
        dot(color, vec3f(0.5, -0.418688, -0.081312)),
    );
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let source = textureSample(input_texture, input_sampler, input.tex_coord);

    // smoothstep needs a non-empty edge range, and two of the divisors below
    // need a non-zero denominator. One epsilon covers all three.
    let epsilon = 0.0001;
    // Shadow preservation only starts this far BELOW the key's own luma, so a
    // merely-slightly-darker patch of green still keys out normally.
    let shadow_luma_margin = 0.15;

    // u_similarity -> scalar slot 0, u_smoothness -> 1, u_spill -> 2,
    // u_shadow -> 3, u_key_color -> vec4 slot 0 (its alpha is unused).
    let similarity = uniforms.scalars[0].x;
    let smoothness = max(uniforms.scalars[0].y, epsilon);
    let spill_strength = uniforms.scalars[0].z;
    let shadow_strength = uniforms.scalars[0].w;
    let key_rgb = uniforms.color.rgb;

    let key_chroma = chroma_key_chroma(key_rgb);
    let key_luma = chroma_key_luma(key_rgb);
    let pixel_chroma = chroma_key_chroma(source.rgb);
    let pixel_luma = chroma_key_luma(source.rgb);

    // 1. KEY. Distance in the chroma plane, softened across `smoothness`:
    //    at the key colour the distance is 0 so alpha is 0 (fully cut out),
    //    and anything past similarity + smoothness stays fully opaque.
    let chroma_distance = length(pixel_chroma - key_chroma);
    var alpha = smoothstep(similarity, similarity + smoothness, chroma_distance);

    // 2. SHADOW PRESERVATION. A real shadow cast on the green floor keys out
    //    exactly like the floor does (same chroma) but is much darker. Give
    //    those pixels part of their alpha back, scaled by the shadow param.
    //    max() means this can only ever ADD alpha where the key removed it.
    let shadow_range = max(key_luma - shadow_luma_margin, epsilon);
    let shadow_drop = clamp((shadow_range - pixel_luma) / shadow_range, 0.0, 1.0);
    alpha = max(alpha, shadow_strength * shadow_drop);

    // 3. SPILL SUPPRESSION. How far the pixel's own chroma leans along the key
    //    direction (1 = exactly the key hue, 0 = orthogonal or opposite to it).
    //    Desaturate that proportion of it towards the pixel's own luma, which
    //    is what pulls the green rim off a subject's hair and shoulders.
    let key_chroma_energy = max(dot(key_chroma, key_chroma), epsilon);
    let spill_amount = clamp(
        dot(pixel_chroma, key_chroma) / key_chroma_energy,
        0.0,
        1.0,
    );
    let despilled = mix(source.rgb, vec3f(pixel_luma), spill_amount * spill_strength);

    // STRAIGHT (non-premultiplied) alpha out, which is what this compositor
    // expects everywhere: gpu/src/context.rs uploads layer textures with
    // `premultiplied_alpha: false`, and compositor/src/shaders/blend.wgsl
    // multiplies the layer's rgb by the layer's own alpha at blend time. So
    // the colour channels stay at full strength here and only `a` carries the
    // key. Pre-multiplying instead would double-darken every keyed edge.
    return vec4f(despilled, clamp(alpha, 0.0, 1.0) * source.a);
}
