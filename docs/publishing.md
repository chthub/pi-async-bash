# CI and npm publishing

## Current status

The GitHub repository is public and can be installed through Pi's Git source.
**`@chthub/pi-async-bash` is published on npm; `0.1.0` was the bootstrap release.**
The unscoped name `pi-async-bash` is already owned by an unrelated publisher.
Do not install that npm package expecting this repository's code.

Automated publishing uses npm trusted publishing (OIDC), gated by the repository
variable `NPM_PUBLISH_ENABLED`. Keep this disabled until npm-side trust is configured.
No npm credentials are stored in this repository or required for tests.

## CI

`.github/workflows/ci.yml` runs on pushes to `main`, pull requests, and manual
invocation. GitHub-hosted Ubuntu runners test Node.js 22.19.0 (the minimum supported
version) and Node.js 24. Each runs type checking, unit/native/TUI tests, real Pi
integration tests using an in-process keyless model, and `npm pack --dry-run`.
Actions are pinned to commit hashes and CI has read-only repository permissions.
No pull-request code receives publishing credentials.

## One-time setup by an npm maintainer

1. The initial `0.1.0` publication was bootstrapped through an authenticated local
   publish with npm's interactive verification. The manifest and lockfile use
   `@chthub/pi-async-bash`; the release guard blocks the occupied unscoped name.
   Do not attempt to publish `0.1.0` again.
2. Sign in to npmjs.com with an account that manages this npm package. In its
   settings, configure a GitHub Actions **trusted publisher**:
   - Organization/user: `chthub`
   - Repository: `pi-async-bash`
   - Workflow filename: `publish.yml`
   - Environment: `npm`
   - Enable permission for direct `npm publish` (stage-only permission is not enough).
3. The GitHub deployment environment `npm` and variable `NPM_PACKAGE_NAME` are
   already configured. The environment allows `main` (manual workflow retry) and
   `v*` tags (releases). Add required reviewers if desired. Set repository Actions
   variable `NPM_PUBLISH_ENABLED` to `true` **only after** completing npm-side trust.
   Never paste an npm token into an issue, source file, or agent conversation.

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
