import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import initTomlEdit, { parse as parseToml } from "@rainbowatcher/toml-edit-js";

let tomlReady;

/**
 * Normalize the Cargo-style TOML format into the stable package/font shape
 * consumed by the existing WASM asset packager.
 *
 * The [dependencies] declarations use Cargo's real package/version syntax.
 * Typst-specific namespace, URL and redistribution details stay under
 * [package.metadata.tinymist], so they are not invalid Cargo dependency keys.
 */
export function normalizeTomlAssetManifest(document) {
  assert.ok(document && typeof document === "object", "TOML manifest must be a table");
  assert.ok(document.package && typeof document.package === "object", "manifest must contain [package] metadata");

  const tinymist = document.package.metadata?.tinymist ?? {};
  const dependencyMetadata =
    tinymist.dependency_metadata ?? tinymist["dependency-metadata"] ?? {};
  const dependencies = document.dependencies ?? {};
  const fonts = tinymist.fonts ?? {};

  assert.ok(
    dependencies && typeof dependencies === "object" && !Array.isArray(dependencies),
    "manifest [dependencies] must be a table",
  );
  assert.ok(
    fonts && typeof fonts === "object" && !Array.isArray(fonts),
    "manifest [package.metadata.tinymist.fonts] must be a table",
  );

  const packages = Object.entries(dependencies).map(([alias, rawDependency]) => {
    // Cargo supports both crate = "1.2" and
    // crate_alias = { package = "crate", version = "=1.2" }.
    const dependency =
      typeof rawDependency === "string"
        ? { package: alias, version: rawDependency }
        : rawDependency;
    assert.ok(
      dependency && typeof dependency === "object" && !Array.isArray(dependency),
      "dependency " + alias + " must use Cargo dependency syntax",
    );

    const packageName = dependency.package ?? alias;
    const versionRequirement = dependency.version;
    assert.equal(typeof packageName, "string", "dependency " + alias + " must specify a package name");
    assert.equal(typeof versionRequirement, "string", "dependency " + alias + " must specify a version");
    assert.match(
      versionRequirement,
      /^=[0-9A-Za-z][0-9A-Za-z.+-]*$/,
      'dependency "' + alias + '" version must be pinned exactly using Cargo syntax, e.g. "=0.5.3"',
    );

    const metadata = dependencyMetadata[alias] ?? {};
    assert.ok(
      metadata && typeof metadata === "object" && !Array.isArray(metadata),
      "metadata for dependency " + alias + " must be a table",
    );

    const item = {
      namespace: metadata.namespace ?? "preview",
      name: packageName,
      version: versionRequirement.slice(1),
      license: metadata.license,
      licenseUrl: metadata.license_url ?? metadata["license-url"],
    };
    if (metadata.url !== undefined) item.url = metadata.url;
    return item;
  });

  const fontAssets = Object.entries(fonts).map(([alias, font]) => {
    assert.ok(
      font && typeof font === "object" && !Array.isArray(font),
      'font "' + alias + '" must be a table',
    );
    return {
      name: font.name ?? alias,
      file: font.file,
      url: font.url,
      license: font.license,
      licenseUrl: font.license_url ?? font["license-url"],
    };
  });

  const limits = tinymist.limits ?? {};
  const builtInFonts = tinymist.built_in_fonts ?? tinymist["built-in-fonts"] ?? {};
  const schemaVersion = tinymist.schema_version ?? tinymist["schema-version"] ?? 1;

  return {
    schemaVersion,
    limits: {
      maxTotalBytes: limits.max_total_bytes ?? limits["max-total-bytes"],
      maxPackageBytes: limits.max_package_bytes ?? limits["max-package-bytes"],
      maxFontBytes: limits.max_font_bytes ?? limits["max-font-bytes"],
    },
    builtInFonts: {
      provider: builtInFonts.provider,
      defaultTextFont: builtInFonts.default_text_font ?? builtInFonts["default-text-font"],
      includedFamilies: builtInFonts.included_families ?? builtInFonts["included-families"],
      note: builtInFonts.note,
    },
    packages,
    fonts: fontAssets,
  };
}

export async function parseAssetManifestText(source, extension) {
  if (extension.toLowerCase() === ".json") {
    return JSON.parse(source);
  }
  assert.equal(
    extension.toLowerCase(),
    ".toml",
    "asset manifests must use .toml (Cargo-style) or .json format",
  );
  tomlReady ??= initTomlEdit();
  await tomlReady;
  return normalizeTomlAssetManifest(parseToml(source));
}

export async function readAssetManifest(manifestPath) {
  const source = await fs.readFile(manifestPath, "utf8");
  return parseAssetManifestText(source, path.extname(manifestPath));
}
