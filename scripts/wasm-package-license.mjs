import assert from "node:assert/strict";

const SPDX_OPERATORS = new Set(["AND", "OR", "WITH"]);

/**
 * Parse the SPDX expression grammar used by Typst package manifests and
 * return every distinct license and exception identifier in source order.
 * LicenseRef identifiers need an explicit notice source and are not guessed.
 */
export function extractSpdxLicenseIds(expression) {
  assert.equal(typeof expression, "string", "package license must be an SPDX expression");
  const compact = expression.replace(/\s+/g, "");
  const tokens = expression.match(/[A-Za-z0-9.+-]+|[()]/g) ?? [];
  assert.ok(tokens.length > 0 && tokens.join("") === compact, "unsupported SPDX license expression: " + expression);

  let position = 0;
  const identifiers = [];
  const peek = () => tokens[position];
  const take = () => tokens[position++];

  const isIdentifier = (token) =>
    typeof token === "string" && token !== "(" && token !== ")" && !SPDX_OPERATORS.has(token);

  function parsePrimary() {
    if (peek() === "(") {
      take();
      parseOr();
      assert.equal(take(), ")", "unclosed parenthesis in SPDX license expression: " + expression);
      return;
    }

    const licenseId = take();
    assert.ok(isIdentifier(licenseId), "expected SPDX license identifier in: " + expression);
    identifiers.push(licenseId);

    if (peek() === "WITH") {
      take();
      const exceptionId = take();
      assert.ok(isIdentifier(exceptionId), "expected SPDX exception identifier after WITH in: " + expression);
      identifiers.push(exceptionId);
    }
  }

  function parseAnd() {
    parsePrimary();
    while (peek() === "AND") {
      take();
      parsePrimary();
    }
  }

  function parseOr() {
    parseAnd();
    while (peek() === "OR") {
      take();
      parseAnd();
    }
  }

  parseOr();
  assert.equal(position, tokens.length, "unexpected token in SPDX license expression: " + expression);
  assert.ok(identifiers.length > 0, "SPDX license expression contains no license identifiers");
  assert.ok(
    identifiers.every((identifier) => !identifier.startsWith("LicenseRef-") && !identifier.startsWith("DocumentRef-")),
    "custom LicenseRef expressions require an explicit license-url override",
  );
  return [...new Set(identifiers)];
}

/**
 * Typst packages sometimes use LICENSE as a short SPDX pointer instead of
 * copying the full license text. In that case, resolve canonical SPDX texts.
 */
export function isSpdxLicensePointer(text, expression) {
  const normalizedText = String(text).replace(/\r\n/g, "\n").trim().replace(/\s+/g, " ");
  const normalizedExpression = String(expression).trim().replace(/\s+/g, " ");
  if (normalizedText === normalizedExpression) return true;

  // Some archives append "License" to a single SPDX identifier rather than
  // copying the actual license text (for example, "MIT License").
  return normalizedText === normalizedExpression + " License";
}

/**
 * Resolve the package's declared license. Typst's archive manifest is the
 * default source; explicit manifest metadata is reserved for exceptions.
 */
export function resolvePackageLicenseMetadata(packageManifest, overrides, packageId) {
  const declared = packageManifest?.package?.license;
  const license = overrides.license ?? declared;
  assert.ok(
    typeof license === "string" && license.trim().length > 0,
    "package " + packageId + " has no license in typst.toml; declare an explicit license override under [package.metadata.tinymist.dependency-metadata.<alias>]",
  );
  return {
    license: license.trim(),
    licenseFile: overrides.licenseFile ?? "LICENSE",
    licenseUrl: overrides.licenseUrl,
    declaredLicense: typeof declared === "string" ? declared.trim() : undefined,
  };
}
