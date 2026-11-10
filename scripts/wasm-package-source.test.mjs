import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  comparePackageVersions,
  selectLatestTypstPackageVersion,
  copyPackageDirectory,
  checkoutGitPackage,
} from "./wasm-package-source.mjs";

test("compares Typst package versions numerically", () => {
  assert.ok(comparePackageVersions("0.10.0", "0.9.9") > 0);
  assert.equal(comparePackageVersions("1.2.3", "1.2.3"), 0);
  assert.ok(comparePackageVersions("1.2.2", "1.2.3") < 0);
});

test("selects the highest published version from the Typst package index", () => {
  const index = [
    { name: "cetz", version: "0.9.9" },
    { name: "other", version: "9.9.9" },
    { name: "cetz", version: "0.10.0" },
    { name: "cetz", version: "0.10.0" },
    { name: "cetz", version: "nightly" },
  ];
  assert.equal(selectLatestTypstPackageVersion(index, "cetz"), "0.10.0");
  assert.throws(() => selectLatestTypstPackageVersion(index, "missing"), /no published versions/);
});

test("copies local package files and calculates a stable content digest", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tinymist-package-source-"));
  const source = path.join(root, "source");
  const first = path.join(root, "first");
  const second = path.join(root, "second");
  await fs.mkdir(path.join(source, "src"), { recursive: true });
  await fs.mkdir(path.join(source, ".git", "objects"), { recursive: true });
  await fs.writeFile(path.join(source, "typst.toml"), '[package]\nname = "local"\nversion = "1.2.3"\n');
  await fs.writeFile(path.join(source, "src", "lib.typ"), "#let answer = 42\n");
  await fs.writeFile(path.join(source, ".git", "objects", "private"), "must not be copied");

  const copiedA = await copyPackageDirectory(source, first);
  const copiedB = await copyPackageDirectory(source, second);
  assert.equal(copiedA.sha256, copiedB.sha256);
  assert.equal(copiedA.bytes, copiedB.bytes);
  assert.equal(
    await fs.readFile(path.join(first, "src", "lib.typ"), "utf8"),
    "#let answer = 42\n",
  );
  await assert.rejects(fs.access(path.join(first, ".git")));
  await fs.rm(root, { recursive: true, force: true });
});

test("rejects symbolic links in local package directories", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tinymist-package-source-link-"));
  const source = path.join(root, "source");
  const destination = path.join(root, "destination");
  await fs.mkdir(source);
  await fs.writeFile(path.join(root, "outside.typ"), "#let unsafe = true");
  await fs.symlink(path.join(root, "outside.typ"), path.join(source, "linked.typ"));
  await assert.rejects(copyPackageDirectory(source, destination), /symbolic link/);
  await fs.rm(root, { recursive: true, force: true });
});

test("checks out a selected Git branch and pinned commit", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tinymist-git-package-"));
  const repository = path.join(root, "repository");
  await fs.mkdir(path.join(repository, "packages", "demo"), { recursive: true });
  const runGit = (args, cwd = repository) => {
    const { execFileSync } = await import("node:child_process");
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  };
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["init", "-q", "-b", "main", repository]);
  execFileSync("git", ["config", "user.name", "Tinymist Tests"], { cwd: repository });
  execFileSync("git", ["config", "user.email", "tests@example.invalid"], { cwd: repository });
  await fs.writeFile(path.join(repository, "packages", "demo", "typst.toml"), '[package]\\nname = "demo"\\nversion = "1.2.3"\\n');
  execFileSync("git", ["add", "."], { cwd: repository });
  execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: repository });
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();

  const source = {
    git: repository,
    refType: "branch",
    ref: "main",
    subdirectory: "packages/demo",
  };
  const first = await checkoutGitPackage(source, undefined, path.join(root, "first"));
  assert.equal(first.commit, commit);
  assert.equal(await fs.readFile(path.join(first.packageDirectory, "typst.toml"), "utf8"),
    '[package]\\nname = "demo"\\nversion = "1.2.3"\\n');

  const second = await checkoutGitPackage(source, commit, path.join(root, "second"));
  assert.equal(second.commit, commit);
  await fs.rm(root, { recursive: true, force: true });
});
