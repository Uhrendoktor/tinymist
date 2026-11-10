import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import initTomlEdit, { parse as parseToml } from "@rainbowatcher/toml-edit-js";

let tomlReady;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function packageManifestKey(namespace, name, versionSpec, source) {
  if (source.type === "registry") {
    return namespace + "/" + name + "@" + versionSpec;
  }
  if (source.type === "path") {
    return namespace + "/" + name + "@path:" + source.path;
  }
  return namespace + "/" + name + "@git:" + source.git + "#" +
    source.refType + ":" + source.ref + ":" + (source.subdirectory || ".");
}

function normalizePackageSource(name, spec, metadata, namespace) {
  let source = { type: "registry" };
  let versionSpec;

  if (typeof spec === "string") {
    versionSpec = spec;
    assert.ok(
      versionSpec === "latest" || /^\d+\.\d+\.\d+$/.test(versionSpec),
      'package "' + name + '" must use a full version such as "1.2.3" or "latest"',
    );
  } else {
    assert.ok(isRecord(spec), 'package "' + name + '" must be a version string or a source table');
    const hasPath = spec.path !== undefined;
    const hasGit = spec.git !== undefined;
    const allowedKeys = hasPath
      ? new Set(["path", "namespace"])
      : new Set(["git", "rev", "tag", "branch", "subdirectory", "namespace"]);
    for (const key of Object.keys(spec)) {
      assert.ok(allowedKeys.has(key), 'unsupported field "' + key + '" in source for package "' + name + '"');
    }
    assert.ok(hasPath !== hasGit, 'package "' + name + '" source table must contain exactly one of "path" or "git"');

    if (hasPath) {
      assert.equal(typeof spec.path, "string", 'package "' + name + '" path must be a string');
      assert.ok(spec.path.length > 0, 'package "' + name + '" path must not be empty');
      source = { type: "path", path: spec.path };
    } else {
      assert.equal(typeof spec.git, "string", 'package "' + name + '" git URL must be a string');
      assert.ok(
        spec.git.startsWith("https://") || spec.git.startsWith("ssh://") || /^git@[^:]+:/.test(spec.git),
        'package "' + name + '" git URL must use HTTPS or SSH',
      );
      const refs = ["rev", "tag", "branch"].filter((key) => spec[key] !== undefined);
      assert.equal(refs.length, 1, 'package "' + name + '" git source must specify exactly one of rev, tag, or branch');
      const refType = refs[0];
      assert.equal(typeof spec[refType], "string", 'package "' + name + '" git ' + refType + " must be a string");
      assert.ok(spec[refType].length > 0, 'package "' + name + '" git ' + refType + " must not be empty");
      const subdirectory = spec.subdirectory ?? ".";
      assert.equal(typeof subdirectory, "string", 'package "' + name + '" git subdirectory must be a string');
      assert.ok(!path.isAbsolute(subdirectory), 'package "' + name + '" git subdirectory must be relative');
      assert.ok(!subdirectory.split(/[\\/]/).includes(".."), 'package "' + name + '" git subdirectory must not contain ".."');
      source = {
        type: "git",
        git: spec.git,
        refType,
        ref: spec[refType],
        subdirectory,
      };
    }
  }

  if (source.type === "registry" && versionSpec === "latest") {
    assert.equal(namespace, "preview", '"latest" is currently supported only for the Typst Universe preview registry');
  }

  return {
    namespace,
    name,
    versionSpec,
    source,
    manifestKey: packageManifestKey(namespace, name, versionSpec, source),
    license: metadata.license,
    licenseFile: metadata.license_file ?? metadata["license-file"],
    licenseUrl: metadata.license_url ?? metadata["license-url"],
    url: metadata.url,
  };
}

/**
 * Normalize the package/font manifest into the stable shape used by the
 * browser asset packager.
 *
 * [packages] is intentionally tailored to Typst packages rather than Cargo's
 * dependency aliases: a package name maps to one version, several versions,
 * a local directory, or a Git source.
 */
export function normalizeTomlAssetManifest(document) {
  assert.ok(isRecord(document), "TOML manifest must be a table");
  assert.ok(isRecord(document.package), "manifest must contain [package] metadata");

  const tinymist = document.package.metadata?.tinymist ?? {};
  const dependencyMetadata =
    tinymist.dependency_metadata ?? tinymist["dependency-metadata"] ?? {};
  const declarations = document.packages ?? {};

  assert.ok(
    isRecord(declarations),
    "manifest [packages] must be a table",
  );

  const packages = [];
  for (const [name, rawSpec] of Object.entries(declarations)) {
    assert.match(name, /^[A-Za-z0-9][A-Za-z0-9_-]*$/, "invalid Typst package name: " + name);
    const specs = Array.isArray(rawSpec) ? rawSpec : [rawSpec];
    assert.ok(specs.length > 0, 'package "' + name + '" must select at least one version or source');
    const metadata = dependencyMetadata[name] ?? {};
    assert.ok(isRecord(metadata), "metadata for package " + name + " must be a table");
    for (const spec of specs) {
      const namespace = metadata.namespace ?? (isRecord(spec) ? spec.namespace : undefined) ?? "preview";
      packages.push(normalizePackageSource(name, spec, metadata, namespace));
    }
  }

  const fonts = tinymist.fonts ?? {};
  assert.ok(isRecord(fonts), "manifest [package.metadata.tinymist.fonts] must be a table");
  const fontAssets = Object.entries(fonts).map(([alias, font]) => {
    assert.ok(isRecord(font), 'font "' + alias + '" must be a table');
    return {
      name: font.name ?? alias,
      file: font.file,
      url: font.url,
      license: font.license,
      licenseUrl: font.license_url ?? font["license-url"],
    };
  });

  const limits = tinymist.limits ?? {};
  const schemaVersion = tinymist.schema_version ?? tinymist["schema-version"] ?? 2;

  return {
    schemaVersion,
    limits: {
      maxTotalBytes: limits.max_total_bytes ?? limits["max-total-bytes"],
      maxPackageBytes: limits.max_package_bytes ?? limits["max-package-bytes"],
      maxFontBytes: limits.max_font_bytes ?? limits["max-font-bytes"],
    },
    packages,
    fonts: fontAssets,
  };
}

export async function parseTomlDocument(source) {
  tomlReady ??= initTomlEdit();
  await tomlReady;
  return parseToml(source);
}

export async function parseAssetManifestText(source, extension) {
  if (extension.toLowerCase() === ".json") {
    const legacy = JSON.parse(source);
    if (Array.isArray(legacy.packages) && legacy.packages.every((item) => item && item.name && item.version)) {
      return {
        schemaVersion: 2,
        limits: legacy.limits ?? {},
        packages: legacy.packages.map((item) => {
          const source = { type: "registry" };
          const versionSpec = item.version;
          return {
            namespace: item.namespace ?? "preview",
            name: item.name,
            versionSpec,
            source,
            manifestKey: packageManifestKey(item.namespace ?? "preview", item.name, versionSpec, source),
            license: item.license,
            licenseFile: item.licenseFile,
            licenseUrl: item.licenseUrl,
            url: item.url,
          };
        }),
        fonts: legacy.fonts ?? [],
      };
    }
    return legacy;
  }
  assert.equal(
    extension.toLowerCase(),
    ".toml",
    "asset manifests must use .toml or legacy .json format",
  );
  return normalizeTomlAssetManifest(await parseTomlDocument(source));
}

export async function readAssetManifest(manifestPath) {
  const source = await fs.readFile(manifestPath, "utf8");
  return parseAssetManifestText(source, path.extname(manifestPath));
}
