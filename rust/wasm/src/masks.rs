#![cfg(target_arch = "wasm32")]

use gpu::wgpu;
use js_sys::Object;
use wasm_bindgen::{JsCast, JsValue, prelude::wasm_bindgen};

use crate::gpu::{
    import_canvas_texture, read_f32_property, read_offscreen_canvas_property, read_property,
    read_u32_property, render_texture_to_canvas, with_gpu_runtime,
};

struct ApplyMaskFeatherOptions {
    mask: wgpu::web_sys::OffscreenCanvas,
    width: u32,
    height: u32,
    feather: f32,
    expansion: f32,
}

#[wasm_bindgen(js_name = applyMaskFeather)]
pub fn apply_mask_feather(options: JsValue) -> Result<wgpu::web_sys::OffscreenCanvas, JsValue> {
    let ApplyMaskFeatherOptions {
        mask,
        width,
        height,
        feather,
        expansion,
    } = parse_apply_mask_feather_options(options)?;

    with_gpu_runtime(|runtime| {
        let mask_texture = import_canvas_texture(
            &runtime.context,
            &mask,
            width,
            height,
            "masks-input-texture",
        );
        let result_texture = runtime.masks.apply_mask_feather(
            &runtime.context,
            masks::ApplyMaskFeatherOptions {
                mask: &mask_texture,
                width,
                height,
                feather,
                expansion,
            },
        );
        render_texture_to_canvas(&runtime.context, &result_texture, width, height)
    })
}

fn parse_apply_mask_feather_options(value: JsValue) -> Result<ApplyMaskFeatherOptions, JsValue> {
    let object: Object = value
        .dyn_into()
        .map_err(|_| JsValue::from_str("applyMaskFeather expects an options object"))?;

    Ok(ApplyMaskFeatherOptions {
        mask: read_offscreen_canvas_property(&object, "mask")?,
        width: read_u32_property(&object, "width")?,
        height: read_u32_property(&object, "height")?,
        feather: read_f32_property(&object, "feather")?,
        // Optional: callers that only want a feather may omit it entirely.
        expansion: read_optional_f32_property(&object, "expansion")?,
    })
}

fn read_optional_f32_property(object: &Object, name: &str) -> Result<f32, JsValue> {
    let value = read_property(object, name)?;
    if value.is_undefined() || value.is_null() {
        return Ok(0.0);
    }
    let Some(number) = value.as_f64() else {
        return Err(JsValue::from_str(&format!(
            "Property '{name}' must be a number"
        )));
    };
    Ok(number as f32)
}
