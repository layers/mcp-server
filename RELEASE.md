# Releasing `@layers/mcp-server`

Publishing is automated: **push a version tag and CI publishes to npm.** No npm
token is stored anywhere — see the security model below.

## Cutting a release

1. Bump the version on a feature branch without creating a tag:
   ```bash
   npm version patch --no-git-tag-version   # or: minor / major
   git add package.json package-lock.json
   git commit -m "chore(release): bump mcp server"
   ```
   Open a pull request and merge it through the required CI and BugBot checks.
   Direct pushes to `main` are intentionally blocked.
2. From a clean checkout of the merged `main`, create and push the exact version
   tag:
   ```bash
   git pull --ff-only origin main
   MCP_VERSION="$(node -p "require('./package.json').version")"
   git tag "v${MCP_VERSION}"
   git push origin "refs/tags/v${MCP_VERSION}"
   ```
3. The **Release** workflow runs, waits for approval on the `npm-publish`
   environment, then publishes with provenance. Consumers on
   `npx -y @layers/mcp-server@latest` pick it up on their next spawn.

The workflow refuses to publish if the tag and `package.json` version disagree.

## Security model — why there is no npm token

Publishing uses **npm Trusted Publishing (OIDC)**. At publish time GitHub Actions
mints a short-lived credential scoped to *this repo + this workflow*, and npm
verifies it directly. Consequences:

- **No long-lived automation token** exists to leak from GitHub secrets — the
  classic supply-chain failure mode is removed.
- **2FA stays on.** The OIDC exchange is a strong credential that satisfies
  npm's "require 2FA to publish" setting, so human publishes still require 2FA
  while CI publishes without a password.
- **Provenance.** Every tarball ships a signed attestation linking it to the
  exact commit and workflow run (`npm publish --provenance`).
- **Pinned build chain.** Release Actions use reviewed commit SHAs and the npm
  CLI is pinned to an exact OIDC-capable version.
- **Human gate.** The `npm-publish` GitHub Environment requires a reviewer to
  approve each publish — so even a malicious tag push cannot ship without a
  person clicking approve.

## One-time setup (already-published package)

1. **npm → package Settings → Trusted Publishers → Add GitHub Actions:**
   - Repository: `layers/mcp-server`
   - Workflow filename: `release.yml`
   - Environment: `npm-publish`
2. **GitHub → repo Settings → Environments → New environment `npm-publish`:**
   add the release approvers under *Required reviewers*.

That's it — no `NPM_TOKEN` secret.

> **Do not fall back to a long-lived publish token.** Per the 2026-07-08 npm
> changelog, tokens that bypass 2FA lose account/package-management rights in
> early Aug 2026 and **direct publish rights in Jan 2027**. OIDC trusted
> publishing (used here) plus the human-approval environment are npm's own
> recommended replacements — this workflow is already on the right side of that
> deprecation.
