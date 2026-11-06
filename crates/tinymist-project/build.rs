//! Generates the compile-time index for additional font files embedded in browser WASM.

use std::{
    env, fs,
    path::{Path, PathBuf},
};

fn visit_fonts(current: &Path, files: &mut Vec<PathBuf>) {
    println!("cargo:rerun-if-changed={}", current.display());
    let mut entries = fs::read_dir(current)
        .unwrap_or_else(|err| panic!("cannot read {}: {err}", current.display()))
        .map(|entry| entry.expect("cannot read font entry").path())
        .collect::<Vec<_>>();
    entries.sort();

    for path in entries {
        println!("cargo:rerun-if-changed={}", path.display());
        let metadata = fs::symlink_metadata(&path)
            .unwrap_or_else(|err| panic!("cannot stat {}: {err}", path.display()));
        assert!(
            !metadata.file_type().is_symlink(),
            "WASM font assets must not contain symlinks: {}",
            path.display()
        );
        if metadata.is_dir() {
            visit_fonts(&path, files);
        } else if metadata.is_file() {
            let supported = path
                .extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| {
                    matches!(ext.to_ascii_lowercase().as_str(), "ttf" | "otf" | "ttc")
                });
            if supported {
                files.push(path);
            }
        } else {
            panic!("unsupported WASM font asset entry: {}", path.display());
        }
    }
}

fn main() {
    println!("cargo:rerun-if-env-changed=TINYMIST_WASM_ASSET_DIR");
    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR is set"));
    let mut files = Vec::new();

    if let Some(asset_dir) = env::var_os("TINYMIST_WASM_ASSET_DIR") {
        let fonts_dir = PathBuf::from(asset_dir).join("fonts");
        println!("cargo:rerun-if-changed={}", fonts_dir.display());
        if fonts_dir.exists() {
            visit_fonts(&fonts_dir, &mut files);
        }
    }
    files.sort();

    let mut generated = String::from("pub(crate) static WASM_FONT_FILES: &[&[u8]] = &[\n");
    for path in files {
        let absolute_path = path.canonicalize().expect("font path must canonicalize");
        generated.push_str(&format!(
            "    include_bytes!({:?}),\n",
            absolute_path.to_string_lossy()
        ));
    }
    generated.push_str("];\n");

    fs::write(out_dir.join("wasm_font_assets.rs"), generated)
        .expect("cannot write generated WASM font index");
}
