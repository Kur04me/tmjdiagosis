use image::{GrayImage, Luma};
use imageproc::contrast::otsu_level;
use imageproc::contours::{find_contours_with_threshold, BorderType, Contour};
use serde::Serialize;
use wasm_bindgen::prelude::*;

const MAX_POLYLINE_POINTS: usize = 10;
const MIN_COMPONENT_AREA: u32 = 64;
const EPSILON_DIVISOR: f64 = 24.0;

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

#[derive(Serialize)]
struct RoiBounds {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
}

#[derive(Clone)]
struct Candidate {
    area: f64,
    centroid_x: f64,
    polyline: Vec<[f64; 2]>,
}

fn gray_image_from_data(data: Box<[u8]>, width: u32, height: u32) -> Option<GrayImage> {
    GrayImage::from_raw(width, height, data.into_vec())
}

fn threshold_mask(image: &GrayImage, threshold: u8) -> GrayImage {
    let mut mask = GrayImage::new(image.width(), image.height());
    for (src, dst) in image.pixels().zip(mask.pixels_mut()) {
        let value = if src[0] > threshold { 255 } else { 0 };
        *dst = Luma([value]);
    }
    mask
}

fn contour_bounds(contour: &Contour<u32>) -> Option<(u32, u32, u32, u32)> {
    if contour.points.is_empty() {
        return None;
    }

    let mut min_x = u32::MAX;
    let mut max_x = 0u32;
    let mut min_y = u32::MAX;
    let mut max_y = 0u32;

    for point in &contour.points {
        let x = point.x;
        let y = point.y;
        if x < min_x {
            min_x = x;
        }
        if x > max_x {
            max_x = x;
        }
        if y < min_y {
            min_y = y;
        }
        if y > max_y {
            max_y = y;
        }
    }

    if min_x > max_x || min_y > max_y {
        return None;
    }

    Some((min_x, min_y, max_x, max_y))
}

fn polyline_from_contour(contour: &Contour<u32>) -> Vec<[f64; 2]> {
    let mut polyline = Vec::with_capacity(contour.points.len());
    let mut last: Option<[f64; 2]> = None;

    for point in &contour.points {
        let current = [point.x as f64, point.y as f64];
        if last
            .map(|prev| (prev[0] - current[0]).abs() < f64::EPSILON && (prev[1] - current[1]).abs() < f64::EPSILON)
            .unwrap_or(false)
        {
            continue;
        }
        polyline.push(current);
        last = Some(current);
    }

    if polyline.len() > 1 {
        let first = polyline[0];
        let last = polyline[polyline.len() - 1];
        if (first[0] - last[0]).abs() < f64::EPSILON && (first[1] - last[1]).abs() < f64::EPSILON {
            polyline.pop();
        }
    }

    polyline
}

fn perpendicular_distance(point: &[f64; 2], start: &[f64; 2], end: &[f64; 2]) -> f64 {
    let (sx, sy) = (start[0], start[1]);
    let (ex, ey) = (end[0], end[1]);
    let dx = ex - sx;
    let dy = ey - sy;

    if dx.abs() < f64::EPSILON && dy.abs() < f64::EPSILON {
        return ((point[0] - sx).powi(2) + (point[1] - sy).powi(2)).sqrt();
    }

    let numerator = ((dy * point[0]) - (dx * point[1]) + (ex * sy) - (ey * sx)).abs();
    numerator / (dx.powi(2) + dy.powi(2)).sqrt()
}

fn rdp_recursive(points: &[[f64; 2]], epsilon: f64, result: &mut Vec<[f64; 2]>) {
    if points.len() < 2 {
        return;
    }

    let start = points[0];
    let end = points[points.len() - 1];
    let mut max_distance = 0.0;
    let mut index = 0;

    for (i, point) in points.iter().enumerate().take(points.len() - 1).skip(1) {
        let distance = perpendicular_distance(point, &start, &end);
        if distance > max_distance {
            max_distance = distance;
            index = i;
        }
    }

    if max_distance > epsilon {
        let mut first_part = Vec::new();
        rdp_recursive(&points[..=index], epsilon, &mut first_part);
        let mut second_part = Vec::new();
        rdp_recursive(&points[index..], epsilon, &mut second_part);

        if !first_part.is_empty() {
            result.extend(first_part.iter().take(first_part.len() - 1));
        }
        result.extend(second_part);
    } else {
        result.push(start);
        result.push(end);
    }
}

fn simplify_polyline(points: &[[f64; 2]], epsilon: f64) -> Vec<[f64; 2]> {
    if points.len() <= 2 {
        return points.to_vec();
    }

    let mut simplified = Vec::new();
    rdp_recursive(points, epsilon, &mut simplified);

    if simplified.is_empty() {
        points.to_vec()
    } else {
        simplified
    }
}

fn limit_points(points: Vec<[f64; 2]>, max_points: usize) -> Vec<[f64; 2]> {
    if points.len() <= max_points {
        return points;
    }

    let mut limited = Vec::with_capacity(max_points);
    let step = (points.len() - 1) as f64 / (max_points - 1) as f64;

    for i in 0..max_points {
        let index = (i as f64 * step).round() as usize;
        limited.push(points[index.min(points.len() - 1)]);
    }

    limited
}

fn collect_candidates(contours: &[Contour<u32>]) -> Vec<Candidate> {
    let mut candidates = Vec::new();

    for contour in contours.iter().filter(|c| c.border_type == BorderType::Outer) {
        if let Some((min_x, min_y, max_x, max_y)) = contour_bounds(contour) {
            let width = max_x.saturating_sub(min_x).saturating_add(1);
            let height = max_y.saturating_sub(min_y).saturating_add(1);
            let area = (width as f64) * (height as f64);

            if area < MIN_COMPONENT_AREA as f64 {
                continue;
            }

            let centroid_x = (min_x as f64 + max_x as f64) / 2.0;
            let mut polyline = polyline_from_contour(contour);

            if polyline.len() < 3 {
                continue;
            }

            let diag = ((width as f64).hypot(height as f64)).max(1.0);
            let epsilon = (diag / EPSILON_DIVISOR).max(1.0);
            polyline = simplify_polyline(&polyline, epsilon);
            polyline = limit_points(polyline, MAX_POLYLINE_POINTS);

            if polyline.len() < 2 {
                continue;
            }

            candidates.push(Candidate {
                area,
                centroid_x,
                polyline,
            });
        }
    }

    if candidates.is_empty() {
        // fallback: use entire mask bounding box
        Vec::new()
    } else {
        candidates
    }
}

fn bounding_box_from_mask(mask: &GrayImage) -> Option<RoiBounds> {
    let mut min_x = mask.width();
    let mut min_y = mask.height();
    let mut max_x = 0u32;
    let mut max_y = 0u32;
    let mut found = false;

    for (x, y, pixel) in mask.enumerate_pixels() {
        if pixel[0] > 0 {
            found = true;
            if x < min_x {
                min_x = x;
            }
            if x > max_x {
                max_x = x;
            }
            if y < min_y {
                min_y = y;
            }
            if y > max_y {
                max_y = y;
            }
        }
    }

    if !found || min_x > max_x || min_y > max_y {
        None
    } else {
        Some(RoiBounds {
            x: min_x,
            y: min_y,
            width: max_x.saturating_sub(min_x).saturating_add(1),
            height: max_y.saturating_sub(min_y).saturating_add(1),
        })
    }
}

#[wasm_bindgen]
pub fn detect_roi(data: Box<[u8]>, width: u32, height: u32) -> String {
    if width == 0 || height == 0 {
        return "{}".to_owned();
    }

    let gray = match gray_image_from_data(data, width, height) {
        Some(image) => image,
        None => return "{}".to_owned(),
    };

    let threshold = otsu_level(&gray);
    let mask = threshold_mask(&gray, threshold);
    let contours = find_contours_with_threshold::<u32>(&gray, threshold);

    let mut best_bbox: Option<RoiBounds> = None;
    let mut best_area = 0f64;

    for contour in contours.iter().filter(|c| c.border_type == BorderType::Outer) {
        if let Some((min_x, min_y, max_x, max_y)) = contour_bounds(contour) {
            let width = max_x.saturating_sub(min_x).saturating_add(1);
            let height = max_y.saturating_sub(min_y).saturating_add(1);
            let area = (width as f64) * (height as f64);

            if area > best_area {
                best_area = area;
                best_bbox = Some(RoiBounds {
                    x: min_x,
                    y: min_y,
                    width,
                    height,
                });
            }
        }
    }

    if best_bbox.is_none() {
        best_bbox = bounding_box_from_mask(&mask);
    }

    if let Some(mut roi) = best_bbox {
        let padding = ((width.min(height)) as f64 * 0.02).round() as u32;
        roi.x = roi.x.saturating_sub(padding);
        roi.y = roi.y.saturating_sub(padding);
        let max_x = (roi.x + roi.width).saturating_add(padding).min(width);
        let max_y = (roi.y + roi.height).saturating_add(padding).min(height);
        roi.width = max_x.saturating_sub(roi.x).max(1);
        roi.height = max_y.saturating_sub(roi.y).max(1);

        serde_json::to_string(&roi).unwrap_or_else(|_| "{}".to_owned())
    } else {
        "{}".to_owned()
    }
}

fn fallback_segmentation(side: &str, width: u32, height: u32) -> String {
    let width_f = width as f64;
    let height_f = height as f64;
    let is_left = matches!(side.to_ascii_lowercase().as_str(), "left" | "l");

    let condyle_center = if is_left {
        (width_f * 0.35, height_f * 0.45)
    } else {
        (width_f * 0.65, height_f * 0.45)
    };

    let fossa_center = if is_left {
        (width_f * 0.6, height_f * 0.4)
    } else {
        (width_f * 0.4, height_f * 0.38)
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
        MAX_POLYLINE_POINTS,
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
        MAX_POLYLINE_POINTS,
    );

    serde_json::to_string(&SegmentationResult {
        side: side.to_owned(),
        condyle,
        fossa,
    })
    .unwrap_or_else(|_| "{\"side\":\"unknown\",\"condyle\":[],\"fossa\":[]}".to_owned())
}

#[wasm_bindgen]
pub fn process_image_for_tmj(data: Box<[u8]>, width: u32, height: u32, side: &str) -> String {
    if width == 0 || height == 0 {
        return fallback_segmentation(side, width, height);
    }

    let gray = match gray_image_from_data(data, width, height) {
        Some(image) => image,
        None => return fallback_segmentation(side, width, height),
    };

    let threshold = otsu_level(&gray);
    let contours = find_contours_with_threshold::<u32>(&gray, threshold);

    let mut candidates = collect_candidates(&contours);
    if candidates.len() < 2 {
        return fallback_segmentation(side, width, height);
    }

    candidates.sort_by(|a, b| b.area.partial_cmp(&a.area).unwrap_or(std::cmp::Ordering::Equal));
    let mut primary: Vec<Candidate> = candidates.into_iter().take(8).collect();
    if primary.len() < 2 {
        return fallback_segmentation(side, width, height);
    }

    primary.sort_by(|a, b| a.centroid_x.partial_cmp(&b.centroid_x).unwrap_or(std::cmp::Ordering::Equal));

    let is_left = matches!(side.to_ascii_lowercase().as_str(), "left" | "l");

    let condyle_candidate = if is_left {
        primary.first().cloned()
    } else {
        primary.last().cloned()
    };

    let fossa_candidate = if is_left {
        primary.last().cloned()
    } else {
        primary.first().cloned()
    };

    let (condyle_points, fossa_points) = match (condyle_candidate, fossa_candidate) {
        (Some(condyle), Some(fossa)) if condyle.polyline.len() > 1 && fossa.polyline.len() > 1 => {
            (condyle.polyline, fossa.polyline)
        }
        _ => return fallback_segmentation(side, width, height),
    };

    serde_json::to_string(&SegmentationResult {
        side: side.to_owned(),
        condyle: condyle_points,
        fossa: fossa_points,
    })
    .unwrap_or_else(|_| fallback_segmentation(side, width, height))
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
