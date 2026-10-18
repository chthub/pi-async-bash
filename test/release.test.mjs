import assert from "node:assert/strict";
import test from "node:test";
import { checkRelease } from "../scripts/check-release.mjs";

const manifest = () => ({
  name: "@fixture/pi-async-bash", version: "0.1.0",
  repository: { url: "git+https://github.com/chthub/pi-async-bash.git" },
  publishConfig: { registry: "https://registry.npmjs.org/", access: "public" },
});
const env = { tag: "v0.1.0", expectedName: "@fixture/pi-async-bash" };

test("release guard allows a matching stable tag and explicitly selected package", () => {
  assert.doesNotThrow(() => checkRelease(manifest(), env));
});

test("release guard blocks the occupied npm name even if explicitly selected", () => {
  assert.throws(() => checkRelease({ ...manifest(), name: "pi-async-bash" }, { ...env, expectedName: "pi-async-bash" }), /another publisher/);
});

test("release guard fails closed on missing or mismatched configuration", () => {
  for (const expectedName of [undefined, "", "@other/package"]) {
    assert.throws(() => checkRelease(manifest(), { ...env, expectedName }), /NPM_PACKAGE_NAME/);
  }
  for (const tag of [undefined, "main", "v0.2.0", "v0.1.0-beta.1", "v0.1.0; echo unsafe"]) {
    assert.throws(() => checkRelease(manifest(), { ...env, tag }), /stable releases/);
  }
  assert.throws(() => checkRelease({ ...manifest(), version: "0.1.0-beta.1" }, { ...env, tag: "v0.1.0-beta.1" }), /stable releases/);
  assert.throws(() => checkRelease({ ...manifest(), private: true }, env), /public package/);
  assert.throws(() => checkRelease({ ...manifest(), repository: { url: "https://example.invalid/fork" } }, env), /canonical/);
  assert.throws(() => checkRelease({ ...manifest(), publishConfig: {} }, env), /publishConfig/);
});
