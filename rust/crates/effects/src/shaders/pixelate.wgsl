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
    // scalars[0].x: u_block_size, already converted to OUTPUT pixel units on
    // the TS side (see apps/web/src/effects/definitions/pixelate.ts), so the
    // shader only floors pixel coordinates to block centers - no UI-range
    // knowledge lives here.
    let block = max(uniforms.scalars[0].x, 1.0);

    let pixel_coord = input.tex_coord * uniforms.resolution;
    let block_index = floor(pixel_coord / block);
    let block_center = (block_index * block) + vec2f(block * 0.5, block * 0.5);
    let sample_uv = block_center / uniforms.resolution;

    return textureSample(input_texture, input_sampler, sample_uv);
}
