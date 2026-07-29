# Tests

Two layers, kept deliberately separate.

## `npm test` — hermetic contract tests (no key, no network)

Run with Node's built-in test runner (no test-framework dependency):

```sh
npm test
```

`pretest` builds first, then `node --test test/*.test.mjs` runs six suites.
The protocol-facing suites spawn the built server and drive it over stdio; the
contract/onboarding suites also point it at a throwaway `127.0.0.1` mock. The
bridge suite injects mock MCP clients and transports, so **no API key and no
outbound network are needed**. This is what CI runs.

- **[`registration.test.mjs`](registration.test.mjs)** — the server registers
  all 52 tools; `--read-only` exposes exactly the 25 read tools and hides all 27
  write tools; every tool is `snake_case` with a description and input schema.
- **[`protocol.test.mjs`](protocol.test.mjs)** — keyless startup stays live in
  onboarding mode, and the server writes **only** JSON-RPC frames to stdout
  (diagnostics go to stderr).
- **[`contract.test.mjs`](contract.test.mjs)** — against the mock: Bearer auth on
  every request; `X-Layers-Organization` only when `--organization` is set;
  `Idempotency-Key` on POST/PATCH but not GET/DELETE; array filters repeat while
  scalars serialize once; each tool routes to the correct method + path; a
  required-but-empty caption is transmitted; an API error envelope renders as a
  tool error without echoing the key.
- **[`annotations.test.mjs`](annotations.test.mjs)** — every tool carries the
  right MCP annotation hints: `readOnlyHint` on the 25 reads, `destructiveHint`
  on delete/archive/cancel, `idempotentHint` on PATCH/set-style writes.
- **[`onboarding.test.mjs`](onboarding.test.mjs)** — keyless native onboarding,
  session refresh/redaction, claim contracts, the cold-start CLI, all six
  keyless tool registrations, and graceful pre-session bridge failures.
- **[`bridge.test.mjs`](bridge.test.mjs)** — the Elle tool-name mappings,
  Streamable HTTP URL/auth construction, 401 refresh with a new token,
  bounded reconnects, and remote result/error redaction.

The tests assert literal counts (52 / 25 / 27) on purpose — adding or removing a
tool fails the suite until the count is updated deliberately.

## `scripts/smoke.mjs` — opt-in live smoke (sandbox key)

A single end-to-end run against the real API using **sandbox** fixtures. It is
**not** part of `npm test`, refuses any non-`lp_test_` key, only ever uses draft
delivery, and archives the throwaway project it creates.

```sh
LAYERS_TEST_KEY=lp_test_xxx node scripts/smoke.mjs
```

> Sandbox keys (`lp_test_…`) return fixture-backed results for content, OAuth,
> and publish — nothing posts to a real social account.
