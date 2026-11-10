import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

export function comparePackageVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  assert.ok(a.length === 3 && a.every(Number.isSafeInteger), "invalid Typst package version: " + left);
  assert.ok(b.length === 3 && b.every(Number.isSafeInteger), "invalid Typst package version: " + right);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

export function selectLatestTypstPackageVersion(index, name, namespace = "preview") {
  assert.equal(namespace, "preview", '"latest" is available only from Typst Universe preview');
  assert.ok(Array.isArray(index), "Typst package index has an unexpected format");
  const versions = [...new Set(index
    .filter((item) => item?.name === name && typeof item.version === "string" && /^\d+\.\d+\.\d+$/.test(item.version))
    .map((item) => item.version))];
  assert.ok(versions.length > 0, "no published versions found for @" + namespace + "/" + name);
  versions.sort(comparePackageVersions);
  return versions.at(-1);
}

export async function fetchLatestTypstPackageVersion(name, namespace = "preview") {
  assert.equal(namespace, "preview", '"latest" is available only from Typst Universe preview');
  const url = "https://packages.typst.org/preview/index.json";
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error("Typst package index download failed: HTTP " + response.status);
  const declared = Number(response.headers.get("content-length") || 0);
  assert.ok(!declared || declared <= 32 * 1024 * 1024, "Typst package index exceeds its configured size limit");
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    assert.ok(total <= 32 * 1024 * 1024, "Typst package index exceeds its configured size limit");
    chunks.push(Buffer.from(chunk));
  }
  const index = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return selectLatestTypstPackageVersion(index, name, namespace);
}
/**
 * Copy a package directory without following links or including its Git
 * metadata. The digest is independent of mtimes and directory traversal order.
 */
export async function copyPackageDirectory(sourceDirectory, destinationDirectory) {
  const source = await fs.realpath(sourceDirectory);
  await fs.mkdir(destinationDirectory, { recursive: true });

  async function copyTree(currentSource, currentDestination) {
    const entries = await fs.readdir(currentSource, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const sourcePath = path.join(currentSource, entry.name);
      const destinationPath = path.join(currentDestination, entry.name);
      const stat = await fs.lstat(sourcePath);
      assert.ok(!stat.isSymbolicLink(), "package source contains a symbolic link: " + sourcePath);
      if (stat.isDirectory()) {
        await fs.mkdir(destinationPath, { recursive: true });
        await copyTree(sourcePath, destinationPath);
      } else {
        assert.ok(stat.isFile(), "package source contains an unsupported file: " + sourcePath);
        await fs.copyFile(sourcePath, destinationPath);
      }
    }
  }

  await copyTree(source, destinationDirectory);
  const files = [];
  async function list(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await list(absolute);
      else files.push(absolute);
    }
  }
  await list(destinationDirectory);

  const hash = createHash("sha256");
  let totalBytes = 0;
  for (const file of files) {
    const relative = path.relative(destinationDirectory, file).split(path.sep).join("/");
    const bytes = await fs.readFile(file);
    totalBytes += bytes.length;
    hash.update(relative);
    hash.update(Buffer.from([0]));
    hash.update(String(bytes.length));
    hash.update(Buffer.from([0]));
    hash.update(bytes);
  }
  return { sha256: hash.digest("hex"), bytes: totalBytes };
}

export async function checkoutGitPackage(source, requestedCommit, destinationDirectory) {
  const repositoryDirectory = destinationDirectory + "-repository";
  await fs.mkdir(repositoryDirectory, { recursive: true });
  execFileSync("git", ["init", "-q", repositoryDirectory], { stdio: "inherit" });
  const git = (args) => execFileSync("git", args, {
    cwd: repositoryDirectory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();

  git(["remote", "add", "origin", source.git]);
  let fetchRef = requestedCommit;
  if (!fetchRef) {
    if (source.refType === "branch") fetchRef = "refs/heads/" + source.ref;
    else if (source.refType === "tag") fetchRef = "refs/tags/" + source.ref;
    else fetchRef = source.ref;
  }
  git(["fetch", "--depth=1", "origin", fetchRef]);
  git(["checkout", "--quiet", "--detach", "FETCH_HEAD"]);
  const commit = git(["rev-parse", "HEAD"]);
  const packageDirectory = path.resolve(repositoryDirectory, source.subdirectory || ".");
  assert.ok(
    packageDirectory === repositoryDirectory || packageDirectory.startsWith(repositoryDirectory + path.sep),
    "Git package subdirectory escapes the repository",
  );
  return { repositoryDirectory, packageDirectory, commit };
}
