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
    let texel_size = vec2f(1.0, 1.0) / uniforms.resolution;
    // u_sigma -> scalar slot 0, u_step -> scalar slot 1, u_direction -> vec2 slot 0.
    let sigma = uniforms.scalars[0].x;
    let step_size = uniforms.scalars[0].y;

    var color = vec4f(0.0, 0.0, 0.0, 0.0);
    var total_weight = 0.0;

    for (var index = -30; index <= 30; index = index + 1) {
        let position = f32(index) * step_size;
        let weight = exp(-(position * position) / (2.0 * sigma * sigma));
        let sample_uv = input.tex_coord + (texel_size * uniforms.direction * position);
        color = color + textureSample(input_texture, input_sampler, sample_uv) * weight;
        total_weight = total_weight + weight;
    }

    return color / total_weight;
}
