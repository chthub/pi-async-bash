#!/usr/bin/env bash
# Run the full test suite against one Pi release, without touching this checkout.
# Usage: npm run test:pi -- 1.6.0      (or: scripts/test-pi-version.sh latest)
set -euo pipefail
version="${1:?usage: test-pi-version.sh <pi version|latest>}"
here="$(cd "$(dirname "$0")/.." && pwd)"
if [ "$version" = latest ]; then
  version="$(npm view @earendil-works/pi-coding-agent version)"
fi
work="$(mktemp -d "${TMPDIR:-/tmp}/pi-async-bash-pi-$version-XXXXXX")"
trap 'rm -rf "$work"' EXIT
tar --exclude=node_modules --exclude=.git -C "$here" -cf - . | tar -xf - -C "$work"
cd "$work"
node -e '
  const fs = require("fs");
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  for (const name of Object.keys(pkg.devDependencies)) {
    if (name.startsWith("@earendil-works/")) pkg.devDependencies[name] = process.argv[1];
  }
  fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
' "$version"
rm -f package-lock.json
echo "== Pi $version: installing into $work"
npm install --ignore-scripts --no-audit --no-fund --loglevel=error
npm test
npm run test:integration
echo "== Pi $version: all tests passed"
