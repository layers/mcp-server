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

## Same-session command

The target one-paste path is a one-shot command run inside the coding agent's
current product workspace:

```sh
npx --yes @layers/mcp-server@latest onboard
```

It does not depend on a newly installed MCP server becoming visible mid-session.
The command checks the public capability manifest before reading the current
directory, reserves a protocol-v1 trial, verifies and stages the matching native
collector, and emits machine-readable inspection and consent events. It sends
evidence only after the person approves the exact displayed projection.

After the preview is ready, the command creates an attempt-bound browser claim
with a process-private transport capability and PKCE verifier. It polls that
exact exchange and, when the claim completes within its bounded window, performs
the capability-only post-claim read before emitting terminal success. That
claimed result contains the preview URL and bounded
organization/project/generation projection, never an API key or browser session.
An unfinished browser claim terminates honestly as `awaiting_claim` without a
post-claim projection.

The compatibility command `layers-mcp-server onboard <public-url>` retains the
older URL-first behavior. It does not invoke the local collector.

## Public onboarding tools

Keyless mode exposes five tools:

- `onboard_start` reserves a trial without a URL when the host is already in a
  code workspace. It also accepts an explicit public product URL for old-client
  compatibility.
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

## MCP URL-free reservation boundary

Calling `onboard_start` without a URL sends the protocol-v1 reservation request.
The public result is `awaiting_evidence`. The opaque reservation capability stays
in process memory for the later evidence-submission step; it is not returned to
the host agent or written to logs.

This MCP tool call is a reservation only. It does not invoke the one-shot local
collector, read or send source, start a preview, or create a workspace. The
full consented flow is the same-session command above. An explicitly supplied
URL continues through the existing preview and claim flow.

The CLI form remains available for hosts that launch a one-shot process:

```sh
npx --yes @layers/mcp-server onboard [<public-url>]
```

Without a URL it emits JSONL operations for local selection, scope review,
approval, progress, browser claim, and the final safe post-claim projection.

## Security boundaries

- Short-lived onboarding credentials, reservation capability, claim transport
  capability, PKCE verifier, and post-claim capability stay in process memory.
  The approved source envelope is transmitted only to the evidence endpoint
  after consent. None are returned in MCP tool results, terminal events, or
  logs.
- Installed collector bytes are verified against the pinned npm package,
  integrity record, contract manifest, policy, size, and SHA-256 before a private
  staged copy is executed. Prepared source crosses a separate private channel;
  stdout carries only sanitized JSONL inspection, consent, progress, claim, and
  terminal projections.
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
| `LAYERS_ONBOARD_INTERNAL_PROBE_TOKEN` | Operator-only, env-only closed-admission probe token for the one-shot command. It is read once and deleted before collection. |
| `--organization` / `LAYERS_ORGANIZATION` | Act for an authorized child organization in API-key mode. |
| `--read-only` / `LAYERS_READ_ONLY=1` | Limit the workspace API tools to reads. |

## Verification

The hermetic Node test suite covers mode selection, tool registration, public
response projection, credential redaction, claim behavior, session refresh,
remote reconnect, reply-envelope filtering, and the legacy API-key surface.

See [README.md](README.md) for installation and [RELEASE.md](RELEASE.md) for the
tag-to-npm release process.
