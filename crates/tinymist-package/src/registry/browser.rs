//! Browser proxy registry for tinymist. You should implement interfaces in js.

use std::{io::Read, path::Path};

use js_sys::Uint8Array;
use tinymist_std::ImmutPath;
use typst::diag::eco_format;
use wasm_bindgen::{JsValue, prelude::*};

use crate::registry::PackageIndexEntry;

use super::{PackageError, PackageRegistry, PackageSpec};

/// The `ProxyContext` struct is a wrapper around a JavaScript this.
#[wasm_bindgen]
#[derive(Debug, Clone)]
pub struct ProxyContext {
    context: JsValue,
}

#[wasm_bindgen]
impl ProxyContext {
    /// Creates a new `ProxyContext` instance.
    #[wasm_bindgen(constructor)]
    pub fn new(context: JsValue) -> Self {
        Self { context }
    }

    /// Returns the JavaScript this.
    #[wasm_bindgen(getter)]
    pub fn context(&self) -> JsValue {
        self.context.clone()
    }

    /// A convenience function to untar a tarball and call a callback for each
    /// entry.
    pub fn untar(&self, data: &[u8], cb: js_sys::Function) -> Result<(), JsValue> {
        let cb = move |key: String, value: &[u8], mtime: u64| -> Result<(), JsValue> {
            let key = JsValue::from_str(&key);
            let value = Uint8Array::from(value);
            let mtime = JsValue::from_f64(mtime as f64);
            cb.call3(&self.context, &key, &value, &mtime).map(|_| ())
        };

        let decompressed = flate2::read::GzDecoder::new(data);
        let mut reader = tar::Archive::new(decompressed);
        let entries = reader.entries();
        let entries = entries.map_err(|err| {
            let t = PackageError::MalformedArchive(Some(eco_format!("{err}")));
            JsValue::from_str(&format!("{t:?}"))
        })?;

        let mut buf = Vec::with_capacity(1024);
        for entry in entries {
            // Read single entry
            let mut entry = entry.map_err(|e| format!("{e:?}"))?;
            let header = entry.header();

            let is_file = header.entry_type().is_file();
            if !is_file {
                continue;
            }

            let mtime = header.mtime().unwrap_or(0);

            let path = header.path().map_err(|e| format!("{e:?}"))?;
            let path = path.to_string_lossy().as_ref().to_owned();

            let size = header.size().map_err(|e| format!("{e:?}"))?;
            buf.clear();
            buf.reserve(size as usize);
            entry.read_to_end(&mut buf).map_err(|e| format!("{e:?}"))?;

            cb(path, &buf, mtime)?
        }

        Ok(())
    }
}

/// The `JsRegistry` struct is a wrapper around a JavaScript function that
#[derive(Debug)]
pub struct JsRegistry {
    /// The JavaScript this context.
    pub context: ProxyContext,
    /// The JavaScript function to call for resolving packages.
    pub real_resolve_fn: js_sys::Function,
}

const EMBEDDED_WASM_PACKAGE_PREFIX: &str = "/tinymist-wasm-assets/packages";

mod wasm_assets {
    include!(concat!(env!("OUT_DIR"), "/wasm_package_assets.rs"));
}

/// Returns the bytes of an embedded package file, if the path belongs to the
/// build-time WASM package bundle.
pub fn embedded_package_file(path: &Path) -> Option<&'static [u8]> {
    let path = path.to_string_lossy();
    wasm_assets::PACKAGE_FILES
        .iter()
        .find(|(asset_path, _)| *asset_path == path.as_ref())
        .map(|(_, bytes)| *bytes)
}

impl PackageRegistry for JsRegistry {
    fn resolve(&self, spec: &PackageSpec) -> Result<std::sync::Arc<Path>, PackageError> {
        let namespace = spec.namespace.to_string();
        let name = spec.name.to_string();
        let version = spec.version.to_string();
        let is_embedded = wasm_assets::PACKAGE_ROOTS.iter().any(|(ns, pkg, ver)| {
            *ns == namespace.as_str() && *pkg == name.as_str() && *ver == version.as_str()
        });
        if is_embedded {
            let root = format!(
                "{}/{}/{}/{}",
                EMBEDDED_WASM_PACKAGE_PREFIX, namespace, name, version
            );
            return Ok(Path::new(&root).into());
        }

        // Only after the in-WASM bundle lookup do we consult the JS host.
        // The shipped browser worker returns undefined here, so missing
        // packages fail closed instead of triggering runtime network access.
        // prepare js_spec
        let js_spec = js_sys::Object::new();
        js_sys::Reflect::set(&js_spec, &"name".into(), &spec.name.to_string().into()).unwrap();
        js_sys::Reflect::set(
            &js_spec,
            &"namespace".into(),
            &spec.namespace.to_string().into(),
        )
        .unwrap();
        js_sys::Reflect::set(
            &js_spec,
            &"version".into(),
            &spec.version.to_string().into(),
        )
        .unwrap();

        self.real_resolve_fn
            .call1(&self.context.clone().into(), &js_spec)
            .map_err(|e| PackageError::Other(Some(eco_format!("{:?}", e))))
            .and_then(|v| {
                if v.is_undefined() {
                    Err(PackageError::NotFound(spec.clone()))
                } else if let Some(path) = v.as_string() {
                    Ok(Path::new(&path).into())
                } else {
                    Err(PackageError::Other(Some(eco_format!(
                        "Browser package resolver returned a non-string value"
                    ))))
                }
            })
    }

    // todo: provide package list for browser
    fn packages(&self) -> &[PackageIndexEntry] {
        &[]
    }
}

impl JsRegistry {
    /// Returns the path at which non-local packages should be stored when
    /// downloaded.
    pub fn package_cache_path(&self) -> Option<&ImmutPath> {
        None
    }

    /// Returns the path at which local packages are stored.
    pub fn package_path(&self) -> Option<&ImmutPath> {
        None
    }
}

// todo
/// Safety: `JsRegistry` is only used in the browser environment, and we cannot
/// share data between workers.
unsafe impl Send for JsRegistry {}
/// Safety: `JsRegistry` is only used in the browser environment, and we cannot
/// share data between workers.
unsafe impl Sync for JsRegistry {}
