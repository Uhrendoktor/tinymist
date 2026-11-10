import assert from "node:assert/strict";

const SPDX_OPERATORS = new Set(["AND", "OR", "WITH"]);

/**
 * Extract SPDX license and exception identifiers from a Typst package's
 * declared SPDX expression. LicenseRef identifiers need an explicit notice
 * source and are intentionally not guessed.
 */
export function extractSpdxLicenseIds(expression) {
  assert.equal(typeof expression, "string", "package license must be an SPDX expression");
  const compact = expression.replace(/\\s+/g, "");
  const tokens = compact.match(/[A-Za-z0-9.+-]+|[()]/g) ?? [];
  assert.ok(tokens.length > 0 && tokens.join("") === compact, "unsupported SPDX license expression: " + expression);

  const identifiers = tokens.filter((token) => token !== "(" && token !== ")" && !SPDX_OPERATORS.has(token));
  assert.ok(identifiers.length > 0, "SPDX license expression contains no license identifiers");
  assert.ok(
    identifiers.every((identifier) => !identifier.startsWith("LicenseRef-") && !identifier.startsWith("DocumentRef-")),
    "custom LicenseRef expressions require an explicit license-url override",
  );
  return [...new Set(identifiers)];
}

/**
 * Typst packages sometimes use LICENSE as a short SPDX pointer instead of
 * copying the full license text. In that case, the SPDX identifiers can be
 * resolved to their canonical texts.
 */
export function isSpdxLicensePointer(text, expression) {
  const normalizedText = String(text).replace(/\\r\\n/g, "\\n").trim().replace(/\\s+/g, " ");
  const normalizedExpression = String(expression).trim().replace(/\\s+/g, " ");
  if (normalizedText === normalizedExpression) return true;

  return normalizedText.length <= 160 &&
    normalizedText.split(" ").length <= 12 &&
    /^[A-Za-z0-9.+() -]+$/.test(normalizedText);
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
