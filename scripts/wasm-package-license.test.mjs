import assert from "node:assert/strict";
import test from "node:test";

import { parseTomlDocument } from "./wasm-assets-manifest.mjs";
import {
  extractSpdxLicenseIds,
  isSpdxLicensePointer,
  resolvePackageLicenseMetadata,
} from "./wasm-package-license.mjs";

test("extracts all license and exception identifiers from an SPDX expression", () => {
  assert.deepEqual(extractSpdxLicenseIds("MIT OR Apache-2.0"), ["MIT", "Apache-2.0"]);
  assert.deepEqual(
    extractSpdxLicenseIds("(GPL-3.0-or-later WITH Classpath-exception-2.0) AND MIT"),
    ["GPL-3.0-or-later", "Classpath-exception-2.0", "MIT"],
  );
});

test("rejects non-SPDX custom license references for automatic lookup", () => {
  assert.throws(
    () => extractSpdxLicenseIds("LicenseRef-Company-Internal"),
    /explicit license-url override/,
  );
});

test("recognizes SPDX pointer files but not full license text", () => {
  assert.equal(isSpdxLicensePointer("MIT OR Apache-2.0\\n", "MIT OR Apache-2.0"), true);
  assert.equal(isSpdxLicensePointer("MIT License", "MIT"), true);
  assert.equal(
    isSpdxLicensePointer(
      "MIT License\\n\\nCopyright (c) 2026 Example\\n\\nPermission is hereby granted, free of charge...",
      "MIT",
    ),
    false,
  );
});

test("uses typst.toml license metadata by default", () => {
  assert.deepEqual(
    resolvePackageLicenseMetadata({ package: { license: "LGPL-3.0-or-later" } }, {}, "preview/cetz:0.5.3"),
    {
      license: "LGPL-3.0-or-later",
      licenseFile: "LICENSE",
      licenseUrl: undefined,
      declaredLicense: "LGPL-3.0-or-later",
    },
  );
});

test("allows explicit overrides for packages outside the Typst registry", () => {
  assert.deepEqual(
    resolvePackageLicenseMetadata(
      {},
      {
        license: "MIT",
        licenseFile: "LICENSES/NOTICE",
        licenseUrl: "https://example.invalid/LICENSE",
      },
      "local/my-package:1.0.0",
    ),
    {
      license: "MIT",
      licenseFile: "LICENSES/NOTICE",
      licenseUrl: "https://example.invalid/LICENSE",
      declaredLicense: undefined,
    },
  );
});

test("requires a declared or explicitly overridden package license", () => {
  assert.throws(
    () => resolvePackageLicenseMetadata({ package: { name: "example" } }, {}, "preview/example:1.0.0"),
    /has no license in typst.toml/,
  );
});

test("reads the declared license from a real Typst package manifest", async () => {
  const manifest = await parseTomlDocument(
    `[package]
name = "example"
version = "1.2.3"
entrypoint = "lib.typ"
license = "MIT OR Apache-2.0"
`,
  );
  assert.equal(manifest.package.name, "example");
  assert.equal(manifest.package.license, "MIT OR Apache-2.0");
});
