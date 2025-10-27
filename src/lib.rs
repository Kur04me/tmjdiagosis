use serde::Serialize;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn greet_wasm() -> String {
    "Wasm module is ready and linked!".to_owned()
}

#[derive(Serialize)]
struct SegmentationResult {
    side: String,
    condyle: Vec<[f64; 2]>,
    fossa: Vec<[f64; 2]>,
}

fn generate_open_curve(
    cx: f64,
    cy: f64,
    rx: f64,
    ry: f64,
    start_angle: f64,
    end_angle: f64,
    points: usize,
) -> Vec<[f64; 2]> {
    let points = points.max(2);
    let mut result = Vec::with_capacity(points);
    let step = (end_angle - start_angle) / (points as f64 - 1.0);
    for i in 0..points {
        let theta = start_angle + step * i as f64;
        result.push([cx + rx * theta.cos(), cy + ry * theta.sin()]);
    }
    result
}

#[wasm_bindgen]
pub fn process_image_for_tmj(data: Box<[u8]>, width: u32, height: u32, side: &str) -> String {
    if width == 0 || height == 0 {
        return "{\"side\":\"unknown\",\"condyle\":[],\"fossa\":[]}".to_owned();
    }

    let expected_len = (width as usize).saturating_mul(height as usize);
    if data.len() < expected_len {
        return "{\"side\":\"unknown\",\"condyle\":[],\"fossa\":[]}".to_owned();
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

    let is_left = matches!(side.to_ascii_lowercase().as_str(), "left" | "l");

    let condyle_center = if condyle_acc.2 > f64::EPSILON {
        (
            condyle_acc.0 / condyle_acc.2,
            condyle_acc.1 / condyle_acc.2,
        )
    } else {
        if is_left {
            (width_f * 0.35, height_f * 0.45)
        } else {
            (width_f * 0.4, height_f * 0.5)
        }
    };

    let fossa_center = if fossa_acc.2 > f64::EPSILON {
        (fossa_acc.0 / fossa_acc.2, fossa_acc.1 / fossa_acc.2)
    } else {
        if is_left {
            (width_f * 0.6, height_f * 0.4)
        } else {
            (width_f * 0.65, height_f * 0.38)
        }
    };

    let condyle = generate_open_curve(
        condyle_center.0,
        condyle_center.1,
        width_f * 0.18,
        height_f * 0.22,
        if is_left {
            std::f64::consts::PI * 0.9
        } else {
            std::f64::consts::PI * 0.1
        },
        if is_left {
            std::f64::consts::PI * 1.7
        } else {
            std::f64::consts::PI * 1.5
        },
        10,
    );
    let fossa = generate_open_curve(
        fossa_center.0,
        fossa_center.1,
        width_f * 0.24,
        height_f * 0.18,
        if is_left {
            std::f64::consts::PI * 0.25
        } else {
            std::f64::consts::PI * 0.8
        },
        if is_left {
            std::f64::consts::PI * 1.35
        } else {
            std::f64::consts::PI * 1.9
        },
        10,
    );

    let result = SegmentationResult {
        side: side.to_owned(),
        condyle,
        fossa,
    };
    serde_json::to_string(&result)
        .unwrap_or_else(|_| "{\"side\":\"unknown\",\"condyle\":[],\"fossa\":[]}".to_owned())
}
