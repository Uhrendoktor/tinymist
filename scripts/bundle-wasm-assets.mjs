import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const outputDir = path.join(root, "target", "wasm-assets");
const packageDir = path.join(outputDir, "packages");
const fontDir = path.join(outputDir, "fonts");
const noticesDir = path.join(outputDir, "notices");

function parseArgs(argv) {
  const args = { manifest: "wasm-assets.json", mode: "locked" };
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

async function fetchBytes(url, maxBytes, label) {
  assert.match(url, /^https:\/\//, label + " URL must use HTTPS");
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
  return Buffer.concat(chunks);
}

function packageKey(item) {
  return item.namespace + "/" + item.name + ":" + item.version;
}

function packageUrl(item) {
  return item.url || "https://packages.typst.org/" + item.namespace + "/" + item.name + "-" + item.version + ".tar.gz";
}

function lockRecord(id, item, url, digest, licenseDigest) {
  return {
    id,
    url,
    sha256: digest,
    license: item.license,
    licenseUrl: item.licenseUrl,
    licenseSha256: licenseDigest
  };
}

function validateManifest(manifest) {
  assert.equal(manifest.schemaVersion, 1, "unsupported WASM asset manifest schema");
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

  const packageIds = new Set();
  for (const item of manifest.packages) {
    safeSegment(item.namespace, "package namespace");
    safeSegment(item.name, "package name");
    safeSegment(item.version, "package version");
    assert.ok(item.license && item.licenseUrl, "each package must declare license and licenseUrl");
    const id = packageKey(item);
    assert.ok(!packageIds.has(id), "duplicate package: " + id);
    packageIds.add(id);
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
  return { limits, packageIds, fontIds };
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
  assert.ok(manifestPath.startsWith(root + path.sep), "manifest must be inside the repository");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const { limits, packageIds, fontIds } = validateManifest(manifest);
  const relativeManifest = path.relative(root, manifestPath).replace(/\\/g, "/");
  assert.match(manifestPath, /\.json$/i, "asset manifest must be a JSON file");
  const lockPath = manifestPath.replace(/\.json$/i, ".lock.json");
  let previousLock = { schemaVersion: 1, packages: [], fonts: [] };

  if (args.mode === "locked") {
    previousLock = JSON.parse(await fs.readFile(lockPath, "utf8"));
    assert.equal(previousLock.schemaVersion, 1, "unsupported asset lock schema");
    assert.equal(previousLock.manifest, relativeManifest, "asset lock belongs to a different manifest");
    assert.ok(Array.isArray(previousLock.packages) && Array.isArray(previousLock.fonts), "invalid asset lock");
    assert.deepEqual(
      previousLock.packages.map((item) => item.id).sort(),
      [...packageIds].sort(),
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
  const noticeLines = [
    "Third-party assets bundled into Tinymist's browser WebAssembly module.",
    "The corresponding asset bytes are embedded in tinymist_bg.wasm; this file records their redistribution notices.",
    ""
  ];

  const previousPackages = new Map(previousLock.packages.map((item) => [item.id, item]));
  for (const item of manifest.packages) {
    const id = packageKey(item);
    const url = packageUrl(item);
    const previous = previousPackages.get(id);
    if (args.mode === "locked") {
      assert.equal(previous.url, url, "package URL changed for " + id + "; update the lock");
      assert.equal(previous.license, item.license, "package license changed for " + id + "; update the lock");
      assert.equal(previous.licenseUrl, item.licenseUrl, "package license URL changed for " + id + "; update the lock");
    }

    const archive = await fetchBytes(url, limits.maxPackageBytes, "package " + id);
    const digest = sha256(archive);
    if (args.mode === "locked") {
      assert.equal(digest, previous.sha256, "SHA-256 mismatch for package " + id);
    }
    totalBytes += archive.length;
    if (totalBytes > limits.maxTotalBytes) throw new Error("WASM assets exceed maxTotalBytes");

    const safeArchive = path.join(outputDir, "download-" + packageLock.length + ".tar.gz");
    await fs.writeFile(safeArchive, archive);
    const destination = path.join(packageDir, item.namespace, item.name, item.version);
    await fs.mkdir(destination, { recursive: true });
    extractPackage(safeArchive, destination);
    await fs.rm(safeArchive, { force: true });

    const notice = await fetchBytes(item.licenseUrl, 256 * 1024, "license notice for " + id);
    const licenseDigest = sha256(notice);
    if (args.mode === "locked") {
      assert.equal(licenseDigest, previous.licenseSha256, "license notice SHA-256 mismatch for package " + id);
    }
    await fs.writeFile(path.join(noticesDir, id.replace(/[/:]/g, "-") + ".txt"), notice);
    packageLock.push(lockRecord(id, item, url, digest, licenseDigest));
    noticeLines.push(id + " — " + item.license + " — " + url);
    noticeLines.push(notice.toString("utf8"));
    noticeLines.push("");
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

    const bytes = await fetchBytes(item.url, limits.maxFontBytes, "font " + id);
    const digest = sha256(bytes);
    if (args.mode === "locked") {
      assert.equal(digest, previous.sha256, "SHA-256 mismatch for font " + id);
    }
    totalBytes += bytes.length;
    if (totalBytes > limits.maxTotalBytes) throw new Error("WASM assets exceed maxTotalBytes");

    await fs.writeFile(path.join(fontDir, item.file), bytes);
    const notice = await fetchBytes(item.licenseUrl, 256 * 1024, "license notice for font " + id);
    const licenseDigest = sha256(notice);
    if (args.mode === "locked") {
      assert.equal(licenseDigest, previous.licenseSha256, "license notice SHA-256 mismatch for font " + id);
    }
    await fs.writeFile(path.join(noticesDir, id.replace(/[^A-Za-z0-9._+-]/g, "-") + ".txt"), notice);
    fontLock.push({ ...lockRecord(id, item, item.url, digest, licenseDigest), file: item.file });
    noticeLines.push(id + " — " + item.license + " — " + item.url);
    noticeLines.push(notice.toString("utf8"));
    noticeLines.push("");
  }

  const selectedPackages = new Set(packageIds);
  for (const packagePath of await listFiles(packageDir)) {
    if (!packagePath.endsWith(".typ")) continue;
    const source = await fs.readFile(packagePath, "utf8");
    const pattern = /@([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+):([0-9A-Za-z.+-]+)/g;
    for (const match of source.matchAll(pattern)) {
      const dependency = match[1] + "/" + match[2] + ":" + match[3];
      if (!selectedPackages.has(dependency)) {
        throw new Error(
          "Unbundled transitive Typst package " + dependency + " referenced in " +
          path.relative(outputDir, packagePath) + ". Add its exact version to " + relativeManifest
        );
      }
    }
  }

  const notices = noticeLines.join("\n").trimEnd() + "\n";
  await fs.writeFile(path.join(outputDir, "THIRD-PARTY-NOTICES.txt"), notices);

  const lock = {
    schemaVersion: 1,
    manifest: relativeManifest,
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
    "Bundled " + packageIds.size + " package(s), " + fontIds.size + " font(s), " +
    packageFileCount + " package file(s), " + fontFileCount + " font file(s), " +
    totalBytes + " downloaded bytes and " + embeddedBytes + " embedded bytes. " +
    "Runtime asset loading is WASM-only."
  );
}

await main();
