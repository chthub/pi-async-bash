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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  checkRelease(pkg, { tag: process.env.RELEASE_TAG, expectedName: process.env.EXPECTED_NPM_PACKAGE });
  console.log(`Validated ${pkg.name}@${pkg.version} for ${process.env.RELEASE_TAG}`);
}
