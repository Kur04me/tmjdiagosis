use image::{GrayImage, Luma};
use imageproc::contours::{find_contours_with_threshold, BorderType, Contour};
use imageproc::contrast::otsu_level;
use imageproc::edges::canny;
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

#[derive(Clone, Copy, Serialize)]
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
    centroid_y: f64,
    bounds: RoiBounds,
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
            .map(|prev| {
                (prev[0] - current[0]).abs() < f64::EPSILON
                    && (prev[1] - current[1]).abs() < f64::EPSILON
            })
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

    for contour in contours
        .iter()
        .filter(|c| c.border_type == BorderType::Outer)
    {
        if let Some((min_x, min_y, max_x, max_y)) = contour_bounds(contour) {
            let width = max_x.saturating_sub(min_x).saturating_add(1);
            let height = max_y.saturating_sub(min_y).saturating_add(1);
            let area = (width as f64) * (height as f64);

            if area < MIN_COMPONENT_AREA as f64 {
                continue;
            }

            let centroid_x = (min_x as f64 + max_x as f64) / 2.0;
            let centroid_y = (min_y as f64 + max_y as f64) / 2.0;
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
                centroid_y,
                bounds: RoiBounds {
                    x: min_x,
                    y: min_y,
                    width,
                    height,
                },
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

fn select_condyle_candidate(
    candidates: &[Candidate],
    width: u32,
    height: u32,
) -> Option<Candidate> {
    let min_width = (width as f64 * 0.04).max(24.0);
    let min_height = (height as f64 * 0.04).max(24.0);
    let max_width = (width as f64 * 0.75).max(min_width + 1.0);
    let max_height = (height as f64 * 0.75).max(min_height + 1.0);

    candidates
        .iter()
        .filter(|candidate| {
            let bounds = candidate.bounds;
            let w = bounds.width as f64;
            let h = bounds.height as f64;
            if w < min_width || h < min_height {
                return false;
            }
            if w > max_width || h > max_height {
                return false;
            }
            let aspect = if w < 1.0 || h < 1.0 {
                f64::INFINITY
            } else {
                w.max(h) / w.min(h)
            };
            if aspect > 3.6 {
                return false;
            }
            if candidate.centroid_y < height as f64 * 0.45 {
                return false;
            }
            candidate.area > 800.0
        })
        .max_by(|a, b| {
            a.area
                .partial_cmp(&b.area)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .cloned()
}

fn select_fossa_candidate(
    candidates: &[Candidate],
    condyle_bounds: RoiBounds,
    width: u32,
    height: u32,
) -> Option<Candidate> {
    let condyle_center_x = condyle_bounds.x as f64 + condyle_bounds.width as f64 / 2.0;
    let search_band = (condyle_bounds.width as f64 * 2.5).max(30.0);
    let max_height = (condyle_bounds.height as f64 * 1.8).max(condyle_bounds.height as f64 + 1.0);
    let min_height = (condyle_bounds.height as f64 * 0.25).max(12.0);
    let min_width = (condyle_bounds.width as f64 * 0.6).max(24.0);
    let max_width = (condyle_bounds.width as f64 * 4.0).min(width as f64 * 0.9);

    candidates
        .iter()
        .filter(|candidate| {
            let bounds = candidate.bounds;
            if bounds.x == condyle_bounds.x
                && bounds.y == condyle_bounds.y
                && bounds.width == condyle_bounds.width
                && bounds.height == condyle_bounds.height
            {
                return false;
            }

            if candidate.centroid_y >= condyle_bounds.y as f64 {
                return false;
            }

            let w = bounds.width as f64;
            let h = bounds.height as f64;
            if w < min_width || w > max_width || h < min_height || h > max_height {
                return false;
            }
            let aspect = if w < 1.0 || h < 1.0 {
                f64::INFINITY
            } else {
                w.max(h) / w.min(h)
            };
            if aspect > 6.0 {
                return false;
            }

            let center_x = candidate.centroid_x;
            if (center_x - condyle_center_x).abs() > search_band {
                return false;
            }

            candidate.area > 400.0
                && bounds.y as f64 > (condyle_bounds.y as f64 - height as f64 * 0.4)
        })
        .max_by(|a, b| {
            a.area
                .partial_cmp(&b.area)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .cloned()
}

fn trace_fossa_curve(gray: &GrayImage, threshold: u8, condyle_bounds: RoiBounds) -> Vec<[f64; 2]> {
    if condyle_bounds.y == 0 {
        return Vec::new();
    }

    let width = gray.width();
    let height = gray.height();
    if width == 0 || height == 0 {
        return Vec::new();
    }

    let margin_x = ((condyle_bounds.width as f64) * 1.2).round().max(20.0) as i32;
    let margin_y = ((condyle_bounds.height as f64) * 2.2).round().max(28.0) as i32;

    let mut left = condyle_bounds.x as i32 - margin_x;
    let mut right = (condyle_bounds.x + condyle_bounds.width) as i32 + margin_x;
    let mut top = condyle_bounds.y as i32 - margin_y;
    let bottom = condyle_bounds.y as i32;

    left = left.max(0);
    right = right.min(width as i32 - 1).max(left);
    top = top.max(0).min(bottom - 1);

    if top >= bottom {
        return Vec::new();
    }

    let roi_width = (right - left + 1) as u32;
    let roi_height = (bottom - top) as u32;
    if roi_width < 2 || roi_height < 2 {
        return Vec::new();
    }

    let mut roi_image = GrayImage::new(roi_width, roi_height);
    for (local_y, global_y) in (top..bottom).enumerate() {
        for (local_x, global_x) in (left..=right).enumerate() {
            let pixel = gray.get_pixel(global_x as u32, global_y as u32);
            roi_image.put_pixel(local_x as u32, local_y as u32, *pixel);
        }
    }

    let high_threshold = ((threshold as f32) * 1.8).clamp(60.0, 360.0);
    let low_threshold = (high_threshold * 0.4).max(18.0);
    let edges = canny(&roi_image, low_threshold, high_threshold);

    let horizontal_span = roi_width;
    let step = ((horizontal_span / (MAX_POLYLINE_POINTS as u32 * 3)).max(1)) as usize;
    let mut edge_points: Vec<[f64; 2]> = Vec::new();
    for global_x in (left..=right).step_by(step) {
        let local_x = (global_x - left) as u32;
        let mut found: Option<u32> = None;
        for local_y in (0..roi_height).rev() {
            if edges.get_pixel(local_x, local_y)[0] > 0 {
                found = Some(local_y);
                break;
            }
        }
        if let Some(local_y) = found {
            edge_points.push([global_x as f64, (top + local_y as i32) as f64]);
        }
    }

    if edge_points.len() >= 4 {
        return smooth_and_limit(edge_points);
    }

    // Edge-based detection could not find a stable path; fall back to intensity-based sampling.
    let step = ((horizontal_span / (MAX_POLYLINE_POINTS as u32 * 2)).max(1)) as usize;
    let intensity_threshold = threshold.saturating_add(12);

    let mut points: Vec<[f64; 2]> = Vec::new();
    for global_x in (left..=right).step_by(step) {
        let mut best_value = 0u8;
        let mut best_y: Option<i32> = None;
        let mut candidate_y: Option<i32> = None;
        for y in (top..bottom).rev() {
            let value = gray.get_pixel(global_x as u32, y as u32)[0];
            if value >= intensity_threshold {
                candidate_y = Some(y);
                break;
            }
            if value > best_value {
                best_value = value;
                best_y = Some(y);
            }
        }

        let selected_y =
            candidate_y.or(best_y.filter(|_| best_value >= threshold.saturating_add(6)));

        if let Some(y) = selected_y {
            let point = [global_x as f64, y as f64];
            if points
                .last()
                .map(|last| {
                    (last[0] - point[0]).abs() > f64::EPSILON
                        || (last[1] - point[1]).abs() > f64::EPSILON
                })
                .unwrap_or(true)
            {
                points.push(point);
            }
        }
    }

    if points.len() < 4 {
        return Vec::new();
    }

    smooth_and_limit(points)
}

fn smooth_and_limit(points: Vec<[f64; 2]>) -> Vec<[f64; 2]> {
    if points.len() <= 2 {
        return points;
    }

    let mut smoothed = points.clone();
    for i in 1..smoothed.len() - 1 {
        let avg_y = (points[i - 1][1] + points[i][1] + points[i + 1][1]) / 3.0;
        smoothed[i][1] = avg_y;
    }

    if smoothed.len() > MAX_POLYLINE_POINTS {
        limit_points(smoothed, MAX_POLYLINE_POINTS)
    } else {
        smoothed
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

    for contour in contours
        .iter()
        .filter(|c| c.border_type == BorderType::Outer)
    {
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

    let candidates = collect_candidates(&contours);
    let condyle_candidate = match select_condyle_candidate(&candidates, width, height) {
        Some(candidate) => candidate,
        None => return fallback_segmentation(side, width, height),
    };

    let mut condyle_points = condyle_candidate.polyline.clone();
    if condyle_points.len() > MAX_POLYLINE_POINTS {
        condyle_points = limit_points(condyle_points, MAX_POLYLINE_POINTS);
    }

    let mut fossa_points = if let Some(candidate) =
        select_fossa_candidate(&candidates, condyle_candidate.bounds, width, height)
    {
        let mut points = candidate.polyline.clone();
        if points.len() > MAX_POLYLINE_POINTS {
            points = limit_points(points, MAX_POLYLINE_POINTS);
        }
        points
    } else {
        Vec::new()
    };

    if fossa_points.len() < 2 {
        fossa_points = trace_fossa_curve(&gray, threshold, condyle_candidate.bounds);
    }

    if fossa_points.len() < 2 {
        return fallback_segmentation(side, width, height);
    }

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
