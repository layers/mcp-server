# Keyless onboarding mode

This document describes the behavior shipped by `@layers/mcp-server`. It is a
public runtime contract, not an implementation plan.

## Mode selection

The server reads an API key from `--api-key` first, then `LAYERS_API_KEY`.

- When a key is present, the server registers the Layers workspace API tools.
- When no key is present, the server registers the keyless onboarding tools and
  the workspace tools. Workspace tools become usable after the onboarding
  session claims a workspace.
- `--read-only` limits workspace tools. It does not remove the onboarding tools.

Both flag-based and environment-based API-key configurations are covered by the
registration tests.

## Public onboarding tools

Keyless mode exposes five tools:

- `onboard_start` starts a trial from a supported public product URL.
- `get_onboarding_status` returns the public build, preview, claim, intake, and
  post-claim status projection.
- `onboard_claim_begin` starts the optional in-chat email-code claim flow.
- `onboard_claim_verify` completes that optional claim without returning
  credentials to the host agent.
- `ask_elle` carries the guided onboarding conversation and post-claim next
  steps.

The default claim experience uses the portable browser claim URL. The email-code
tools remain available for a person who explicitly asks to claim inside the
current chat.

The CLI form remains available for hosts that launch a one-shot process:

```sh
npx -y @layers/mcp-server onboard <url>
```

It prints the public preview and claim links after the preview is ready.

## Security boundaries

- Short-lived onboarding credentials and the claimed workspace key stay in
  process memory. They are not returned in MCP tool results or logs.
- Public tool results are projected through explicit schemas. Unknown backend
  fields are discarded instead of copied into the host-agent transcript.
- The remote guide response is reduced to its bounded public reply. Structured,
  malformed, oversized, or envelope-like fallback text fails closed.
- The server refreshes its short-lived onboarding session internally and retries
  an interrupted remote call at most once.
- Release publishing uses GitHub OIDC and npm provenance; no long-lived npm token
  is stored in this repository.

## Configuration

| Setting | Purpose |
|---|---|
| `--api-key` / `LAYERS_API_KEY` | Select API-key mode. |
| `--base-url` / `LAYERS_BASE_URL` | Override the Layers API host. |
| `LAYERS_ELLE_MCP_URL` | Override the hosted onboarding conversation service. |
| `--organization` / `LAYERS_ORGANIZATION` | Act for an authorized child organization in API-key mode. |
| `--read-only` / `LAYERS_READ_ONLY=1` | Limit the workspace API tools to reads. |

## Verification

The hermetic Node test suite covers mode selection, tool registration, public
response projection, credential redaction, claim behavior, session refresh,
remote reconnect, reply-envelope filtering, and the legacy API-key surface.

See [README.md](README.md) for installation and [RELEASE.md](RELEASE.md) for the
tag-to-npm release process.
