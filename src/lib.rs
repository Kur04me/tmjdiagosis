use serde::Serialize;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn greet_wasm() -> String {
    "Wasm module is ready and linked!".to_owned()
}

#[derive(Serialize)]
struct SegmentationResult {
    condyle: Vec<[f64; 2]>,
    fossa: Vec<[f64; 2]>,
}

fn generate_ellipse_points(cx: f64, cy: f64, rx: f64, ry: f64, segments: usize) -> Vec<[f64; 2]> {
    let mut points = Vec::with_capacity(segments + 1);
    for i in 0..=segments {
        let theta = (i as f64 / segments as f64) * std::f64::consts::TAU;
        points.push([cx + rx * theta.cos(), cy + ry * theta.sin()]);
    }
    points
}

#[wasm_bindgen]
pub fn process_image_for_tmj(data: Box<[u8]>, width: u32, height: u32) -> String {
    if width == 0 || height == 0 {
        return "{\"condyle\":[],\"fossa\":[]}".to_owned();
    }

    let expected_len = (width as usize).saturating_mul(height as usize);
    if data.len() < expected_len {
        return "{\"condyle\":[],\"fossa\":[]}".to_owned();
    }

    let width_f = width as f64;
    let height_f = height as f64;

    let mut condyle_acc = (0.0, 0.0, 0.0);
    let mut fossa_acc = (0.0, 0.0, 0.0);

    for (idx, intensity) in data.iter().enumerate() {
        let px = *intensity as f64 / 255.0;
        if px == 0.0 {
            continue;
        }
        let x = (idx % width as usize) as f64;
        let y = (idx / width as usize) as f64;
        if x < width_f * 0.5 {
            condyle_acc.0 += x * px;
            condyle_acc.1 += y * px;
            condyle_acc.2 += px;
        } else {
            fossa_acc.0 += x * px;
            fossa_acc.1 += y * px;
            fossa_acc.2 += px;
        }
    }

    let condyle_center = if condyle_acc.2 > f64::EPSILON {
        (
            condyle_acc.0 / condyle_acc.2,
            condyle_acc.1 / condyle_acc.2,
        )
    } else {
        (width_f * 0.35, height_f * 0.45)
    };

    let fossa_center = if fossa_acc.2 > f64::EPSILON {
        (fossa_acc.0 / fossa_acc.2, fossa_acc.1 / fossa_acc.2)
    } else {
        (width_f * 0.65, height_f * 0.4)
    };

    let condyle = generate_ellipse_points(
        condyle_center.0,
        condyle_center.1,
        width_f * 0.18,
        height_f * 0.22,
        48,
    );
    let fossa = generate_ellipse_points(
        fossa_center.0,
        fossa_center.1,
        width_f * 0.2,
        height_f * 0.18,
        48,
    );

    let result = SegmentationResult { condyle, fossa };
    serde_json::to_string(&result).unwrap_or_else(|_| "{\"condyle\":[],\"fossa\":[]}".to_owned())
}
