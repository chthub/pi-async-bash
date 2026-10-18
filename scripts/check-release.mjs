import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function checkRelease(pkg, { tag, expectedName }) {
  if (!expectedName || pkg.name !== expectedName) {
    throw new Error("Set NPM_PACKAGE_NAME to an npm name you own, and use that exact name in package.json.");
  }
  if (pkg.name === "pi-async-bash") {
    throw new Error("The unscoped npm name pi-async-bash belongs to another publisher. Choose an owned name before publishing.");
  }
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(pkg.name)) {
    throw new Error("Invalid npm package name.");
  }
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(pkg.version) || tag !== `v${pkg.version}`) {
    throw new Error("This workflow publishes stable releases only: tag must equal v<package.json version>.");
  }
  if (pkg.private || pkg.repository?.url !== "git+https://github.com/chthub/pi-async-bash.git") {
    throw new Error("Publication requires a public package with the canonical repository URL.");
  }
  if (pkg.publishConfig?.registry !== "https://registry.npmjs.org/" || pkg.publishConfig?.access !== "public") {
    throw new Error("publishConfig must explicitly select the public npm registry and public access.");
  }
}

function requirePublishedStableRelease(release, tag) {
  if (!release || release.tag_name !== tag || release.draft !== false || release.prerelease !== false ||
    typeof release.published_at !== "string" || release.published_at.length === 0) {
    throw new Error("npm latest requires an existing published, non-draft, non-prerelease GitHub release for the exact tag.");
  }
}

/** Check both the triggering event and freshly queried GitHub release metadata. */
export function checkReleaseEvent({ eventName, event, release, tag }) {
  if (typeof tag !== "string" || !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)) {
    throw new Error("GitHub release validation requires a stable v<version> tag.");
  }
  if (eventName === "release") {
    if (event?.action !== "published") throw new Error("Only published GitHub release events may publish npm latest.");
    requirePublishedStableRelease(event.release, tag);
  } else if (eventName === "workflow_dispatch") {
    if (event?.inputs?.tag !== tag) throw new Error("Manual retry input must match the requested release tag.");
  } else {
    throw new Error("Only release or workflow_dispatch events may publish npm latest.");
  }
  // Manual retries are not an override: they need the same stable release API check.
  requirePublishedStableRelease(release, tag);
}

function readRequiredJson(variable) {
  const path = process.env[variable];
  if (!path) throw new Error(`${variable} is required for GitHub release validation.`);
  return JSON.parse(readFileSync(path, "utf8"));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const tag = process.env.RELEASE_TAG;
  checkRelease(pkg, { tag, expectedName: process.env.EXPECTED_NPM_PACKAGE });
  checkReleaseEvent({
    tag, eventName: process.env.GITHUB_EVENT_NAME,
    event: readRequiredJson("GITHUB_EVENT_PATH"),
    release: readRequiredJson("RELEASE_METADATA_PATH"),
  });
  console.log(`Validated ${pkg.name}@${pkg.version} for ${tag}`);
}
