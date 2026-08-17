# Layers MCP Server

An MCP (Model Context Protocol) server that exposes the
[Layers API](https://api.layers.com) as tools, so AI agents can manage
projects, generate short-form social content, and publish it — straight from
any MCP client.

> Tool coverage tracks the Layers API reference.

## One-paste onboarding

Run this from the product repository in the same Codex or Claude shell session:

```sh
npx --yes @layers/mcp-server@latest onboard
```

The command checks server compatibility before reading the workspace, runs the
checksum-verified native collector locally, shows the exact bounded source-data
proposal, and waits for explicit approval before sending evidence. While the
preview builds it asks the same setup questions the Layers web onboarding asks,
one at a time, each carrying its exact title, its offered options, and the exact
command that answers it. It then surfaces the preview and attempt-bound browser
claim URL and returns the safe post-claim workspace projection to the same
process when the browser claim finishes within its bounded window. Reservation,
transport, PKCE verifier, post-claim capability, full evidence-envelope, and
transient excerpt values never enter terminal output; the bounded consent
projection does.

### Setup questions and the claim link

Once evidence is approved and on its way, the command reads the outstanding
setup questions and emits `input_required: answer_intake` one question at a
time. Each turn carries the canonical `question` (title, optional subtitle,
whether it takes one option or several, whether it takes free text, and the
offered `options` as `value`/`label` pairs) and the `commands` that answer it:

```
answer <field> <value>                 pick one offered option
answer <field> <value>,<value>         pick several (multi-select questions)
answer <field>                         pick none (multi-select questions)
answer goal other <your own words>     the one arm that takes free text
```

Send exactly one advertised command per turn; the next question arrives once the
answer is recorded. A line that names an option the question does not offer
re-asks the same question rather than guessing.

**The claim link waits for both the preview and the questions.** Whichever
finishes second releases it, so the browser claim is never offered while setup
questions are still outstanding. Progress is reported on `intake` events, whose
`complete` flag is the explicit signal that the walk is done — the same way
`previewReady` reports the preview. `state` is one of `asking`, `complete`,
`not_required` (there were no questions), or `skipped`. **`skipped` means the
gate failed open**: the question service was unreachable, refused repeatedly, or
the questions were left unanswered past their bounded window. A broken question
service costs a person their questions, never their workspace. The terminal
`complete` event carries the same summary on its `intake` field.

### Claude Code process control

The command stays alive across scope review, human approval, preview creation,
and claim. Each local source-inspection generation has a fixed 15-minute
privacy lifetime. If that lifetime ends during scope review or consent, the
command clears the expired local artifact and emits
`input_required: resume_inspection`; `resume` performs a fresh inspection with
fresh opaque IDs and requires a fresh proposal and approval. An expired
proposal can never authorize an upload. In Claude Code, run the command as a
native background Bash task so later tool calls can read its JSONL and answer
its stdin. Do not put `&`, `nohup`, or a foreground `wait` around the command;
those do not give Claude a controllable task handle.

1. In a short foreground Bash call, create the private input pipe and retain the
   absolute directory printed by the last line:

   ```sh
   layers_session_dir="$(mktemp -d "${TMPDIR:-/tmp}/layers-onboard.XXXXXX")"
   chmod 700 "$layers_session_dir"
   mkfifo "$layers_session_dir/input"
   chmod 600 "$layers_session_dir/input"
   printf '%s\n' "$layers_session_dir"
   ```

2. In a second Bash tool call, substitute that absolute path and run exactly
   this shell with the Bash tool's `run_in_background` parameter set to `true`:

   ```sh
   exec 3<>"/absolute/layers-onboard.ABC123/input"
   npx --yes @layers/mcp-server@latest onboard <&3
   ```

   The shell command itself stays in the foreground of the background task.
   Claude Code returns a task ID instead of blocking the conversation.

3. Use `TaskOutput` on that task ID with `block: true` and a timeout no longer
   than 15 seconds to read new JSONL. Send each advertised response from a
   separate short Bash call, for example:

   ```sh
   printf '%s\n' 'prepare' > '/absolute/layers-onboard.ABC123/input'
   ```

   Read `TaskOutput` again after every response. Print the complete
   `consent_proposal.canonicalProjection` verbatim, along with its display ID,
   display time, projection hash, and exact advertised approval command. End
   the turn and wait for the human's explicit approval before writing that
   command. If `resume_inspection` appears, send only its advertised `resume`
   or `cancel` command; a resumed inspection requires a new proposal and new
   approval. Keep the task alive until a terminal `complete` or `error` event.

4. At `input_required: answer_intake`, relay one question per turn while the
   launcher keeps building in the background: show its exact `title`, its
   `subtitle` when present, and its offered `options`, take an offered option or
   the human's own words, and send the exact advertised answer command before
   asking the next. Never show a setup question while a consent proposal is
   displayed or awaiting approval. Withhold the claim link until the launcher
   reports the questions complete and the preview ready.

For ordinary public callers, a server that has not opened source admission stops
the command before local inspection. An operator-only environment token can
authorize a closed internal probe. The older public-URL compatibility form
remains available:

```sh
npx --yes @layers/mcp-server@latest onboard https://example.com
```

## Install as an MCP server

To expose the persistent Layers MCP tools without an existing API key:

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

### Keyless onboarding tools

`onboard_start` · `get_onboarding_status` · `onboard_claim_begin` ·
`onboard_claim_verify` · `ask_elle`

`onboard_start` without a URL remains a reservation-only MCP tool. Its result is
honestly limited to `awaiting_evidence`, and its opaque capability stays inside
the server process. The full local inspection, consent, evidence, preview,
browser claim, and same-process return path belongs to the one-shot
`layers-mcp-server onboard` command above. Passing an explicit public product
URL to the MCP tool keeps the existing preview and claim flow working.

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

# exercise the same-session command from a product workspace:
(cd /path/to/product && node /path/to/mcp-server/dist/index.js onboard)

# or explore interactively with the MCP inspector:
npx @modelcontextprotocol/inspector node dist/index.js --api-key lp_test_dummy
```

In MCP-server mode, stdout is the JSON-RPC channel and all logging goes to
stderr. The one-shot onboarding CLI emits its documented JSONL events on stdout;
the legacy URL form emits its compatibility output there.

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
