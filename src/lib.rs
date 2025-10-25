use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn greet_wasm() -> String {
    "Wasm module is ready and linked!".to_owned()
}
