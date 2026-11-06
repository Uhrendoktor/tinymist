use std::{env, fs, path::{Path, PathBuf}};

const VIRTUAL_PREFIX: &str = "/tinymist-wasm-assets/packages";

fn visit_files(root: &Path, current: &Path, files: &mut Vec<(String, PathBuf)>) {
    let mut entries = fs::read_dir(current)
        .unwrap_or_else(|err| panic!("cannot read {}: {err}", current.display()))
        .map(|entry| entry.expect("cannot read directory entry").path())
        .collect::<Vec<_>>();
    entries.sort();

    for path in entries {
        let metadata = fs::symlink_metadata(&path)
            .unwrap_or_else(|err| panic!("cannot stat {}: {err}", path.display()));
        assert!(
            !metadata.file_type().is_symlink(),
            "WASM package assets must not contain symlinks: {}",
            path.display()
        );
        if metadata.is_dir() {
            visit_files(root, &path, files);
        } else if metadata.is_file() {
            let relative = path.strip_prefix(root).expect("asset is below root");
            let relative = relative.to_string_lossy().replace('\\', "/");
            files.push((relative, path));
        } else {
            panic!("unsupported WASM package asset entry: {}", path.display());
        }
    }
}

fn main() {
    println!("cargo:rerun-if-env-changed=TINYMIST_WASM_ASSET_DIR");
    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR is set"));
    let mut roots = Vec::<(String, String, String)>::new();
    let mut files = Vec::<(String, PathBuf)>::new();

    if let Some(asset_dir) = env::var_os("TINYMIST_WASM_ASSET_DIR") {
        let packages_dir = PathBuf::from(asset_dir).join("packages");
        println!("cargo:rerun-if-changed={}", packages_dir.display());
        if packages_dir.exists() {
            let mut namespaces = fs::read_dir(&packages_dir)
                .expect("cannot read package asset directory")
                .map(|entry| entry.expect("cannot read namespace entry").path())
                .collect::<Vec<_>>();
            namespaces.sort();

            for namespace_dir in namespaces {
                assert!(namespace_dir.is_dir(), "package namespace must be a directory");
                let namespace = namespace_dir.file_name().unwrap().to_string_lossy().to_string();
                let mut names = fs::read_dir(&namespace_dir)
                    .expect("cannot read package namespace")
                    .map(|entry| entry.expect("cannot read package entry").path())
                    .collect::<Vec<_>>();
                names.sort();

                for name_dir in names {
                    assert!(name_dir.is_dir(), "package name must be a directory");
                    let name = name_dir.file_name().unwrap().to_string_lossy().to_string();
                    let mut versions = fs::read_dir(&name_dir)
                        .expect("cannot read package name directory")
                        .map(|entry| entry.expect("cannot read version entry").path())
                        .collect::<Vec<_>>();
                    versions.sort();

                    for version_dir in versions {
                        assert!(version_dir.is_dir(), "package version must be a directory");
                        let version = version_dir.file_name().unwrap().to_string_lossy().to_string();
                        roots.push((namespace.clone(), name.clone(), version));
                        visit_files(&packages_dir, &version_dir, &mut files);
                    }
                }
            }
        }
    }

    roots.sort();
    files.sort_by(|lhs, rhs| lhs.0.cmp(&rhs.0));

    let mut generated = String::from(
        "pub(crate) static PACKAGE_ROOTS: &[(&str, &str, &str)] = &[\n"
    );
    for (namespace, name, version) in roots {
        generated.push_str(&format!("    ({namespace:?}, {name:?}, {version:?}),\n"));
    }
    generated.push_str("];\n\npub(crate) static PACKAGE_FILES: &[(&str, &[u8])] = &[\n");
    for (relative, path) in files {
        let virtual_path = format!("{VIRTUAL_PREFIX}/{relative}");
        let absolute_path = path.canonicalize().expect("asset path must canonicalize");
        generated.push_str(&format!(
            "    ({virtual_path:?}, include_bytes!({:?})),\n",
            absolute_path.to_string_lossy()
        ));
    }
    generated.push_str("];\n");

    fs::write(out_dir.join("wasm_package_assets.rs"), generated)
        .expect("cannot write generated WASM package index");
}
