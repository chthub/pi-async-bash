# CI and npm publishing

## Current status

The GitHub repository is public and can be installed through Pi's Git source.
**The selected npm name is `@chthub/pi-async-bash`; its first publication is pending.**
The unscoped name `pi-async-bash` is already owned by an unrelated publisher.
Do not install that npm package expecting this repository's code.

Publishing is deliberately disabled until npm-side permissions and a trusted publisher
are configured. No npm credentials are stored in this repository or required for tests.

## CI

`.github/workflows/ci.yml` runs on pushes to `main`, pull requests, and manual
invocation. GitHub-hosted Ubuntu runners test Node.js 22.19.0 (the minimum supported
version) and Node.js 24. Each runs type checking, unit/native/TUI tests, real Pi
integration tests using an in-process keyless model, and `npm pack --dry-run`.
Actions are pinned to commit hashes and CI has read-only repository permissions.
No pull-request code receives publishing credentials.

## One-time setup by an npm maintainer

1. Log in to npm with an account that can publish under the `@chthub` scope.
   This requires ownership or publish permission for that npm scope; a GitHub
   username alone does not grant npm ownership. Use `npm login` and verify with
   `npm whoami`; do not send credentials through chat.
2. The manifest and lockfile already use `@chthub/pi-async-bash`. The release guard
   explicitly blocks the occupied unscoped name, even if an Actions variable
   mistakenly selects it.
3. If this is a new npm package, bootstrap its first version from a trusted local
   checkout using your own npm login/2FA. Run `npm ci --ignore-scripts`, `npm test`,
   `npm run test:integration`, and `npm pack --dry-run` before `npm publish --access public`.
   Never paste an npm token into an issue, source file, or agent conversation.
4. In the npm package settings, configure a GitHub Actions **trusted publisher**:
   - Organization/user: `chthub`
   - Repository: `pi-async-bash`
   - Workflow filename: `publish.yml`
   - Environment: `npm`
   - Enable permission for direct `npm publish` (stage-only permission is not enough).
5. Create the GitHub deployment environment `npm`; add required-reviewer/tag
   restrictions where appropriate. Set repository Actions variable
   `NPM_PACKAGE_NAME` to `@chthub/pi-async-bash`. Set `NPM_PUBLISH_ENABLED` to `true`
   **only after** completing the package-name and trust configuration.

The current npm trusted-publishing documentation requires a newly configured trust
connection to complete its first successful publish within two days. Configure it
when ready to release; if it expires, recreate it in npm settings.

## Subsequent releases

1. Update `version` in `package.json` and `package-lock.json`, then commit to `main`.
2. Tag that commit `v<version>` and push the tag. Create/publish a GitHub Release
   for it. The `Publish npm` workflow runs only when enabled above.
3. The workflow verifies the package name, exact stable version/tag, repository
   URL, public registry/access, and that the tagged commit is an ancestor of
   `origin/main`. It reruns all tests, inspects the package, and publishes with
   npm OIDC and provenance. No `NPM_TOKEN` secret is needed.

Manual retry is available through `workflow_dispatch` with an existing tag.
A version already published to npm cannot be overwritten. Do not reuse the
bootstrap version for the first Actions publish: bump the version first.
This workflow supports stable releases only; prerelease versions are rejected
rather than accidentally changing the `latest` dist-tag.

## References

- [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/)
- [npm publish](https://docs.npmjs.com/cli/v11/commands/npm-publish/)
