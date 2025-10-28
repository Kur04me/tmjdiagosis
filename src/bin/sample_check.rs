use image::ImageReader;
use tmj_diagnosis::process_image_for_tmj;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("Usage: cargo run --bin sample_check <left|right> <path-to-image>");
        std::process::exit(1);
    }

    let side = args[1].as_str();
    let path = &args[2];
    let img = ImageReader::open(path)?.decode()?.to_luma8();
    let width = img.width();
    let height = img.height();
    let buffer: Vec<u8> = img.into_raw();

    let result = process_image_for_tmj(buffer.into_boxed_slice(), width, height, side);
    println!("{result}");
    Ok(())
}
