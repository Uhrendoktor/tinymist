import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { parseTomlDocument, readAssetManifest } from "./wasm-assets-manifest.mjs";
import {
  extractSpdxLicenseIds,
  isSpdxLicensePointer,
  resolvePackageLicenseMetadata,
} from "./wasm-package-license.mjs";
import {
  copyPackageDirectory,
  fetchLatestTypstPackageVersion,
  checkoutGitPackage,
} from "./wasm-package-source.mjs";

const root = path.resolve(import.meta.dirname, "..");
const outputDir = path.join(root, "target", "wasm-assets");
const downloadCacheDir = path.join(root, "target", "wasm-assets-download-cache");
const packageDir = path.join(outputDir, "packages");
const fontDir = path.join(outputDir, "fonts");
const noticesDir = path.join(outputDir, "notices");

function parseArgs(argv) {
  const args = { manifest: "wasm-assets.toml", mode: "locked" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--manifest") {
      args.manifest = argv[++i];
      if (!args.manifest) throw new Error("--manifest requires a path");
    } else if (arg === "--locked") {
      args.mode = "locked";
    } else if (arg === "--update-lock") {
      args.mode = "update";
    } else {
      throw new Error("Unknown argument: " + arg);
    }
  }
  return args;
}

function safeSegment(value, label) {
  assert.equal(typeof value, "string", label + " must be a string");
  assert.match(value, /^[A-Za-z0-9][A-Za-z0-9._+-]*$/, label + " contains an unsafe path segment");
  assert.ok(!value.includes(".."), label + " must not contain '..'");
  return value;
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

async function fetchBytes(url, maxBytes, label, expectedSha256) {
  assert.match(url, /^https:\/\//, label + " URL must use HTTPS");
  const cachePath = path.join(downloadCacheDir, sha256(Buffer.from(url)) + ".bin");

  // Locked mode reuses only data whose bytes match the committed lock. Update
  // mode deliberately fetches again so it can record an intentional change.
  if (expectedSha256) {
    try {
      const cached = await fs.readFile(cachePath);
      if (cached.length <= maxBytes && sha256(cached) === expectedSha256) {
        console.log("Using SHA-256-verified cached " + label);
        return cached;
      }
      await fs.rm(cachePath, { force: true });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(label + " download failed: HTTP " + response.status + " from " + url);

  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) throw new Error(label + " exceeds its configured size limit");

  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > maxBytes) throw new Error(label + " exceeds its configured size limit");
    chunks.push(Buffer.from(chunk));
  }

  const bytes = Buffer.concat(chunks);
  await fs.mkdir(downloadCacheDir, { recursive: true });
  await fs.writeFile(cachePath, bytes);
  return bytes;
}

function packageKey(item) {
  return item.namespace + "/" + item.name + ":" + item.version;
}

function packageUrl(item) {
  return item.url || "https://packages.typst.org/" + item.namespace + "/" + item.name + "-" + item.version + ".tar.gz";
}

function packageLockRecord(id, manifestKey, version, source, digest, license, licenseNotices) {
  return { id, manifestKey, version, source, sha256: digest, license, licenseNotices };
}

function validateManifest(manifest) {
  assert.equal(manifest.schemaVersion, 2, "unsupported WASM asset manifest schema");
  assert.ok(Array.isArray(manifest.packages), "manifest.packages must be an array");
  assert.ok(Array.isArray(manifest.fonts), "manifest.fonts must be an array");
  const limits = {
    maxTotalBytes: manifest.limits?.maxTotalBytes ?? 157286400,
    maxPackageBytes: manifest.limits?.maxPackageBytes ?? 67108864,
    maxFontBytes: manifest.limits?.maxFontBytes ?? 33554432
  };
  for (const [key, value] of Object.entries(limits)) {
    assert.ok(Number.isSafeInteger(value) && value > 0, "limits." + key + " must be a positive integer");
  }

  const packageKeys = new Set();
  for (const item of manifest.packages) {
    safeSegment(item.namespace, "package namespace");
    safeSegment(item.name, "package name");
    assert.equal(typeof item.manifestKey, "string", "each package must have a manifest key");
    assert.ok(!packageKeys.has(item.manifestKey), "duplicate package declaration: " + item.manifestKey);
    packageKeys.add(item.manifestKey);
    assert.ok(item.source && typeof item.source === "object", "package " + item.name + " is missing its source");
    if (item.source.type === "registry") {
      assert.ok(
        item.versionSpec === "latest" || /^\d+\.\d+\.\d+$/.test(item.versionSpec),
        "registry package " + item.name + " requires a full version or latest",
      );
    } else if (item.source.type === "path") {
      assert.equal(typeof item.source.path, "string", "package path must be a string");
    } else if (item.source.type === "git") {
      assert.equal(typeof item.source.git, "string", "package Git URL must be a string");
      assert.ok(["rev", "tag", "branch"].includes(item.source.refType), "unsupported package Git reference type");
      assert.equal(typeof item.source.ref, "string", "package Git reference must be a string");
    } else {
      throw new Error("unsupported package source type for " + item.name);
    }
    if (item.license !== undefined) {
      assert.equal(typeof item.license, "string", "package license override must be a string");
    }
    if (item.licenseFile !== undefined) {
      assert.equal(typeof item.licenseFile, "string", "package license-file override must be a string");
      assert.ok(!path.isAbsolute(item.licenseFile), "package license-file must be relative to the package archive");
      assert.ok(!item.licenseFile.split(/[\\/]/).includes(".."), "package license-file must not contain '..'");
    }
    if (item.licenseUrl !== undefined) {
      assert.ok(item.licenseUrl.startsWith("https://"), "package license-url override must use HTTPS");
    }
  }

  const fontIds = new Set();
  const fontFiles = new Set();
  for (const item of manifest.fonts) {
    assert.ok(item.name && item.url && item.license && item.licenseUrl, "each font must declare name, url, license, and licenseUrl");
    safeSegment(item.file, "font file");
    assert.match(item.file, /\.(ttf|otf|ttc)$/i, "only TTF, OTF, and TTC font files are supported");
    const id = item.name;
    assert.ok(!fontIds.has(id), "duplicate font: " + id);
    assert.ok(!fontFiles.has(item.file), "duplicate font filename: " + item.file);
    fontIds.add(id);
    fontFiles.add(item.file);
  }
  return { limits, packageKeys, fontIds };
}
function validateArchive(archivePath) {
  const listing = execFileSync("tar", ["-tzf", archivePath], { encoding: "utf8" });
  const names = listing.split(/\r?\n/).filter(Boolean);
  assert.ok(names.length > 0, "package archive is empty");

  for (const name of names) {
    const normalized = name.replace(/\\/g, "/");
    assert.ok(!normalized.startsWith("/"), "package archive contains an absolute path: " + name);
    assert.ok(!normalized.split("/").includes(".."), "package archive contains path traversal: " + name);
  }

  const verbose = execFileSync("tar", ["-tvzf", archivePath], { encoding: "utf8" });
  for (const line of verbose.split(/\r?\n/).filter(Boolean)) {
    const type = line[0];
    assert.ok(type === "-" || type === "d" || type === "x" || type === "g",
      "package archive contains a non-regular entry (links and special files are forbidden): " + line);
  }
}

async function listFiles(directory) {
  const result = [];
  async function visit(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const stat = await fs.lstat(absolute);
      assert.ok(!stat.isSymbolicLink(), "asset bundle contains a symbolic link: " + absolute);
      if (stat.isDirectory()) {
        await visit(absolute);
      } else {
        assert.ok(stat.isFile(), "asset bundle contains an unsupported file: " + absolute);
        result.push(absolute);
      }
    }
  }
  await visit(directory);
  return result;
}

function extractPackage(archivePath, destination) {
  validateArchive(archivePath);
  execFileSync("tar", [
    "-xzf", archivePath,
    "-C", destination,
    "--no-same-owner",
    "--no-same-permissions"
  ], { stdio: "inherit" });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = path.resolve(root, args.manifest);
  const manifestDirectory = path.dirname(manifestPath);
  assert.match(manifestPath, /\.(?:toml|json)$/i, "asset manifest must be a TOML or JSON file");
  const manifest = await readAssetManifest(manifestPath);
  const { limits, packageKeys, fontIds } = validateManifest(manifest);
  const manifestLabel = path.basename(manifestPath);
  const lockPath = manifestPath.replace(/\.(?:toml|json)$/i, ".lock.json");
  let previousLock = { schemaVersion: 3, packages: [], fonts: [] };

  if (args.mode === "locked") {
    previousLock = JSON.parse(await fs.readFile(lockPath, "utf8"));
    assert.equal(previousLock.schemaVersion, 3, "unsupported asset lock schema; regenerate it with --update-lock");
    assert.equal(previousLock.manifest, manifestLabel, "asset lock belongs to a different manifest");
    assert.ok(Array.isArray(previousLock.packages) && Array.isArray(previousLock.fonts), "invalid asset lock");
    assert.deepEqual(
      previousLock.packages.map((item) => item.manifestKey).sort(),
      [...packageKeys].sort(),
      "package lock does not match the manifest; run with --update-lock and commit the generated lock"
    );
    assert.deepEqual(
      previousLock.fonts.map((item) => item.id).sort(),
      [...fontIds].sort(),
      "font lock does not match the manifest; run with --update-lock and commit the generated lock"
    );
  }

  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.mkdir(packageDir, { recursive: true });
  await fs.mkdir(fontDir, { recursive: true });
  await fs.mkdir(noticesDir, { recursive: true });

  let totalBytes = 0;
  const packageLock = [];
  const fontLock = [];
  const resolvedPackageIds = new Set();
  const noticeLines = [
    "Third-party assets bundled into Tinymist's browser WebAssembly module.",
    "The corresponding asset bytes are embedded in tinymist_bg.wasm; this file records their redistribution notices.",
    ""
  ];

  const previousPackages = new Map(previousLock.packages.map((item) => [item.manifestKey, item]));
  for (let packageIndex = 0; packageIndex < manifest.packages.length; packageIndex += 1) {
    const item = manifest.packages[packageIndex];
    const previous = previousPackages.get(item.manifestKey);
    if (args.mode === "locked") {
      assert.ok(previous, "package lock is missing " + item.manifestKey);
      assert.ok(Array.isArray(previous.licenseNotices), "package lock is missing resolved license notices for " + item.manifestKey);
    }

    const stagingDirectory = path.join(outputDir, "staging-" + packageIndex);
    await fs.rm(stagingDirectory, { recursive: true, force: true });

    let version;
    let digest;
    let sourceBytes = 0;
    let sourceRecord;
    if (item.source.type === "registry") {
      version = item.versionSpec === "latest"
        ? (args.mode === "locked" ? previous.version : await fetchLatestTypstPackageVersion(item.name, item.namespace))
        : item.versionSpec;
      safeSegment(version, "resolved package version");
      const resolvedItem = { ...item, version };
      const url = packageUrl(resolvedItem);
      sourceRecord = { type: "registry", url };
      if (args.mode === "locked") {
        assert.deepEqual(previous.source, sourceRecord, "package source changed for " + item.manifestKey + "; update the lock");
      }

      const archive = await fetchBytes(
        url,
        limits.maxPackageBytes,
        "package " + item.namespace + "/" + item.name + ":" + version,
        args.mode === "locked" ? previous.sha256 : undefined,
      );
      digest = sha256(archive);
      sourceBytes = archive.length;
      const safeArchive = path.join(outputDir, "download-" + packageIndex + ".tar.gz");
      await fs.writeFile(safeArchive, archive);
      await fs.mkdir(stagingDirectory, { recursive: true });
      extractPackage(safeArchive, stagingDirectory);
      await fs.rm(safeArchive, { force: true });
    } else if (item.source.type === "path") {
      sourceRecord = { type: "path", path: item.source.path };
      if (args.mode === "locked") {
        assert.deepEqual(previous.source, sourceRecord, "local package path changed for " + item.manifestKey + "; update the lock");
      }
      const sourceDirectory = path.resolve(manifestDirectory, item.source.path);
      const copied = await copyPackageDirectory(sourceDirectory, stagingDirectory);
      digest = copied.sha256;
      sourceBytes = copied.bytes;
    } else {
      const sourceSpec = {
        type: "git",
        git: item.source.git,
        refType: item.source.refType,
        ref: item.source.ref,
        subdirectory: item.source.subdirectory || ".",
      };
      if (args.mode === "locked") {
        const previousSourceSpec = { ...previous.source };
        delete previousSourceSpec.commit;
        assert.deepEqual(previousSourceSpec, sourceSpec, "Git package source changed for " + item.manifestKey + "; update the lock");
      }
      const checkout = await checkoutGitPackage(
        item.source,
        args.mode === "locked" ? previous.source.commit : undefined,
        path.join(outputDir, "git-" + packageIndex),
      );
      sourceRecord = { ...sourceSpec, commit: checkout.commit };
      if (args.mode === "locked") {
        assert.equal(checkout.commit, previous.source.commit, "Git commit changed for " + item.manifestKey);
      }
      try {
        const copied = await copyPackageDirectory(checkout.packageDirectory, stagingDirectory);
        digest = copied.sha256;
        sourceBytes = copied.bytes;
      } finally {
        await fs.rm(checkout.repositoryDirectory, { recursive: true, force: true });
      }
    }

    if (sourceBytes > limits.maxPackageBytes) {
      throw new Error("package " + item.name + " exceeds maxPackageBytes");
    }
    totalBytes += sourceBytes;
    if (totalBytes > limits.maxTotalBytes) throw new Error("WASM assets exceed maxTotalBytes");

    const packageTomlPath = path.join(stagingDirectory, "typst.toml");
    const packageToml = await fs.readFile(packageTomlPath, "utf8").catch((error) => {
      if (error?.code === "ENOENT") {
        throw new Error("package source " + item.name + " does not contain typst.toml; every bundled package must declare its name and version there");
      }
      throw error;
    });
    const packageManifest = await parseTomlDocument(packageToml);
    assert.equal(packageManifest.package?.name, item.name, "package name in typst.toml does not match [packages] key " + item.name);
    version = packageManifest.package?.version;
    assert.equal(typeof version, "string", "package " + item.name + " typst.toml must declare a version");
    assert.match(version, /^\d+\.\d+\.\d+$/, "package " + item.name + " must declare a full x.y.z version");
    if (item.source.type === "registry" && item.versionSpec !== "latest") {
      assert.equal(version, item.versionSpec, "downloaded package version does not match the requested version for " + item.name);
    }
    if (args.mode === "locked" && item.versionSpec === "latest") {
      assert.equal(version, previous.version, "locked latest package version changed for " + item.name);
    }
    safeSegment(version, "package version");
    const id = packageKey({ ...item, version });
    assert.ok(!resolvedPackageIds.has(id), "duplicate resolved Typst package: " + id);
    resolvedPackageIds.add(id);

    const destination = path.join(packageDir, item.namespace, item.name, version);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.rm(destination, { recursive: true, force: true });
    await fs.rename(stagingDirectory, destination);

    const resolvedLicense = resolvePackageLicenseMetadata(packageManifest, item, id);
    const licenseNotices = [];
    const noticeTexts = [];
    if (resolvedLicense.licenseUrl) {
      const previousNotice = previous?.licenseNotices?.find((notice) => notice.url === resolvedLicense.licenseUrl);
      if (args.mode === "locked") {
        assert.ok(previousNotice, "package lock is missing the explicit license notice for " + id);
      }
      const notice = await fetchBytes(
        resolvedLicense.licenseUrl,
        256 * 1024,
        "license notice for " + id,
        args.mode === "locked" ? previousNotice.sha256 : undefined,
      );
      const digestNotice = sha256(notice);
      licenseNotices.push({ url: resolvedLicense.licenseUrl, sha256: digestNotice });
      noticeTexts.push({ source: resolvedLicense.licenseUrl, bytes: notice });
    } else {
      const licensePath = path.resolve(destination, resolvedLicense.licenseFile);
      assert.ok(
        licensePath.startsWith(destination + path.sep),
        "package license-file must stay inside the extracted package",
      );
      let archiveLicense;
      try {
        archiveLicense = await fs.readFile(licensePath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        if (item.licenseFile) {
          throw new Error("configured license-file " + item.licenseFile + " was not found in " + id);
        }
      }

      if (archiveLicense && !isSpdxLicensePointer(archiveLicense.toString("utf8"), resolvedLicense.license)) {
        const digestNotice = sha256(archiveLicense);
        licenseNotices.push({
          source: "archive:" + resolvedLicense.licenseFile,
          sha256: digestNotice,
        });
        noticeTexts.push({
          source: "archive:" + resolvedLicense.licenseFile,
          bytes: archiveLicense,
        });
      } else {
        const licenseIds = extractSpdxLicenseIds(resolvedLicense.license);
        for (const licenseId of licenseIds) {
          const licenseUrl = "https://raw.githubusercontent.com/spdx/license-list-data/main/text/" +
            encodeURIComponent(licenseId) + ".txt";
          const previousNotice = previous?.licenseNotices?.find((notice) => notice.id === licenseId);
          if (args.mode === "locked") {
            assert.ok(previousNotice, "package lock is missing SPDX license text " + licenseId + " for " + id);
          }
          const notice = await fetchBytes(
            licenseUrl,
            256 * 1024,
            "SPDX license text " + licenseId + " for " + id,
            args.mode === "locked" ? previousNotice.sha256 : undefined,
          );
          const digestNotice = sha256(notice);
          licenseNotices.push({ id: licenseId, url: licenseUrl, sha256: digestNotice });
          noticeTexts.push({ source: "SPDX:" + licenseId, bytes: notice });
        }
      }
    }

    const packageRecord = packageLockRecord(
      id,
      item.manifestKey,
      version,
      sourceRecord,
      digest,
      resolvedLicense.license,
      licenseNotices,
    );
    if (args.mode === "locked") {
      assert.deepEqual(packageRecord, previous, "resolved package source, license or lock record changed for " + id + "; update the lock");
    }
    packageLock.push(packageRecord);
    const packageSourceLabel = sourceRecord.type === "registry"
      ? sourceRecord.url
      : sourceRecord.type === "path"
        ? "path:" + sourceRecord.path
        : sourceRecord.git + "@" + sourceRecord.commit;
    noticeLines.push(id + " — " + resolvedLicense.license + " — " + packageSourceLabel);
    for (let noticeIndex = 0; noticeIndex < noticeTexts.length; noticeIndex += 1) {
      const notice = noticeTexts[noticeIndex];
      const filename = id.replace(/[/:]/g, "-") + "-" + (noticeIndex + 1) + ".txt";
      await fs.writeFile(path.join(noticesDir, filename), notice.bytes);
      noticeLines.push("License notice source: " + notice.source);
      noticeLines.push(notice.bytes.toString("utf8"));
      noticeLines.push("");
    }
  }

  const previousFonts = new Map(previousLock.fonts.map((item) => [item.id, item]));
  for (const item of manifest.fonts) {
    const id = item.name;
    const previous = previousFonts.get(id);
    if (args.mode === "locked") {
      assert.equal(previous.url, item.url, "font URL changed for " + id + "; update the lock");
      assert.equal(previous.file, item.file, "font filename changed for " + id + "; update the lock");
      assert.equal(previous.license, item.license, "font license changed for " + id + "; update the lock");
      assert.equal(previous.licenseUrl, item.licenseUrl, "font license URL changed for " + id + "; update the lock");
    }

    const bytes = await fetchBytes(
      item.url,
      limits.maxFontBytes,
      "font " + id,
      args.mode === "locked" ? previous.sha256 : undefined,
    );
    const digest = sha256(bytes);
    if (args.mode === "locked") {
      assert.equal(digest, previous.sha256, "SHA-256 mismatch for font " + id);
    }
    totalBytes += bytes.length;
    if (totalBytes > limits.maxTotalBytes) throw new Error("WASM assets exceed maxTotalBytes");

    await fs.writeFile(path.join(fontDir, item.file), bytes);
    const notice = await fetchBytes(
      item.licenseUrl,
      256 * 1024,
      "license notice for font " + id,
      args.mode === "locked" ? previous.licenseSha256 : undefined,
    );
    const licenseDigest = sha256(notice);
    if (args.mode === "locked") {
      assert.equal(licenseDigest, previous.licenseSha256, "license notice SHA-256 mismatch for font " + id);
    }
    await fs.writeFile(path.join(noticesDir, id.replace(/[^A-Za-z0-9._+-]/g, "-") + ".txt"), notice);
    fontLock.push({
      id,
      url: item.url,
      sha256: digest,
      license: item.license,
      licenseUrl: item.licenseUrl,
      licenseSha256: licenseDigest,
      file: item.file,
    });
    noticeLines.push(id + " — " + item.license + " — " + item.url);
    noticeLines.push(notice.toString("utf8"));
    noticeLines.push("");
  }

  const selectedPackages = new Set(packageLock.map((item) => item.id));
  for (const packagePath of await listFiles(packageDir)) {
    if (!packagePath.endsWith(".typ")) continue;
    const source = await fs.readFile(packagePath, "utf8");
    const uncommented = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const pattern = /^\s*#(?:import|include)\s+["']@([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+):([0-9A-Za-z.+-]+)["']/gm;
    for (const match of uncommented.matchAll(pattern)) {
      const dependency = match[1] + "/" + match[2] + ":" + match[3];
      if (!selectedPackages.has(dependency)) {
        throw new Error(
          "Unbundled transitive Typst package " + dependency + " referenced in " +
          path.relative(outputDir, packagePath) + ". Add its version to [packages] in " + manifestLabel
        );
      }
    }
  }

  const notices = noticeLines.join("\n").trimEnd() + "\n";
  await fs.writeFile(path.join(outputDir, "THIRD-PARTY-NOTICES.txt"), notices);

  const lock = {
    schemaVersion: 3,
    manifest: manifestLabel,
    packages: packageLock,
    fonts: fontLock
  };
  if (args.mode === "update") {
    await fs.writeFile(lockPath, JSON.stringify(lock, null, 2) + "\n");
    console.log("Updated asset lock: " + path.relative(root, lockPath));
  } else {
    assert.deepEqual(packageLock, previousLock.packages, "package lock contents changed");
    assert.deepEqual(fontLock, previousLock.fonts, "font lock contents changed");
  }
  await fs.writeFile(path.join(outputDir, "wasm-assets.lock.json"), JSON.stringify(lock, null, 2) + "\n");

  const embeddedFiles = [...await listFiles(packageDir), ...await listFiles(fontDir)];
  let embeddedBytes = 0;
  for (const file of embeddedFiles) {
    embeddedBytes += (await fs.stat(file)).size;
  }
  if (embeddedBytes > limits.maxTotalBytes) {
    throw new Error("Expanded WASM asset bytes exceed maxTotalBytes");
  }
  const packageFileCount = (await listFiles(packageDir)).length;
  const fontFileCount = (await listFiles(fontDir)).length;
  console.log(
    "Bundled " + packageLock.length + " package(s), " + fontIds.size + " font(s), " +
    packageFileCount + " package file(s), " + fontFileCount + " font file(s), " +
    totalBytes + " source bytes and " + embeddedBytes + " embedded bytes. " +
    "Runtime asset loading is WASM-only."
  );
}
await main();
