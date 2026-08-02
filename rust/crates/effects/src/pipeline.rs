use std::collections::HashMap;

use bytemuck::{Pod, Zeroable};
use gpu::{FULLSCREEN_SHADER_SOURCE, GpuContext};
use thiserror::Error;
use wgpu::util::DeviceExt;

use crate::{EffectPass, UniformValue};

const GAUSSIAN_BLUR_SHADER_ID: &str = "gaussian-blur";
const GAUSSIAN_BLUR_SHADER_SOURCE: &str = include_str!("shaders/gaussian_blur.wgsl");

const CHROMA_KEY_SHADER_ID: &str = "chroma-key";
const CHROMA_KEY_SHADER_SOURCE: &str = include_str!("shaders/chroma_key.wgsl");

/// Number of f32 slots every effect shader can address, indexed 0..SCALAR_SLOT_COUNT.
pub const SCALAR_SLOT_COUNT: usize = 12;
/// Number of vec2 slots every effect shader can address.
pub const VEC2_SLOT_COUNT: usize = 2;
/// Number of vec4 slots every effect shader can address.
pub const VEC4_SLOT_COUNT: usize = 1;

const SCALAR_VECTORS: usize = SCALAR_SLOT_COUNT / 4;

/// Where one named uniform lands inside [`EffectUniformBuffer`].
///
/// A shader never names a byte offset: it names a SLOT, and the buffer layout
/// below decides where that slot lives. Adding a shader therefore never
/// disturbs another shader's packing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UniformSlot {
    /// One f32 in `scalars`, index 0..[`SCALAR_SLOT_COUNT`].
    Scalar { index: usize },
    /// Two f32 in one of the vec2 slots, index 0..[`VEC2_SLOT_COUNT`].
    Vec2 { index: usize },
    /// Four f32 in one of the vec4 slots, index 0..[`VEC4_SLOT_COUNT`].
    Vec4 { index: usize },
}

/// One entry of a shader's uniform schema: the name JS sends, and its slot.
#[derive(Clone, Copy, Debug)]
pub struct UniformBinding {
    pub name: &'static str,
    pub slot: UniformSlot,
}

/// The complete, ordered uniform layout one shader accepts.
///
/// Every declared uniform is REQUIRED. Packing errors loudly on a missing
/// uniform, an undeclared uniform, or a value of the wrong type, so a JS-side
/// typo can never silently render a black frame.
#[derive(Clone, Copy, Debug)]
pub struct UniformSchema {
    pub shader: &'static str,
    pub uniforms: &'static [UniformBinding],
}

impl UniformSchema {
    fn slot_for(&self, name: &str) -> Option<UniformSlot> {
        self.uniforms
            .iter()
            .find(|binding| binding.name == name)
            .map(|binding| binding.slot)
    }
}

/// One registered effect shader: its JS-facing id, its WGSL source, and the
/// uniform schema that source expects.
///
/// TO ADD A SHADER: drop the `.wgsl` file in `src/shaders/`, `include_str!` it
/// next to `GAUSSIAN_BLUR_SHADER_SOURCE`, and add one entry here. The pipeline,
/// the shader module, the uniform validation, and the JS-facing shader id all
/// come from this single declaration.
struct EffectShader {
    id: &'static str,
    source: &'static str,
    schema: UniformSchema,
}

const EFFECT_SHADERS: &[EffectShader] = &[
    EffectShader {
        id: GAUSSIAN_BLUR_SHADER_ID,
        source: GAUSSIAN_BLUR_SHADER_SOURCE,
        schema: UniformSchema {
            shader: GAUSSIAN_BLUR_SHADER_ID,
            uniforms: &[
                UniformBinding {
                    name: "u_sigma",
                    slot: UniformSlot::Scalar { index: 0 },
                },
                UniformBinding {
                    name: "u_step",
                    slot: UniformSlot::Scalar { index: 1 },
                },
                UniformBinding {
                    name: "u_direction",
                    slot: UniformSlot::Vec2 { index: 0 },
                },
            ],
        },
    },
    EffectShader {
        id: CHROMA_KEY_SHADER_ID,
        source: CHROMA_KEY_SHADER_SOURCE,
        schema: UniformSchema {
            shader: CHROMA_KEY_SHADER_ID,
            uniforms: &[
                UniformBinding {
                    name: "u_similarity",
                    slot: UniformSlot::Scalar { index: 0 },
                },
                UniformBinding {
                    name: "u_smoothness",
                    slot: UniformSlot::Scalar { index: 1 },
                },
                UniformBinding {
                    name: "u_spill",
                    slot: UniformSlot::Scalar { index: 2 },
                },
                UniformBinding {
                    name: "u_shadow",
                    slot: UniformSlot::Scalar { index: 3 },
                },
                UniformBinding {
                    name: "u_key_color",
                    slot: UniformSlot::Vec4 { index: 0 },
                },
            ],
        },
    },
];

fn find_effect_shader(shader: &str) -> Option<&'static EffectShader> {
    EFFECT_SHADERS.iter().find(|entry| entry.id == shader)
}

pub struct ApplyEffectsOptions<'a> {
    pub source: &'a wgpu::Texture,
    pub width: u32,
    pub height: u32,
    pub passes: &'a [EffectPass],
}

pub struct EffectPipeline {
    uniform_bind_group_layout: wgpu::BindGroupLayout,
    pipelines: HashMap<String, wgpu::RenderPipeline>,
}

#[derive(Debug, Error)]
pub enum EffectsError {
    #[error("At least one effect pass is required")]
    MissingEffectPasses,
    #[error("Unknown effect shader '{shader}'")]
    UnknownEffectShader { shader: String },
    #[error("Missing uniform '{uniform}' for shader '{shader}'")]
    MissingUniform { shader: String, uniform: String },
    #[error("Uniform '{uniform}' for shader '{shader}' must be a number")]
    InvalidNumberUniform { shader: String, uniform: String },
    #[error(
        "Uniform '{uniform}' for shader '{shader}' must be a vector of length {expected_length}"
    )]
    InvalidVectorUniform {
        shader: String,
        uniform: String,
        expected_length: usize,
    },
    #[error("Shader '{shader}' does not support uniform '{uniform}'")]
    UnsupportedUniform { shader: String, uniform: String },
    #[error(
        "Shader '{shader}' declares uniform '{uniform}' in {kind} slot {index}, which is out of range"
    )]
    InvalidSchemaSlot {
        shader: String,
        uniform: String,
        kind: &'static str,
        index: usize,
    },
}

/// GPU uniform buffer shared by every effect shader.
///
/// LAYOUT (96 bytes, WGSL uniform address space, all offsets alignment-correct):
///
/// | offset | size | field         | holds                                     |
/// |--------|------|---------------|-------------------------------------------|
/// | 0      | 8    | `resolution`  | render target size in px (always written) |
/// | 8      | 8    | `direction`   | vec2 slot 0                               |
/// | 16     | 48   | `scalars`     | scalar slots 0..12 (3 x vec4f)            |
/// | 64     | 16   | `color`       | vec4 slot 0                               |
/// | 80     | 8    | `direction_b` | vec2 slot 1                               |
/// | 88     | 8    | `_padding`    | pads the struct to a multiple of 16       |
///
/// `scalars` is `array<vec4f, 3>` rather than `array<f32, 12>` because WGSL
/// gives a uniform-address-space `f32` array a 16-byte stride, which would burn
/// 192 bytes for the same 12 values. Scalar slot `i` is `scalars[i / 4][i % 4]`.
///
/// Blur predates the schema and its slots were chosen to keep its bytes exactly
/// where they were before T19.0: `u_direction` at offset 8, `u_sigma` at 16,
/// `u_step` at 20.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Pod, Zeroable)]
struct EffectUniformBuffer {
    resolution: [f32; 2],
    direction: [f32; 2],
    scalars: [[f32; 4]; SCALAR_VECTORS],
    color: [f32; 4],
    direction_b: [f32; 2],
    _padding: [f32; 2],
}

impl EffectUniformBuffer {
    fn new(width: u32, height: u32) -> Self {
        Self {
            resolution: [width as f32, height as f32],
            direction: [0.0; 2],
            scalars: [[0.0; 4]; SCALAR_VECTORS],
            color: [0.0; 4],
            direction_b: [0.0; 2],
            _padding: [0.0; 2],
        }
    }

    fn set_scalar(&mut self, index: usize, value: f32) -> bool {
        if index >= SCALAR_SLOT_COUNT {
            return false;
        }
        self.scalars[index / 4][index % 4] = value;
        true
    }

    fn set_vec2(&mut self, index: usize, value: [f32; 2]) -> bool {
        match index {
            0 => self.direction = value,
            1 => self.direction_b = value,
            _ => return false,
        }
        true
    }

    fn set_vec4(&mut self, index: usize, value: [f32; 4]) -> bool {
        match index {
            0 => self.color = value,
            _ => return false,
        }
        true
    }
}

impl EffectPipeline {
    pub fn new(context: &GpuContext) -> Self {
        let uniform_bind_group_layout =
            context
                .device()
                .create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                    label: Some("effects-uniform-bind-group-layout"),
                    entries: &[wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    }],
                });
        let vertex_shader_module =
            context
                .device()
                .create_shader_module(wgpu::ShaderModuleDescriptor {
                    label: Some("effects-fullscreen-shader"),
                    source: wgpu::ShaderSource::Wgsl(FULLSCREEN_SHADER_SOURCE.into()),
                });
        let pipeline_layout =
            context
                .device()
                .create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                    label: Some("effects-pipeline-layout"),
                    bind_group_layouts: &[
                        Some(context.texture_sampler_bind_group_layout()),
                        Some(&uniform_bind_group_layout),
                    ],
                    immediate_size: 0,
                });

        let mut pipelines = HashMap::new();
        for shader in EFFECT_SHADERS {
            let fragment_shader_module =
                context
                    .device()
                    .create_shader_module(wgpu::ShaderModuleDescriptor {
                        label: Some(&format!("effects-{}-shader", shader.id)),
                        source: wgpu::ShaderSource::Wgsl(shader.source.into()),
                    });
            let pipeline =
                context
                    .device()
                    .create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                        label: Some(&format!("effects-{}-pipeline", shader.id)),
                        layout: Some(&pipeline_layout),
                        vertex: wgpu::VertexState {
                            module: &vertex_shader_module,
                            entry_point: Some("vertex_main"),
                            buffers: &[wgpu::VertexBufferLayout {
                                array_stride: std::mem::size_of::<[f32; 2]>() as u64,
                                step_mode: wgpu::VertexStepMode::Vertex,
                                attributes: &[wgpu::VertexAttribute {
                                    format: wgpu::VertexFormat::Float32x2,
                                    offset: 0,
                                    shader_location: 0,
                                }],
                            }],
                            compilation_options: wgpu::PipelineCompilationOptions::default(),
                        },
                        fragment: Some(wgpu::FragmentState {
                            module: &fragment_shader_module,
                            entry_point: Some("fragment_main"),
                            targets: &[Some(wgpu::ColorTargetState {
                                format: context.texture_format(),
                                blend: None,
                                write_mask: wgpu::ColorWrites::ALL,
                            })],
                            compilation_options: wgpu::PipelineCompilationOptions::default(),
                        }),
                        primitive: wgpu::PrimitiveState::default(),
                        depth_stencil: None,
                        multisample: wgpu::MultisampleState::default(),
                        multiview_mask: None,
                        cache: None,
                    });
            pipelines.insert(shader.id.to_string(), pipeline);
        }

        Self {
            uniform_bind_group_layout,
            pipelines,
        }
    }

    pub fn apply(
        &self,
        context: &GpuContext,
        ApplyEffectsOptions {
            source,
            width,
            height,
            passes,
        }: ApplyEffectsOptions<'_>,
    ) -> Result<wgpu::Texture, EffectsError> {
        let mut encoder =
            context
                .device()
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("effects-command-encoder"),
                });
        let output = self.apply_with_encoder(
            context,
            &mut encoder,
            ApplyEffectsOptions {
                source,
                width,
                height,
                passes,
            },
        )?;
        context.queue().submit([encoder.finish()]);
        Ok(output)
    }

    pub fn apply_with_encoder(
        &self,
        context: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        ApplyEffectsOptions {
            source,
            width,
            height,
            passes,
        }: ApplyEffectsOptions<'_>,
    ) -> Result<wgpu::Texture, EffectsError> {
        let mut current_texture: Option<wgpu::Texture> = None;

        for pass in passes {
            let input_texture = current_texture.as_ref().unwrap_or(source);
            let output_texture =
                context.create_render_texture(width, height, "effects-pass-output");
            let input_view = input_texture.create_view(&wgpu::TextureViewDescriptor::default());
            let output_view = output_texture.create_view(&wgpu::TextureViewDescriptor::default());
            let texture_bind_group =
                context
                    .device()
                    .create_bind_group(&wgpu::BindGroupDescriptor {
                        label: Some("effects-texture-bind-group"),
                        layout: context.texture_sampler_bind_group_layout(),
                        entries: &[
                            wgpu::BindGroupEntry {
                                binding: 0,
                                resource: wgpu::BindingResource::TextureView(&input_view),
                            },
                            wgpu::BindGroupEntry {
                                binding: 1,
                                resource: wgpu::BindingResource::Sampler(context.linear_sampler()),
                            },
                        ],
                    });
            let uniform_buffer =
                context
                    .device()
                    .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                        label: Some("effects-uniform-buffer"),
                        contents: bytemuck::bytes_of(&pack_effect_uniforms(pass, width, height)?),
                        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                    });
            let uniform_bind_group =
                context
                    .device()
                    .create_bind_group(&wgpu::BindGroupDescriptor {
                        label: Some("effects-uniform-bind-group"),
                        layout: &self.uniform_bind_group_layout,
                        entries: &[wgpu::BindGroupEntry {
                            binding: 0,
                            resource: uniform_buffer.as_entire_binding(),
                        }],
                    });
            let pipeline = self.pipelines.get(&pass.shader).ok_or_else(|| {
                EffectsError::UnknownEffectShader {
                    shader: pass.shader.clone(),
                }
            })?;

            {
                let mut render_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("effects-render-pass"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &output_view,
                        resolve_target: None,
                        depth_slice: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                            store: wgpu::StoreOp::Store,
                        },
                    })],
                    depth_stencil_attachment: None,
                    occlusion_query_set: None,
                    timestamp_writes: None,
                    multiview_mask: None,
                });
                render_pass.set_pipeline(pipeline);
                render_pass.set_vertex_buffer(0, context.fullscreen_quad().slice(..));
                render_pass.set_bind_group(0, &texture_bind_group, &[]);
                render_pass.set_bind_group(1, &uniform_bind_group, &[]);
                render_pass.draw(0..6, 0..1);
            }

            current_texture = Some(output_texture);
        }

        current_texture.ok_or(EffectsError::MissingEffectPasses)
    }
}

fn pack_effect_uniforms(
    pass: &EffectPass,
    width: u32,
    height: u32,
) -> Result<EffectUniformBuffer, EffectsError> {
    let shader = pass.shader.as_str();
    let Some(entry) = find_effect_shader(shader) else {
        return Err(EffectsError::UnknownEffectShader {
            shader: shader.to_string(),
        });
    };
    let schema = &entry.schema;

    let mut buffer = EffectUniformBuffer::new(width, height);
    for binding in schema.uniforms {
        let written = match binding.slot {
            UniformSlot::Scalar { index } => {
                let value = read_number_uniform(pass, binding.name)?;
                buffer.set_scalar(index, value)
            }
            UniformSlot::Vec2 { index } => {
                let value = read_vector_uniform::<2>(pass, binding.name)?;
                buffer.set_vec2(index, value)
            }
            UniformSlot::Vec4 { index } => {
                let value = read_vector_uniform::<4>(pass, binding.name)?;
                buffer.set_vec4(index, value)
            }
        };
        if !written {
            let (kind, index) = match binding.slot {
                UniformSlot::Scalar { index } => ("scalar", index),
                UniformSlot::Vec2 { index } => ("vec2", index),
                UniformSlot::Vec4 { index } => ("vec4", index),
            };
            return Err(EffectsError::InvalidSchemaSlot {
                shader: shader.to_string(),
                uniform: binding.name.to_string(),
                kind,
                index,
            });
        }
    }

    for uniform in pass.uniforms.keys() {
        if schema.slot_for(uniform).is_none() {
            return Err(EffectsError::UnsupportedUniform {
                shader: shader.to_string(),
                uniform: uniform.clone(),
            });
        }
    }

    Ok(buffer)
}

fn read_number_uniform(pass: &EffectPass, uniform: &str) -> Result<f32, EffectsError> {
    let Some(value) = pass.uniforms.get(uniform) else {
        return Err(EffectsError::MissingUniform {
            shader: pass.shader.clone(),
            uniform: uniform.to_string(),
        });
    };
    match value {
        UniformValue::Number(value) => Ok(*value),
        UniformValue::Vector(_) => Err(EffectsError::InvalidNumberUniform {
            shader: pass.shader.clone(),
            uniform: uniform.to_string(),
        }),
    }
}

fn read_vector_uniform<const LENGTH: usize>(
    pass: &EffectPass,
    uniform: &str,
) -> Result<[f32; LENGTH], EffectsError> {
    let Some(value) = pass.uniforms.get(uniform) else {
        return Err(EffectsError::MissingUniform {
            shader: pass.shader.clone(),
            uniform: uniform.to_string(),
        });
    };
    let UniformValue::Vector(values) = value else {
        return Err(EffectsError::InvalidVectorUniform {
            shader: pass.shader.clone(),
            uniform: uniform.to_string(),
            expected_length: LENGTH,
        });
    };
    if values.len() != LENGTH {
        return Err(EffectsError::InvalidVectorUniform {
            shader: pass.shader.clone(),
            uniform: uniform.to_string(),
            expected_length: LENGTH,
        });
    }
    let mut packed = [0.0; LENGTH];
    packed.copy_from_slice(values);
    Ok(packed)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Runs each test under BOTH `cargo test` (native, needs a host linker) and
    /// `wasm-pack test --node rust/crates/effects` (wasm32, links with the
    /// bundled LLD). The wasm route is the one that works on a Windows box
    /// without the MSVC toolchain. See rust/wasm/README.md.
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    fn blur_pass(sigma: f32, step: f32, direction: [f32; 2]) -> EffectPass {
        EffectPass {
            shader: GAUSSIAN_BLUR_SHADER_ID.to_string(),
            uniforms: HashMap::from([
                ("u_sigma".to_string(), UniformValue::Number(sigma)),
                ("u_step".to_string(), UniformValue::Number(step)),
                (
                    "u_direction".to_string(),
                    UniformValue::Vector(direction.to_vec()),
                ),
            ]),
        }
    }

    fn chroma_key_pass(
        similarity: f32,
        smoothness: f32,
        spill: f32,
        shadow: f32,
        key_color: [f32; 4],
    ) -> EffectPass {
        EffectPass {
            shader: CHROMA_KEY_SHADER_ID.to_string(),
            uniforms: HashMap::from([
                (
                    "u_similarity".to_string(),
                    UniformValue::Number(similarity),
                ),
                (
                    "u_smoothness".to_string(),
                    UniformValue::Number(smoothness),
                ),
                ("u_spill".to_string(), UniformValue::Number(spill)),
                ("u_shadow".to_string(), UniformValue::Number(shadow)),
                (
                    "u_key_color".to_string(),
                    UniformValue::Vector(key_color.to_vec()),
                ),
            ]),
        }
    }

    #[test]
    fn uniform_buffer_layout_is_alignment_correct() {
        assert_eq!(std::mem::size_of::<EffectUniformBuffer>(), 96);
        assert_eq!(std::mem::size_of::<EffectUniformBuffer>() % 16, 0);
        assert_eq!(std::mem::offset_of!(EffectUniformBuffer, resolution), 0);
        assert_eq!(std::mem::offset_of!(EffectUniformBuffer, direction), 8);
        assert_eq!(std::mem::offset_of!(EffectUniformBuffer, scalars), 16);
        assert_eq!(std::mem::offset_of!(EffectUniformBuffer, color), 64);
        assert_eq!(std::mem::offset_of!(EffectUniformBuffer, direction_b), 80);
        assert_eq!(
            std::mem::offset_of!(EffectUniformBuffer, direction_b) % 8,
            0,
            "a vec2f needs 8-byte alignment"
        );
        assert_eq!(
            std::mem::offset_of!(EffectUniformBuffer, color) % 16,
            0,
            "a vec4f needs 16-byte alignment"
        );
    }

    #[test]
    fn buffer_capacity_meets_the_declared_slot_counts() {
        let mut buffer = EffectUniformBuffer::new(1, 1);
        for index in 0..SCALAR_SLOT_COUNT {
            assert!(buffer.set_scalar(index, index as f32));
        }
        assert!(!buffer.set_scalar(SCALAR_SLOT_COUNT, 1.0));
        for index in 0..VEC2_SLOT_COUNT {
            assert!(buffer.set_vec2(index, [1.0, 2.0]));
        }
        assert!(!buffer.set_vec2(VEC2_SLOT_COUNT, [1.0, 2.0]));
        for index in 0..VEC4_SLOT_COUNT {
            assert!(buffer.set_vec4(index, [1.0, 2.0, 3.0, 4.0]));
        }
        assert!(!buffer.set_vec4(VEC4_SLOT_COUNT, [1.0, 2.0, 3.0, 4.0]));
        assert_eq!(buffer.scalars[0], [0.0, 1.0, 2.0, 3.0]);
        assert_eq!(buffer.scalars[2], [8.0, 9.0, 10.0, 11.0]);
    }

    /// Blur golden. These are the exact bytes the pre-T19.0 hard-coded packer
    /// produced for the same pass, in the same order. The JS half of this proof
    /// is apps/web/src/effects/__tests__/blur-golden.test.ts.
    #[test]
    fn packs_blur_uniforms_byte_for_byte() {
        let packed =
            pack_effect_uniforms(&blur_pass(2.5, 1.0, [1.0, 0.0]), 1920, 1080).expect("blur packs");

        assert_eq!(packed.resolution, [1920.0, 1080.0]);
        assert_eq!(packed.direction, [1.0, 0.0]);
        assert_eq!(packed.scalars[0], [2.5, 1.0, 0.0, 0.0]);
        assert_eq!(packed.scalars[1], [0.0; 4]);
        assert_eq!(packed.scalars[2], [0.0; 4]);
        assert_eq!(packed.color, [0.0; 4]);
        assert_eq!(packed.direction_b, [0.0; 2]);

        let bytes = bytemuck::bytes_of(&packed);
        assert_eq!(bytes.len(), 96);
        // resolution (0..8), direction (8..16), sigma (16..20), step (20..24).
        assert_eq!(&bytes[0..4], &1920.0f32.to_ne_bytes());
        assert_eq!(&bytes[4..8], &1080.0f32.to_ne_bytes());
        assert_eq!(&bytes[8..12], &1.0f32.to_ne_bytes());
        assert_eq!(&bytes[12..16], &0.0f32.to_ne_bytes());
        assert_eq!(&bytes[16..20], &2.5f32.to_ne_bytes());
        assert_eq!(&bytes[20..24], &1.0f32.to_ne_bytes());
        assert!(bytes[24..].iter().all(|byte| *byte == 0));
    }

    #[test]
    fn packs_the_vertical_blur_pass() {
        let packed =
            pack_effect_uniforms(&blur_pass(4.0, 2.0, [0.0, 1.0]), 640, 360).expect("blur packs");
        assert_eq!(packed.resolution, [640.0, 360.0]);
        assert_eq!(packed.direction, [0.0, 1.0]);
        assert_eq!(packed.scalars[0], [4.0, 2.0, 0.0, 0.0]);
    }

    #[test]
    fn rejects_an_unregistered_shader() {
        let mut pass = blur_pass(1.0, 1.0, [1.0, 0.0]);
        pass.shader = "color-adjust".to_string();
        let error = pack_effect_uniforms(&pass, 16, 16).expect_err("unknown shader");
        assert!(matches!(
            error,
            EffectsError::UnknownEffectShader { ref shader } if shader == "color-adjust"
        ));
    }

    #[test]
    fn rejects_an_undeclared_uniform() {
        let mut pass = blur_pass(1.0, 1.0, [1.0, 0.0]);
        pass.uniforms
            .insert("u_saturation".to_string(), UniformValue::Number(1.0));
        let error = pack_effect_uniforms(&pass, 16, 16).expect_err("undeclared uniform");
        assert!(matches!(
            error,
            EffectsError::UnsupportedUniform { ref uniform, .. } if uniform == "u_saturation"
        ));
    }

    #[test]
    fn rejects_a_missing_uniform() {
        let mut pass = blur_pass(1.0, 1.0, [1.0, 0.0]);
        pass.uniforms.remove("u_step");
        let error = pack_effect_uniforms(&pass, 16, 16).expect_err("missing uniform");
        assert!(matches!(
            error,
            EffectsError::MissingUniform { ref uniform, .. } if uniform == "u_step"
        ));
    }

    #[test]
    fn rejects_a_vector_where_the_schema_wants_a_number() {
        let mut pass = blur_pass(1.0, 1.0, [1.0, 0.0]);
        pass.uniforms
            .insert("u_sigma".to_string(), UniformValue::Vector(vec![1.0, 2.0]));
        let error = pack_effect_uniforms(&pass, 16, 16).expect_err("wrong type");
        assert!(matches!(
            error,
            EffectsError::InvalidNumberUniform { ref uniform, .. } if uniform == "u_sigma"
        ));
    }

    #[test]
    fn rejects_a_number_where_the_schema_wants_a_vector() {
        let mut pass = blur_pass(1.0, 1.0, [1.0, 0.0]);
        pass.uniforms
            .insert("u_direction".to_string(), UniformValue::Number(1.0));
        let error = pack_effect_uniforms(&pass, 16, 16).expect_err("wrong type");
        assert!(matches!(
            error,
            EffectsError::InvalidVectorUniform {
                ref uniform,
                expected_length: 2,
                ..
            } if uniform == "u_direction"
        ));
    }

    #[test]
    fn rejects_a_vector_of_the_wrong_length() {
        let mut pass = blur_pass(1.0, 1.0, [1.0, 0.0]);
        pass.uniforms.insert(
            "u_direction".to_string(),
            UniformValue::Vector(vec![1.0, 0.0, 0.0]),
        );
        let error = pack_effect_uniforms(&pass, 16, 16).expect_err("wrong length");
        assert!(matches!(
            error,
            EffectsError::InvalidVectorUniform {
                expected_length: 2,
                ..
            }
        ));
    }

    /// T19.2 chroma key. The four scalars share `scalars[0]` and the key
    /// colour lands in the vec4 slot at byte 64, so the pass touches none of
    /// blur's bytes and vice versa.
    #[test]
    fn packs_chroma_key_uniforms() {
        let packed = pack_effect_uniforms(
            &chroma_key_pass(0.2, 0.1, 0.5, 0.0, [0.0, 1.0, 0.0, 1.0]),
            1920,
            1080,
        )
        .expect("chroma key packs");

        assert_eq!(packed.resolution, [1920.0, 1080.0]);
        assert_eq!(packed.scalars[0], [0.2, 0.1, 0.5, 0.0]);
        assert_eq!(packed.scalars[1], [0.0; 4]);
        assert_eq!(packed.scalars[2], [0.0; 4]);
        assert_eq!(packed.color, [0.0, 1.0, 0.0, 1.0]);
        assert_eq!(packed.direction, [0.0; 2]);
        assert_eq!(packed.direction_b, [0.0; 2]);

        let bytes = bytemuck::bytes_of(&packed);
        assert_eq!(bytes.len(), 96);
        // similarity 16, smoothness 20, spill 24, shadow 28, key colour 64.
        assert_eq!(&bytes[16..20], &0.2f32.to_ne_bytes());
        assert_eq!(&bytes[20..24], &0.1f32.to_ne_bytes());
        assert_eq!(&bytes[24..28], &0.5f32.to_ne_bytes());
        assert_eq!(&bytes[28..32], &0.0f32.to_ne_bytes());
        assert_eq!(&bytes[64..68], &0.0f32.to_ne_bytes());
        assert_eq!(&bytes[68..72], &1.0f32.to_ne_bytes());
    }

    #[test]
    fn rejects_a_chroma_key_pass_missing_its_key_colour() {
        let mut pass = chroma_key_pass(0.2, 0.1, 0.5, 0.0, [0.0, 1.0, 0.0, 1.0]);
        pass.uniforms.remove("u_key_color");
        let error = pack_effect_uniforms(&pass, 16, 16).expect_err("missing uniform");
        assert!(matches!(
            error,
            EffectsError::MissingUniform { ref uniform, .. } if uniform == "u_key_color"
        ));
    }

    #[test]
    fn rejects_a_chroma_key_colour_of_the_wrong_length() {
        let mut pass = chroma_key_pass(0.2, 0.1, 0.5, 0.0, [0.0, 1.0, 0.0, 1.0]);
        pass.uniforms.insert(
            "u_key_color".to_string(),
            UniformValue::Vector(vec![0.0, 1.0, 0.0]),
        );
        let error = pack_effect_uniforms(&pass, 16, 16).expect_err("wrong length");
        assert!(matches!(
            error,
            EffectsError::InvalidVectorUniform {
                expected_length: 4,
                ..
            }
        ));
    }

    /// Blur's uniform names must stay rejected by the chroma-key schema (and
    /// the reverse), or a typo could silently borrow the other effect's slot.
    #[test]
    fn chroma_key_rejects_blur_uniforms() {
        let mut pass = chroma_key_pass(0.2, 0.1, 0.5, 0.0, [0.0, 1.0, 0.0, 1.0]);
        pass.uniforms
            .insert("u_sigma".to_string(), UniformValue::Number(2.0));
        let error = pack_effect_uniforms(&pass, 16, 16).expect_err("undeclared uniform");
        assert!(matches!(
            error,
            EffectsError::UnsupportedUniform { ref uniform, .. } if uniform == "u_sigma"
        ));
    }

    #[test]
    fn every_registered_schema_is_well_formed() {
        for entry in EFFECT_SHADERS {
            assert_eq!(
                entry.id, entry.schema.shader,
                "schema shader id must match the registration id"
            );
            let mut names = Vec::new();
            let mut slots = Vec::new();
            for binding in entry.schema.uniforms {
                assert!(
                    !names.contains(&binding.name),
                    "shader '{}' declares '{}' twice",
                    entry.id,
                    binding.name
                );
                names.push(binding.name);
                assert!(
                    !slots.contains(&binding.slot),
                    "shader '{}' reuses a slot for '{}'",
                    entry.id,
                    binding.name
                );
                slots.push(binding.slot);
                let in_range = match binding.slot {
                    UniformSlot::Scalar { index } => index < SCALAR_SLOT_COUNT,
                    UniformSlot::Vec2 { index } => index < VEC2_SLOT_COUNT,
                    UniformSlot::Vec4 { index } => index < VEC4_SLOT_COUNT,
                };
                assert!(
                    in_range,
                    "shader '{}' puts '{}' in an out-of-range slot",
                    entry.id, binding.name
                );
            }
        }
    }
}
