# `@layers/mcp-server` — Keyless Onboarding Mode (spec)

**Status:** reviewed spec — the harness slice of the cross-repo "Onboarding via Agent" plan (authored + skeptic-reviewed to consensus in the `layers/layers` monorepo, `docs/onboarding-via-agent/IMPLEMENTATION_PLAN.md`). This doc is the self-contained brief for **this** repo so its own CI/reviewers have full context without the monorepo.

**Goal:** let anyone tell their MCP client "Implement Layers.ai" and, with **no API key and no account**, bootstrap a Layers workspace, talk to Elle, and claim it by email — all JWT-only, no `lp_` key on this path. The existing 52-tool key-required mode is **unchanged**.

---

## 1. Mode selection (must not regress existing installs)

The server today resolves the key from **either** `--api-key` **or** the `LAYERS_API_KEY` env var (`src/index.ts:18` — `flagValue("api-key") ?? process.env.LAYERS_API_KEY`).

- **Legacy mode (unchanged, byte-identical):** entered whenever a key resolves from **either** source. All 52 tools register exactly as today.
- **Keyless onboarding mode:** entered **only** when **neither** a `--api-key` flag nor `LAYERS_API_KEY` is present — or via the explicit `onboard` subcommand (§4).
- ⚠ Keying mode on `--api-key` absence alone would silently drop env-var installs into onboarding mode and strip their tools. Test **both** credential forms for byte-identical registration.

## 2. Tools in onboarding mode

**Native** (to be implemented here — REST → `apps/api` public onboarding routes; base URL `--base-url`/`LAYERS_BASE_URL`, default `https://api.layers.com`):

| Tool | Kind | REST | Returns |
|---|---|---|---|
| `onboard_start` | write | `POST /api/onboard/agent/start` (after solving the PoW challenge from `GET /api/onboard/agent/challenge`) | `{ trialHandle, previewUrl, claimUrl, expiresAt }` — plus the session is captured **into process memory**, never returned to the agent |
| `get_onboarding_status` | read | `GET /api/onboard/agent/trials/:trialHandle` | `{ status, progress[], previewUrl, claimUrl, claimed, plan:{state,teaser?,content?} }` (long-poll) |
| `onboard_claim_begin` | write | `POST /api/onboard/claim/begin` | `{ status: 'otp_sent' }` |
| `onboard_claim_verify` | write | `POST /api/onboard/claim/verify` | `{ status: 'claimed', organizationId, continuity }` (tokenless) |

**Bridged** (proxied from the remote Elle `onboarding` MCP server over Streamable HTTP, `Authorization: Bearer <access JWT>`, `?trial=<trialHandle>`; lazy-connect after `onboard_start` succeeds; on 401 → `POST /api/onboard/agent/refresh { sessionHandle }` → retry; reconnect on drop). **The harness owns the client-facing tool names**, so these are exposed as:

- `ask_elle` — backed by the remote onboarding guide agent (whatever its internal Mastra key; the alias decouples us from it).
- `get_marketing_plan` — teaser pre-claim, full content post-claim (server enforces the reveal gate).

## 3. Session handling (security-critical)

- `onboard_start` returns, to this process only, a short-lived **access token** + an opaque **`sessionHandle`**. **No refresh token ever reaches the client** — the refresh chain is owned server-side; renew via `POST /api/onboard/agent/refresh { sessionHandle }`.
- Tokens live in **process memory only** and **must never appear** in any tool result, log line, or error string. **Redaction tests over every serializer** (`ok()`/`err()` in `src/api.ts` and any logging) assert no `access_token` / `sessionHandle` / refresh-token substring can escape.
- The MCP claim path is tokenless — it never serializes the verify-minted session.

## 4. Cold-start CLI subcommand

`npx -y @layers/mcp-server onboard <url>` → runs `onboard_start`, prints progress lines + `previewUrl` + `claimUrl`, then exits with claim instructions. (The `amba init` one-package pattern.) `<url>` v1: website or Apple App Store URL.

## 5. `llms.txt` (served from layers.com, not this repo)

Prescriptive two-branch install so agents don't improvise: **Branch A** (client already has the Layers connector) → call `onboard_start`; **Branch B** (no connector) → the exact `npx -y @layers/mcp-server onboard <url>` line.

## 6. Publish hardening (launch-blocking)

`llms.txt` instructs arbitrary agents to `npx -y @layers/mcp-server` — a compromised publish is code-execution on every adopter. Before shipping onboarding mode:

- npm **2FA** on all maintainers; **provenance/attestations** on publish.
- Publish **only** from tag-gated CI — no laptop `npm publish`.
- README pin guidance (`@layers/mcp-server@<version>` in production).
- The 52→~57-tool diff gets monorepo-grade review (name reviewers on the PR).
- A **contract drift check** in CI against fixtures exported from the monorepo's `@layers/shared-types` for the `/api/onboard/agent/*` shapes this package hand-mirrors.

## 7. Test matrix (`node --test`)

Keyless-mode registration; **both** credential forms (`--api-key` and `LAYERS_API_KEY`) → byte-identical legacy registration; two-phase claim (browser + MCP token modes); `401 → refresh → retry`; bridge reconnect; `ask_elle` client-name mapping (independent of Elle's internal agent key); **session redaction** across every serializer; `--api-key` mode unchanged.

---

*Status: §1–§4 (mode selection, the four native tools, session memory + redaction, the `onboard`
CLI subcommand) are **implemented** (`src/onboarding/`, adversarially co-reviewed, 33 hermetic
tests). Still pending: §2's bridged `ask_elle`/`get_marketing_plan` (needs the remote Elle
onboarding MCP server), §5 `llms.txt`, and §6 publish hardening (launch-blocking). Full
cross-repo context and sequencing live in the monorepo plan.*
