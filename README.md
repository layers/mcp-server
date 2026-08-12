# Layers MCP Server

An MCP (Model Context Protocol) server that exposes the
[Layers API](https://api.layers.com) as tools, so AI agents can manage
projects, generate short-form social content, and publish it — straight from
any MCP client.

> Tool coverage tracks the Layers API reference.

## Install

For keyless onboarding, start the connector without an API key:

```sh
claude mcp add layers -- npx -y @layers/mcp-server@latest
```

The server enters keyless onboarding mode when neither `--api-key` nor
`LAYERS_API_KEY` is set. It can create and claim a workspace without an
existing Layers account or API key.

To connect an existing Layers workspace with an API key:

```sh
claude mcp add layers -- npx -y @layers/mcp-server@latest --api-key lp_YOUR_KEY
```

Or configure API-key mode in any MCP client's JSON config:

```json
{
  "mcpServers": {
    "layers": {
      "command": "npx",
      "args": ["-y", "@layers/mcp-server@latest", "--api-key", "lp_YOUR_KEY"]
    }
  }
}
```

> Pin a reviewed version (`@layers/mcp-server@<version>`) in production setups instead of
> `@latest` if you want releases to be deliberate on your side.

## Configuration

Flags take precedence; environment variables are the fallback.

| Flag | Env var | Default | Description |
|---|---|---|---|
| `--api-key` | `LAYERS_API_KEY` | unset | Layers API key (`lp_...`). When neither form is set, the server starts in keyless onboarding mode. |
| `--base-url` | `LAYERS_BASE_URL` | `https://api.layers.com` | API host. Paths are versioned under `/v1`. |
| `--read-only` | `LAYERS_READ_ONLY=1` | off | In API-key mode, register only the 25 read tools. In keyless mode, this limits the workspace API tools; the five onboarding tools remain available. |
| `--organization` | `LAYERS_ORGANIZATION` | unset | Act on behalf of a child org (`org_...`), sent as the `X-Layers-Organization` header on every request. Requires an `org:admin` parent key. |

**Security note:** flags end up in your client's config file and in the process
argv (visible via `ps`). Prefer the env var for the key where your client
supports it:

```json
{
  "mcpServers": {
    "layers": {
      "command": "npx",
      "args": ["-y", "@layers/mcp-server@latest"],
      "env": { "LAYERS_API_KEY": "lp_YOUR_KEY" }
    }
  }
}
```

Sandbox keys (`lp_test_...`) skip real platform calls during development —
content, OAuth, and publish return fixture-backed results.

## Tools

The tool surface depends on how the server starts:

- **API-key mode:** 52 workspace tools, one per API route.
- **Keyless onboarding mode:** five onboarding tools plus the same 52 workspace
  tools. The workspace tools are registered up front so the MCP client can see
  them, but they refuse calls until the onboarding session claims a workspace.

`--read-only` hides workspace write tools (marked W below). The five onboarding
tools remain available in keyless mode.

### Keyless onboarding

`onboard_start` · `get_onboarding_status` · `onboard_claim_begin` ·
`onboard_claim_verify` · `ask_elle`

### Workspace API tools (52)

### Core
`whoami` · `list_projects` · `get_project` · `get_credits` ·
`list_credit_events` · `create_project` (W) · `update_project` (W) ·
`archive_project` (W)

### Creative
`list_influencers` · `get_influencer` · `get_keywords` · `list_content` ·
`get_content` · `get_content_progress` · `get_content_asset` · `get_hooks` ·
`get_source_recommendations` · `get_content_review_policy` ·
`create_influencer` (W) · `clone_influencer` (W) · `update_influencer` (W) ·
`delete_influencer` (W) · `refresh_keywords` (W) · `generate_slideshow` (W) ·
`generate_ugc_remix` (W) · `generate_video_remix` (W) ·
`generate_slideshow_remix` (W) · `create_content_upload` (W) ·
`upload_content_from_url` (W) · `finalize_content_upload` (W) ·
`update_content_caption` (W) · `approve_content` (W) · `reject_content` (W) ·
`update_content_review_policy` (W)

### Distribution
`list_social_accounts` · `get_scheduled_post` · `list_scheduled_posts` ·
`list_tiktok_music` · `get_engagement_config` · `publish_content` (W) ·
`schedule_content` (W) · `reschedule_post` (W) · `cancel_scheduled_post` (W) ·
`notify_device` (W) · `update_engagement_config` (W)

### Measurement
`get_metrics` · `get_top_performers` · `list_ads_content` ·
`list_recommendations` · `update_ads_content` (W) · `update_recommendation` (W)

### Framework
`list_audit_log`

### Conventions

- **Async jobs.** Generation, influencer creation/cloning, and keyword refresh
  return a `202` job envelope (`jobId`, `containerIds`/`influencerId`). Poll the
  matching read tool (`get_content_progress`, `get_influencer`, `get_keywords`)
  until the resource is terminal.
- **Uploading your own media.** Two transports, both producing an uploaded
  content container you can then schedule/publish. For already-hosted files,
  `upload_content_from_url` is one synchronous call. For large/private files,
  `create_content_upload` returns presigned `PUT` URLs — your client uploads the
  bytes directly to storage (outside this server, within ~15 min), then calls
  `finalize_content_upload` per container. Fix a caption afterward with
  `update_content_caption` (uploaded content only).
- **Pagination.** List tools accept `cursor` + `limit` and return
  `{ items, nextCursor }`; pass `nextCursor` back verbatim.
- **Idempotency.** The server stamps a fresh UUID `Idempotency-Key` on every
  mutating POST/PATCH automatically.
- **Errors** expose only the public status, stable error code, safe message, and
  validated `requestId`. Backend details and non-contract response bodies are
  not copied into the agent transcript. Include the `requestId` in support
  tickets.
- **Timestamps** are ISO 8601 UTC with a `Z` suffix everywhere (offset forms
  are rejected by the API). `scheduledFor` is a literal UTC instant — convert
  from local time before calling.

## Development

Requires Node 20+.

```sh
npm install
npm run build                 # tsc -> dist/

# wire the local build into Claude Code:
claude mcp add layers -- node $(pwd)/dist/index.js --api-key lp_YOUR_KEY

# or explore interactively with the MCP inspector:
npx @modelcontextprotocol/inspector node dist/index.js --api-key lp_test_dummy
```

stdout is the JSON-RPC channel — all logging goes to stderr.

## Testing

```sh
npm test            # hermetic suite — no API key, no network
npm run smoke       # opt-in live smoke; needs LAYERS_TEST_KEY=lp_test_...
```

`npm test` builds, then runs the contract suite with Node's built-in test runner
against a localhost mock — it verifies tool registration, `--read-only` gating,
annotation hints, stdout protocol discipline, and the request contract (auth,
idempotency, query encoding, per-tool routing, error rendering). No credentials or outbound network
required; this is what CI runs. See [`test/README.md`](test/README.md) for the
full breakdown and the sandbox smoke script.

## License

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
Copyright 2026 Layers AI, Inc.

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
