import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkRelease, checkReleaseEvent } from "../scripts/check-release.mjs";

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

const publishedRelease = () => ({
  tag_name: env.tag, draft: false, prerelease: false, published_at: "2026-01-01T00:00:00Z",
});
const releaseEvent = (release = publishedRelease()) => ({ action: "published", release });
const dispatchEvent = () => ({ inputs: { tag: env.tag } });

for (const eventName of ["release", "workflow_dispatch"]) {
  test(`${eventName} permits latest only with a published stable GitHub release`, () => {
    const event = eventName === "release" ? releaseEvent() : dispatchEvent();
    const options = { eventName, event, release: publishedRelease(), tag: env.tag };
    assert.doesNotThrow(() => checkReleaseEvent(options));
    for (const release of [
      undefined, null, {},
      { ...publishedRelease(), prerelease: true },
      { ...publishedRelease(), prerelease: undefined },
      { ...publishedRelease(), draft: true },
      { ...publishedRelease(), published_at: null },
      { ...publishedRelease(), published_at: "" },
      { ...publishedRelease(), tag_name: "v0.2.0" },
    ]) {
      assert.throws(() => checkReleaseEvent({ ...options, release }), /published, non-draft, non-prerelease/);
    }
  });
}

test("stable semver marked prerelease in the published event cannot publish latest", () => {
  // Even if the live release has since been promoted, the old prerelease event is rejected.
  assert.throws(() => checkReleaseEvent({
    eventName: "release", event: releaseEvent({ ...publishedRelease(), prerelease: true }),
    release: publishedRelease(), tag: env.tag,
  }), /non-prerelease/);
});

test("release event and manual retry identity are fail-closed", () => {
  const base = { tag: env.tag, release: publishedRelease() };
  assert.throws(() => checkReleaseEvent({ ...base, eventName: "push", event: {} }), /Only release or workflow_dispatch/);
  assert.throws(() => checkReleaseEvent({ ...base, eventName: "release", event: { ...releaseEvent(), action: "edited" } }), /Only published/);
  assert.throws(() => checkReleaseEvent({ ...base, eventName: "release", event: {} }), /Only published/);
  for (const tag of [undefined, "main", "v0.1.0-beta.1", "v0.1.0; echo unsafe"]) {
    assert.throws(() => checkReleaseEvent({ ...base, tag, eventName: "workflow_dispatch", event: dispatchEvent() }), /stable/);
  }
  for (const event of [undefined, {}, { inputs: {} }, { inputs: { tag: "v0.2.0" } }]) {
    assert.throws(() => checkReleaseEvent({ ...base, eventName: "workflow_dispatch", event }), /Manual retry input/);
  }
});

// Execute the actual workflow's pre-checkout shell gate, not a copied equivalent.
// This protects manual retries of older tags whose check-release.mjs lacks this guard.
const workflow = readFileSync(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8");
const gateMatch = workflow.match(/      - name: Require a published stable GitHub release\n[\s\S]*?        run: \|\n((?:          [^\n]*\n)+)/);
assert.ok(gateMatch, "workflow must retain its independent GitHub release gate");
const gate = gateMatch[1].split("\n").map((line) => line.slice(10)).join("\n");

function runWorkflowGate(t, { eventName, event, release = publishedRelease(), apiStatus = 0 }) {
  const dir = mkdtempSync(join(tmpdir(), "pi-async-bash-release-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const eventPath = join(dir, "event.json");
  const metadataPath = join(dir, "metadata.json");
  const argsPath = join(dir, "gh-args.txt");
  writeFileSync(eventPath, JSON.stringify(event));
  writeFileSync(join(dir, "gh"), '#!/bin/sh\nprintf "%s\\n" "$@" > "$MOCK_ARGS_PATH"\nif [ "$MOCK_API_STATUS" != 0 ]; then exit "$MOCK_API_STATUS"; fi\nprintf "%s" "$MOCK_RELEASE"\n', { mode: 0o700 });
  const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", gate], {
    cwd: dir, encoding: "utf8", timeout: 5000,
    env: {
      PATH: `${dir}:/usr/bin:/bin`, HOME: dir,
      GH_TOKEN: "fixture-only-not-a-credential", GH_REPO: "chthub/pi-async-bash",
      RELEASE_TAG: env.tag, RELEASE_METADATA_PATH: metadataPath,
      GITHUB_EVENT_NAME: eventName, GITHUB_EVENT_PATH: eventPath,
      MOCK_RELEASE: JSON.stringify(release), MOCK_API_STATUS: String(apiStatus), MOCK_ARGS_PATH: argsPath,
    },
  });
  assert.ifError(result.error);
  assert.equal(result.stdout, "", "release metadata must not be dumped into workflow logs");
  assert.doesNotMatch(result.stderr, /fixture-only-not-a-credential/);
  return { ...result, metadataPath, argsPath };
}

test("workflow gates both entry paths before checkout with read-only GitHub auth", () => {
  assert.ok(workflow.indexOf(gateMatch[0]) < workflow.indexOf("- uses: actions/checkout@"));
  assert.match(workflow, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(workflow, /contents: read/);
  assert.doesNotMatch(workflow, /contents: write|secrets\./);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /git merge-base --is-ancestor HEAD FETCH_HEAD/);
  assert.match(workflow, /refs\/tags\/\$RELEASE_TAG\^\{commit\}/);
});

for (const eventName of ["release", "workflow_dispatch"]) {
  test(`actual workflow gate: ${eventName} checks live metadata, rejecting prerelease/draft/missing releases`, (t) => {
    const event = eventName === "release" ? releaseEvent() : dispatchEvent();
    const success = runWorkflowGate(t, { eventName, event });
    assert.equal(success.status, 0, success.stderr);
    assert.deepEqual(JSON.parse(readFileSync(success.metadataPath, "utf8")), publishedRelease());
    assert.equal(readFileSync(success.argsPath, "utf8"), "api\n--method\nGET\nrepos/chthub/pi-async-bash/releases/tags/v0.1.0\n");
    for (const release of [
      { ...publishedRelease(), prerelease: true },
      { ...publishedRelease(), draft: true },
      { ...publishedRelease(), published_at: null },
      { ...publishedRelease(), tag_name: "v0.2.0" },
      {},
    ]) {
      assert.notEqual(runWorkflowGate(t, { eventName, event, release }).status, 0);
    }
    assert.notEqual(runWorkflowGate(t, { eventName, event, apiStatus: 1 }).status, 0, "API/404 failure must block publication");
  });
}

test("actual workflow gate rejects a prerelease event and mismatched manual retry", (t) => {
  assert.notEqual(runWorkflowGate(t, {
    eventName: "release", event: releaseEvent({ ...publishedRelease(), prerelease: true }),
  }).status, 0);
  assert.notEqual(runWorkflowGate(t, {
    eventName: "workflow_dispatch", event: { inputs: { tag: "v0.2.0" } },
  }).status, 0);
});
