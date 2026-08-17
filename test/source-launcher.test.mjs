import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  ONBOARDING_CAPABILITY_READINESS_CHECK_IDS,
  ONBOARD_AGENT_EVIDENCE_CONTENT_ENCODING,
  ONBOARD_AGENT_EVIDENCE_CONTENT_TYPE,
  ONBOARD_AGENT_PUBLIC_HEADER_NAMES,
  ONBOARD_AGENT_PUBLIC_ROUTE_PATHS,
  OnboardAgentChallengeResponseSchema,
  OnboardAgentClaimAttemptRequestSchema,
  OnboardAgentClaimAttemptResponseSchema,
  OnboardAgentClaimExchangeRequestSchema,
  OnboardAgentClaimExchangeResponseSchema,
  OnboardAgentClaimTransportHeadersSchema,
  OnboardAgentEvidenceStartRequestSchema,
  OnboardAgentEvidenceStartResponseSchema,
  OnboardAgentEvidenceUploadHeadersSchema,
  OnboardAgentEvidenceUploadResponseSchema,
  OnboardAgentPostclaimHeadersSchema,
  OnboardAgentPostclaimResponseSchema,
  OnboardAgentProgressHeadersSchema,
  OnboardAgentProgressResponseSchema,
  OnboardingClosedCapabilityManifestSchema,
  OnboardingEvidenceEnvelopeSchema,
} from "@layers/onboarding-contracts";

import {
  IntakeAnswersRequestSchema,
  IntakeAnswersResponseSchema,
  ONBOARD_AGENT_INTAKE_ANSWERS_ROUTE_PATH,
} from "../dist/onboarding/intake-contract.js";
import { waitForPreviewAndClaim } from "../dist/onboarding/launcher.js";
import { rememberReservation } from "../dist/onboarding/session.js";
import { SERVER } from "./helpers.mjs";

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REQUEST_TIMEOUT_MS = 45_000;
const STAGE_PREFIX = "layers-onboarding-collector-";

const TRIAL_HANDLE = "a".repeat(64);
const RESERVATION_CAPABILITY =
  "reservation-capability-source-launcher-sentinel";
const INTERNAL_PROBE_TOKEN = "internal-probe-source-launcher-sentinel";
const ATTEMPT_HANDLE = "h".repeat(43);
const POSTCLAIM_CAPABILITY = "p".repeat(43);
const LEGACY_CLAIM_TOKEN = "legacy-claim-token-must-not-reach-output";
const SOURCE_BODY_SENTINEL = "source-body-must-not-reach-output";
const SOURCE_SECRET_SENTINEL = "source-secret-must-not-reach-output";
const PREVIEW_URL = "https://app.layers.test/p/preview-token";
const LEGACY_CLAIM_URL =
  `https://app.layers.test/claim?token=${LEGACY_CLAIM_TOKEN}`;
const ATTEMPT_CLAIM_URL =
  `https://app.layers.test/claim#token=browser-claim-token&claimAttemptHandle=${ATTEMPT_HANDLE}`;
const ATTEMPT_EXPIRES_AT = "2100-08-14T00:15:00.000Z";
const CAPABILITY_EXPIRES_AT = "2100-08-14T00:30:00.000Z";
const UPDATED_AT = "2026-08-13T22:00:00.000Z";
const RESERVATION_EXPIRES_AT = new Date(
  Date.now() + 7 * 24 * 60 * 60 * 1000,
).toISOString();

const CAPABILITY_MANIFEST = OnboardingClosedCapabilityManifestSchema.parse({
  schemaVersion: 1,
  protocolVersion: null,
  evidenceSchemaVersion: null,
  collectionPolicyVersion: null,
  collectorVersion: null,
  collectorProtocolVersion: null,
  sourceInspectionSchemaVersion: null,
  codebaseDigestSchemaVersion: null,
  supportedSourceKinds: [],
  sameSessionBootstrapCommand: null,
  hostedMcpEndpoint: null,
  compatibility: null,
  schemaReadiness: {
    ready: false,
    checkedAt: null,
    databaseRevision: null,
    requiredChecks: [...ONBOARDING_CAPABILITY_READINESS_CHECK_IDS],
    passedChecks: [],
  },
  sourceAdmission: "closed",
  generatedAt: UPDATED_AT,
});

const START_RESPONSE = OnboardAgentEvidenceStartResponseSchema.parse({
  protocolVersion: 1,
  trialHandle: TRIAL_HANDLE,
  reservationCapability: RESERVATION_CAPABILITY,
  expiresAt: RESERVATION_EXPIRES_AT,
  state: "awaiting_evidence",
});

const PROGRESS_RESPONSE = OnboardAgentProgressResponseSchema.parse({
  protocolVersion: 1,
  trialHandle: TRIAL_HANDLE,
  state: "awaiting_claim",
  stageLabel: "Preview ready — waiting for claim",
  completedMilestones: [
    "product_selected",
    "scope_approved",
    "evidence_received",
    "analysis_complete",
    "preview_ready",
  ],
  outstandingCorrections: [],
  publicSurfaceState: "not_started",
  publicSurfaceCandidates: [],
  publicPagesConfirmation: null,
  groundedPlayback: [],
  previewReady: true,
  previewUrl: PREVIEW_URL,
  claimReady: true,
  claimUrl: LEGACY_CLAIM_URL,
  failure: null,
  updatedAt: UPDATED_AT,
});

const CLAIMED_PROGRESS_RESPONSE = OnboardAgentProgressResponseSchema.parse({
  ...PROGRESS_RESPONSE,
  state: "claimed",
  stageLabel: "Connected to Layers",
  completedMilestones: [
    ...PROGRESS_RESPONSE.completedMilestones,
    "claimed",
  ],
  claimReady: false,
  claimUrl: null,
});

const CLAIM_ATTEMPT_RESPONSE = OnboardAgentClaimAttemptResponseSchema.parse({
  protocolVersion: 1,
  trialHandle: TRIAL_HANDLE,
  attemptHandle: ATTEMPT_HANDLE,
  claimUrl: ATTEMPT_CLAIM_URL,
  expiresAt: ATTEMPT_EXPIRES_AT,
  state: "pending",
});

const PENDING_EXCHANGE_RESPONSE =
  OnboardAgentClaimExchangeResponseSchema.parse({
    protocolVersion: 1,
    trialHandle: TRIAL_HANDLE,
    attemptHandle: ATTEMPT_HANDLE,
    state: "pending",
    expiresAt: ATTEMPT_EXPIRES_AT,
  });

const CLAIMED_EXCHANGE_RESPONSE =
  OnboardAgentClaimExchangeResponseSchema.parse({
    protocolVersion: 1,
    trialHandle: TRIAL_HANDLE,
    attemptHandle: ATTEMPT_HANDLE,
    state: "claimed",
    postclaimCapability: POSTCLAIM_CAPABILITY,
    capabilityExpiresAt: CAPABILITY_EXPIRES_AT,
  });

const POSTCLAIM_RESPONSE = OnboardAgentPostclaimResponseSchema.parse({
  protocolVersion: 1,
  trialHandle: TRIAL_HANDLE,
  state: "claimed",
  organizationName: "Source Launcher Organization",
  projectName: "Source Launcher Project",
  capabilityState: "active",
  capabilityExpiresAt: CAPABILITY_EXPIRES_AT,
  postclaimState: "running",
  generationStatus: "generating",
  updatedAt: UPDATED_AT,
});

/**
 * A two-question walk shaped like the canonical set: one optional multi-select
 * baseline question, then the single-select `goal` question whose `other` arm is
 * the one place free text has a home.
 */
const INTAKE_WALK_QUESTIONS = [
  {
    field: "triedChannels",
    group: "baseline",
    select: "multiple",
    title: "Have you tried any of these growth strategies?",
    options: [
      { value: "social", label: "Posted on social" },
      { value: "ads", label: "Ran paid ads" },
    ],
  },
  {
    field: "goal",
    group: "direction",
    select: "single",
    title: "What are you trying to grow?",
    subtitle: "Pick the one that matters most right now.",
    options: [
      { value: "installs", label: "More installs" },
      { value: "other", label: "Something else" },
    ],
  },
];

function respondJson(response, status, body, headers = {}) {
  response.writeHead(status, {
    ...headers,
    "cache-control": "no-store",
    "content-type": "application/json",
  });
  response.end(JSON.stringify(body));
}

function requestHeader(request, name) {
  const value = request.headers[name.toLowerCase()];
  assert.equal(typeof value, "string", `missing ${name}`);
  return value;
}

function requestsAt(requests, pathname) {
  return requests.filter((request) => request.pathname === pathname);
}

async function createMockApi(
  temporaryRoot,
  { startResponse = START_RESPONSE, intakeQuestions = [] } = {},
) {
  const requests = [];
  const unexpectedRequests = [];
  let exchangeCount = 0;
  let claimAttemptCount = 0;
  // The mock keeps the walk the way the route does: answers accumulate and the
  // remaining list is recomputed on every read AND every write.
  const intakeAnswers = new Map();

  const evidencePath = ONBOARD_AGENT_PUBLIC_ROUTE_PATHS.evidence.replace(
    ":trialHandle",
    TRIAL_HANDLE,
  );
  const progressPath = ONBOARD_AGENT_PUBLIC_ROUTE_PATHS.progress.replace(
    ":trialHandle",
    TRIAL_HANDLE,
  );
  const claimAttemptsPath =
    ONBOARD_AGENT_PUBLIC_ROUTE_PATHS.claimAttempts.replace(
      ":trialHandle",
      TRIAL_HANDLE,
    );
  const exchangePath = ONBOARD_AGENT_PUBLIC_ROUTE_PATHS.claimAttemptExchange
    .replace(":trialHandle", TRIAL_HANDLE)
    .replace(":attemptHandle", ATTEMPT_HANDLE);
  const postclaimPath = ONBOARD_AGENT_PUBLIC_ROUTE_PATHS.postclaim.replace(
    ":trialHandle",
    TRIAL_HANDLE,
  );
  const intakePath = ONBOARD_AGENT_INTAKE_ANSWERS_ROUTE_PATH.replace(
    ":trialHandle",
    TRIAL_HANDLE,
  );

  const intakeWalk = () => {
    const remaining = intakeQuestions.filter(
      (question) => !intakeAnswers.has(question.field),
    );
    return IntakeAnswersResponseSchema.parse({
      protocolVersion: 1,
      trialHandle: TRIAL_HANDLE,
      complete: remaining.length === 0,
      answersConverged: true,
      answered: [...intakeAnswers.keys()],
      intake: {
        docks: remaining.length === 0
          ? []
          : [{ group: remaining[0].group, questions: remaining }],
        remaining,
      },
    });
  };

  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const pathname = new URL(request.url ?? "/", "http://mock.local")
        .pathname;
      const captured = {
        method: request.method,
        pathname,
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(captured);

      if (
        request.method === "GET" &&
        pathname === ONBOARD_AGENT_PUBLIC_ROUTE_PATHS.capabilities
      ) {
        respondJson(response, 200, CAPABILITY_MANIFEST);
        return;
      }
      if (
        request.method === "GET" &&
        pathname === ONBOARD_AGENT_PUBLIC_ROUTE_PATHS.challenge
      ) {
        respondJson(
          response,
          200,
          OnboardAgentChallengeResponseSchema.parse({
            nonce: "source-launcher-challenge",
            difficulty: 1,
          }),
        );
        return;
      }
      if (
        request.method === "POST" &&
        pathname === ONBOARD_AGENT_PUBLIC_ROUTE_PATHS.start
      ) {
        respondJson(response, 202, startResponse);
        return;
      }
      if (request.method === "POST" && pathname === evidencePath) {
        const liveCollectorStages = readdirSync(temporaryRoot, {
          withFileTypes: true,
        })
          .filter(
            (entry) =>
              entry.isDirectory() && entry.name.startsWith(STAGE_PREFIX),
          )
          .map((entry) => entry.name);
        assert.deepEqual(
          liveCollectorStages,
          [],
          "collector cleanup must finish before evidence leaves the host",
        );
        respondJson(
          response,
          202,
          OnboardAgentEvidenceUploadResponseSchema.parse({
            protocolVersion: 1,
            trialHandle: TRIAL_HANDLE,
            evidenceId: "00000000-0000-4000-8000-000000000101",
            state: "evidence_received",
          }),
        );
        return;
      }
      if (request.method === "GET" && pathname === progressPath) {
        respondJson(
          response,
          200,
          exchangeCount === 0
            ? PROGRESS_RESPONSE
            : CLAIMED_PROGRESS_RESPONSE,
        );
        return;
      }
      if (request.method === "POST" && pathname === claimAttemptsPath) {
        claimAttemptCount += 1;
        if (claimAttemptCount === 1) {
          respondJson(response, 429, { error: "claim setup is busy" }, {
            "retry-after": "0",
          });
          return;
        }
        respondJson(response, 202, CLAIM_ATTEMPT_RESPONSE);
        return;
      }
      if (request.method === "POST" && pathname === exchangePath) {
        exchangeCount += 1;
        respondJson(
          response,
          exchangeCount === 1 ? 202 : 200,
          exchangeCount === 1
            ? PENDING_EXCHANGE_RESPONSE
            : CLAIMED_EXCHANGE_RESPONSE,
        );
        return;
      }
      if (request.method === "GET" && pathname === postclaimPath) {
        respondJson(response, 200, POSTCLAIM_RESPONSE);
        return;
      }
      if (request.method === "GET" && pathname === intakePath) {
        respondJson(response, 200, intakeWalk());
        return;
      }
      if (request.method === "POST" && pathname === intakePath) {
        const parsed = IntakeAnswersRequestSchema.safeParse(
          JSON.parse(captured.body),
        );
        if (!parsed.success) {
          respondJson(response, 400, {
            error: "Invalid onboarding intake request.",
            reason: "malformed answer envelope",
          });
          return;
        }
        for (const answer of parsed.data.answers) {
          const question = intakeQuestions.find(
            (candidate) => candidate.field === answer.field,
          );
          const offered = new Set(
            (question?.options ?? []).map((option) => option.value),
          );
          const unknown = answer.optionValues.find(
            (value) => !offered.has(value),
          );
          // The route's own refusal shape: a 400 whose `reason` names the pick
          // it would not take, so the caller can re-ask with the options.
          if (!question || unknown !== undefined) {
            respondJson(response, 400, {
              error: "Invalid onboarding intake request.",
              reason: question
                ? `Unknown option for ${answer.field}: ${unknown}`
                : `Unknown intake question: ${answer.field}`,
            });
            return;
          }
          intakeAnswers.set(answer.field, answer.optionValues);
        }
        respondJson(response, 200, intakeWalk());
        return;
      }

      unexpectedRequests.push(`${request.method} ${pathname}`);
      respondJson(response, 500, { error: "unexpected mock request" });
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    unexpectedRequests,
    get exchangeCount() {
      return exchangeCount;
    },
    close: async () => {
      server.closeAllConnections?.();
      if (!server.listening) return;
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function createSingleProductGitFixture(root) {
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "src"), { recursive: true, mode: 0o755 });
  await Promise.all([
    writeFile(
      join(workspace, "package.json"),
      `${JSON.stringify(
        {
          name: "source-launcher-fixture",
          version: "1.0.0",
          private: true,
          description: "A deterministic source launcher fixture.",
          scripts: { start: "node src/index.js" },
          dependencies: { react: "19.1.1" },
        },
        null,
        2,
      )}\n`,
      { mode: 0o644 },
    ),
    writeFile(
      join(workspace, "README.md"),
      `# Source Launcher Fixture\n\n## Overview\n\nA deterministic product fixture. ${SOURCE_BODY_SENTINEL}\n`,
      { mode: 0o644 },
    ),
    writeFile(join(workspace, "src", "index.js"), "export {};\n", {
      mode: 0o644,
    }),
    writeFile(
      join(workspace, ".env"),
      `PRIVATE_KEY=${SOURCE_SECRET_SENTINEL}\n`,
      { mode: 0o644 },
    ),
  ]);

  await execFileAsync("git", ["init", "--quiet"], { cwd: workspace });
  await execFileAsync("git", ["config", "user.name", "Layers Tests"], {
    cwd: workspace,
  });
  await execFileAsync("git", ["config", "user.email", "tests@layers.test"], {
    cwd: workspace,
  });
  await execFileAsync(
    "git",
    ["add", "--force", "package.json", "README.md", "src/index.js", ".env"],
    { cwd: workspace },
  );
  await execFileAsync(
    "git",
    ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture"],
    {
      cwd: workspace,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: "2026-08-13T22:00:00Z",
        GIT_COMMITTER_DATE: "2026-08-13T22:00:00Z",
      },
    },
  );
  return workspace;
}

function spawnLauncher(
  workspace,
  baseUrl,
  temporaryRoot,
  { argv = [SERVER, "onboard", "--base-url", baseUrl], extraEnv = {} } = {},
) {
  const env = {
    ...process.env,
    LAYERS_ONBOARD_INTERNAL_PROBE_TOKEN: INTERNAL_PROBE_TOKEN,
    TMPDIR: temporaryRoot,
    TMP: temporaryRoot,
    TEMP: temporaryRoot,
    ...extraEnv,
  };
  for (const name of [
    "LAYERS_API_KEY",
    "LAYERS_BASE_URL",
    "LAYERS_ORGANIZATION",
    "LAYERS_READ_ONLY",
  ]) {
    delete env[name];
  }

  const child = spawn(
    process.execPath,
    argv,
    { cwd: workspace, env, stdio: ["pipe", "pipe", "pipe"] },
  );
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  const exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  return {
    child,
    lines,
    iterator,
    exit,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
}

async function writeExpiryDriver(temporaryRoot) {
  const driverPath = join(temporaryRoot, "source-launcher-expiry-driver.mjs");
  const launcherUrl = pathToFileURL(
    join(PROJECT_ROOT, "dist", "onboarding", "launcher.js"),
  ).href;
  const collectorHostUrl = pathToFileURL(
    join(PROJECT_ROOT, "dist", "onboarding", "collector-host.js"),
  ).href;
  const source = [
    `import { runSourceOnboardCli } from ${JSON.stringify(launcherUrl)};`,
    `import { OnboardingCollectorHostError, openOnboardingCollector } from ${JSON.stringify(collectorHostUrl)};`,
    "",
    "const baseUrl = process.argv[2];",
    "const supportCode = process.env.LAYERS_TEST_COLLECTOR_SUPPORT_CODE;",
    "const supportFailureGeneration = Number.parseInt(process.env.LAYERS_TEST_COLLECTOR_FAIL_GENERATION ?? '1', 10);",
    "const expiringGenerations = Number.parseInt(process.env.LAYERS_TEST_EXPIRING_GENERATIONS ?? '0', 10);",
    "const generationMs = Number.parseInt(process.env.LAYERS_TEST_GENERATION_MS ?? '5000', 10);",
    "const cleanupUnproved = process.env.LAYERS_TEST_CLEANUP_UNPROVED === '1';",
    "const reinspectSupportCode = process.env.LAYERS_TEST_REINSPECT_SUPPORT_CODE;",
    "let generation = 0;",
    "",
    "function wrapSession(session, { transformTermination = (value) => value, reinspect = session.reinspect.bind(session) } = {}) {",
    "  return {",
    "    get deadlineAtMs() { return session.deadlineAtMs; },",
    "    waitForTermination: async () => transformTermination(await session.waitForTermination()),",
    "    inspect: session.inspect.bind(session),",
    "    select: session.select.bind(session),",
    "    reinspect,",
    "    prepare: session.prepare.bind(session),",
    "    complete: session.complete.bind(session),",
    "    cancel: session.cancel.bind(session),",
    "    abort: session.abort.bind(session),",
    "  };",
    "}",
    "",
    "const openCollector = async (options) => {",
    "  generation += 1;",
    "  if (supportCode && generation === supportFailureGeneration) {",
    "    if (supportCode === 'ONBOARD_COLLECTOR_TIMEOUT') {",
    "      return await openOnboardingCollector({ ...options, deadlineAtMs: Date.now() - 1 });",
    "    }",
    "    throw new OnboardingCollectorHostError(supportCode, 'Injected bounded collector failure.');",
    "  }",
    "  const expires = generation <= expiringGenerations;",
    "  const session = await openOnboardingCollector({",
    "    ...options,",
    "    ...(expires ? { deadlineAtMs: Date.now() + generationMs } : {}),",
    "  });",
    "  if (reinspectSupportCode && generation === 1) {",
    "    return wrapSession(session, {",
    "      reinspect: async () => {",
    "        const error = new OnboardingCollectorHostError(reinspectSupportCode, 'Injected bounded reinspection failure.');",
    "        session.abort();",
    "        throw error;",
    "      },",
    "    });",
    "  }",
    "  if (!cleanupUnproved || generation !== 1) return session;",
    "  return wrapSession(session, {",
    "    transformTermination: (termination) => ({",
    "      ...termination,",
    "      cleanup: termination.cleanup.then(() => null),",
    "    }),",
    "  });",
    "};",
    "",
    "try {",
    "  await runSourceOnboardCli(",
    "    { baseUrl, launcherVersion: '1.3.0' },",
    "    { openCollector },",
    "  );",
    "} catch (error) {",
    "  console.error(error instanceof Error ? error.message : String(error));",
    "  process.exitCode = 1;",
    "}",
    "",
  ].join("\n");
  await writeFile(driverPath, source, { mode: 0o600 });
  return driverPath;
}

function parseOutputEvents(stdout) {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function assertSingleTerminalError(run, expected) {
  const { stage = "review_scope", ...expectedFields } = expected;
  const events = parseOutputEvents(run.stdout);
  const terminal = events.filter((event) => event.type === "error");
  assert.deepEqual(terminal, [
    {
      type: "error",
      stage,
      evidenceSubmitted: false,
      ...expectedFields,
    },
  ]);
  assert.equal(events.some((event) => event.type === "complete"), false);
  const combinedOutput = `${run.stdout}\n${run.stderr}`;
  for (const [label, secret] of [
    ["reservation capability", RESERVATION_CAPABILITY],
    ["internal probe", INTERNAL_PROBE_TOKEN],
    ["source body", SOURCE_BODY_SENTINEL],
    ["source secret", SOURCE_SECRET_SENTINEL],
  ]) {
    assert.equal(
      combinedOutput.includes(secret),
      false,
      `terminal output disclosed ${label}`,
    );
  }
}

async function withTimeout(promise, label, timeoutMs = REQUEST_TIMEOUT_MS) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Timed out waiting for ${label}`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function nextEvent(run, predicate, label) {
  for (;;) {
    const line = await withTimeout(run.iterator.next(), label);
    if (line.done) throw new Error(`Launcher exited before ${label}`);
    if (line.value.trim().length === 0) continue;
    const event = JSON.parse(line.value);
    if (predicate(event)) return event;
  }
}

async function writeCommand(run, command, close = false) {
  await new Promise((resolve, reject) => {
    const callback = (error) => (error ? reject(error) : resolve());
    if (close) run.child.stdin.end(`${command}\n`, callback);
    else run.child.stdin.write(`${command}\n`, callback);
  });
}

test(
  "runs the real collector through exact consent, upload, claim continuity, and postclaim proof",
  { timeout: 90_000 },
  async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "layers-source-launcher-test-"),
    );
    let api;
    let run;
    try {
      const workspace = await createSingleProductGitFixture(temporaryRoot);
      api = await createMockApi(temporaryRoot);
      run = spawnLauncher(workspace, api.baseUrl, temporaryRoot);

      const initialInspectionEvent = await nextEvent(
        run,
        (event) => event.type === "inspection",
        "initial source inspection",
      );
      const initialInspection = initialInspectionEvent.inspection;
      assert.equal(initialInspection.status, "ready");
      assert.equal(initialInspection.candidates.length, 1);
      assert.equal(
        initialInspection.selectedCandidateId,
        initialInspection.candidates[0].candidateId,
      );
      assert.equal(initialInspection.candidates[0].recommended, true);

      const readmePath = initialInspection.consentPathItems.find(
        (item) => JSON.parse(item.escapedDisplayLabel) === "README.md",
      );
      assert.ok(readmePath?.included, "README must be an initially included path");

      await nextEvent(
        run,
        (event) =>
          event.type === "input_required" &&
          event.operation === "review_scope",
        "scope review prompt",
      );
      await writeCommand(run, `exclude-path ${readmePath.pathId}`);

      const revisedInspectionEvent = await nextEvent(
        run,
        (event) => event.type === "inspection",
        "scope-adjusted source inspection",
      );
      const revisedInspection = revisedInspectionEvent.inspection;
      assert.equal(revisedInspection.status, "ready");
      assert.equal(
        revisedInspection.selectedCandidateId,
        initialInspection.selectedCandidateId,
      );
      assert.deepEqual(
        revisedInspection.candidates.map((candidate) => candidate.candidateId),
        initialInspection.candidates.map((candidate) => candidate.candidateId),
      );
      assert.equal(
        revisedInspection.consentPathItems.find(
          (item) => item.pathId === readmePath.pathId,
        )?.included,
        false,
      );

      await nextEvent(
        run,
        (event) =>
          event.type === "input_required" &&
          event.operation === "review_scope",
        "revised scope review prompt",
      );
      await writeCommand(run, "prepare");

      const proposal = await nextEvent(
        run,
        (event) => event.type === "consent_proposal",
        "consent proposal",
      );
      assert.equal(
        createHash("sha256")
          .update(proposal.canonicalProjection, "utf8")
          .digest("hex"),
        proposal.canonicalProjectionSha256,
      );
      const approvalPrompt = await nextEvent(
        run,
        (event) =>
          event.type === "input_required" &&
          event.operation === "approve_consent",
        "exact consent approval prompt",
      );
      const exactApproval =
        `approve ${proposal.displayEventId} ${proposal.canonicalProjectionSha256}`;
      assert.equal(approvalPrompt.commands[0], exactApproval);

      const evidencePath = ONBOARD_AGENT_PUBLIC_ROUTE_PATHS.evidence.replace(
        ":trialHandle",
        TRIAL_HANDLE,
      );
      assert.equal(
        requestsAt(api.requests, evidencePath).length,
        0,
        "no evidence may upload before the exact approval interaction",
      );
      // Closing stdin after the final interaction also proves the launcher keeps
      // its own preview/claim wait alive instead of relying on an open input pipe.
      await writeCommand(run, exactApproval, true);

      // An empty walk settles the claim gate on the first read and asks nothing,
      // so the handoff below is unchanged from the pre-intake flow.
      const intakeEvent = await nextEvent(
        run,
        (event) => event.type === "intake",
        "empty intake walk",
      );
      assert.deepEqual(intakeEvent, {
        type: "intake",
        message: "Layers had no setup questions outstanding.",
        state: "not_required",
        complete: true,
        answered: 0,
        remaining: 0,
        answersConverged: true,
      });

      const progressEvent = await nextEvent(
        run,
        (event) => event.type === "progress",
        "safe claim progress",
      );
      assert.equal(progressEvent.progress.claimUrl, ATTEMPT_CLAIM_URL);
      assert.notEqual(progressEvent.progress.claimUrl, LEGACY_CLAIM_URL);
      assert.deepEqual(
        OnboardAgentProgressResponseSchema.parse(progressEvent.progress),
        {
          ...PROGRESS_RESPONSE,
          claimUrl: ATTEMPT_CLAIM_URL,
        },
      );

      const claimedProgressEvent = await nextEvent(
        run,
        (event) =>
          event.type === "progress" && event.progress?.state === "claimed",
        "schema-valid claimed progress",
      );
      assert.deepEqual(
        OnboardAgentProgressResponseSchema.parse(
          claimedProgressEvent.progress,
        ),
        CLAIMED_PROGRESS_RESPONSE,
      );

      const completeEvent = await nextEvent(
        run,
        (event) => event.type === "complete",
        "postclaim terminal result",
      );
      assert.deepEqual(completeEvent, {
        type: "complete",
        previewUrl: PREVIEW_URL,
        state: "claimed",
        postclaim: POSTCLAIM_RESPONSE,
        intake: {
          state: "not_required",
          complete: true,
          answered: 0,
          remaining: 0,
          answersConverged: true,
        },
      });
      assert.deepEqual(await withTimeout(run.exit, "launcher exit"), {
        code: 0,
        signal: null,
      });

      assert.deepEqual(api.unexpectedRequests, []);
      assert.equal(api.exchangeCount, 2);

      const intakePath = ONBOARD_AGENT_INTAKE_ANSWERS_ROUTE_PATH.replace(
        ":trialHandle",
        TRIAL_HANDLE,
      );
      const intakeRequests = requestsAt(api.requests, intakePath);
      assert.equal(intakeRequests.length, 1, "one walk read, no writes");
      assert.equal(intakeRequests[0].method, "GET");
      assert.equal(
        requestHeader(
          intakeRequests[0],
          ONBOARD_AGENT_PUBLIC_HEADER_NAMES.reservationCapability,
        ),
        RESERVATION_CAPABILITY,
      );

      const startRequest = requestsAt(
        api.requests,
        ONBOARD_AGENT_PUBLIC_ROUTE_PATHS.start,
      );
      assert.equal(startRequest.length, 1);
      assert.equal(
        requestHeader(startRequest[0], "x-layers-onboard-internal-probe"),
        INTERNAL_PROBE_TOKEN,
      );
      OnboardAgentEvidenceStartRequestSchema.parse(
        JSON.parse(startRequest[0].body),
      );
      for (const request of api.requests) {
        if (request !== startRequest[0]) {
          assert.equal(
            request.headers["x-layers-onboard-internal-probe"],
            undefined,
          );
        }
      }

      const evidenceRequests = requestsAt(api.requests, evidencePath);
      assert.equal(evidenceRequests.length, 1);
      const evidenceRequest = evidenceRequests[0];
      const evidenceBodyBytes = Buffer.byteLength(evidenceRequest.body, "utf8");
      const evidenceHeaders = OnboardAgentEvidenceUploadHeadersSchema.parse({
        reservationCapability: requestHeader(
          evidenceRequest,
          ONBOARD_AGENT_PUBLIC_HEADER_NAMES.reservationCapability,
        ),
        submissionRequestId: requestHeader(
          evidenceRequest,
          ONBOARD_AGENT_PUBLIC_HEADER_NAMES.submissionRequestId,
        ),
        evidenceKind: requestHeader(
          evidenceRequest,
          ONBOARD_AGENT_PUBLIC_HEADER_NAMES.evidenceKind,
        ),
        evidenceSchemaVersion: Number(
          requestHeader(
            evidenceRequest,
            ONBOARD_AGENT_PUBLIC_HEADER_NAMES.evidenceSchemaVersion,
          ),
        ),
        collectionPolicyVersion: requestHeader(
          evidenceRequest,
          ONBOARD_AGENT_PUBLIC_HEADER_NAMES.collectionPolicyVersion,
        ),
        declaredBodyBytes: Number(
          requestHeader(
            evidenceRequest,
            ONBOARD_AGENT_PUBLIC_HEADER_NAMES.contentLength,
          ),
        ),
      });
      assert.equal(
        evidenceHeaders.reservationCapability,
        RESERVATION_CAPABILITY,
      );
      assert.equal(
        requestHeader(
          evidenceRequest,
          ONBOARD_AGENT_PUBLIC_HEADER_NAMES.contentType,
        ),
        ONBOARD_AGENT_EVIDENCE_CONTENT_TYPE,
      );
      assert.equal(
        requestHeader(
          evidenceRequest,
          ONBOARD_AGENT_PUBLIC_HEADER_NAMES.contentEncoding,
        ),
        ONBOARD_AGENT_EVIDENCE_CONTENT_ENCODING,
      );
      assert.equal(
        Number(
          requestHeader(
            evidenceRequest,
            ONBOARD_AGENT_PUBLIC_HEADER_NAMES.contentLength,
          ),
        ),
        evidenceBodyBytes,
      );

      const envelope = OnboardingEvidenceEnvelopeSchema.parse(
        JSON.parse(evidenceRequest.body),
      );
      assert.deepEqual(
        envelope.consentProposal,
        JSON.parse(proposal.canonicalProjection),
      );
      assert.equal(
        envelope.consentDisplay.canonicalProjectionSha256,
        proposal.canonicalProjectionSha256,
      );
      assert.equal(
        envelope.consentDisplay.displayEventId,
        proposal.displayEventId,
      );
      assert.equal(
        envelope.consentApproval.displayEventId,
        proposal.displayEventId,
      );
      assert.equal(envelope.consentApproval.decision, "APPROVE_EXACT_SCOPE");
      assert.deepEqual(envelope.consentProposal.exclusions.userExcludedPathIds, [
        readmePath.pathId,
      ]);
      assert.equal(
        envelope.consentProposal.consentPathItems.find(
          (item) => item.pathId === readmePath.pathId,
        )?.included,
        false,
      );
      assert.equal(evidenceRequest.body.includes(SOURCE_BODY_SENTINEL), false);
      assert.equal(evidenceRequest.body.includes(SOURCE_SECRET_SENTINEL), false);

      const progressPath = ONBOARD_AGENT_PUBLIC_ROUTE_PATHS.progress.replace(
        ":trialHandle",
        TRIAL_HANDLE,
      );
      const progressRequests = requestsAt(api.requests, progressPath);
      assert.equal(progressRequests.length, 2);
      for (const request of progressRequests) {
        const progressHeaders = OnboardAgentProgressHeadersSchema.parse({
          reservationCapability: requestHeader(
            request,
            ONBOARD_AGENT_PUBLIC_HEADER_NAMES.reservationCapability,
          ),
        });
        assert.equal(
          progressHeaders.reservationCapability,
          RESERVATION_CAPABILITY,
        );
      }

      const claimAttemptsPath =
        ONBOARD_AGENT_PUBLIC_ROUTE_PATHS.claimAttempts.replace(
          ":trialHandle",
          TRIAL_HANDLE,
        );
      const claimRequests = requestsAt(api.requests, claimAttemptsPath);
      assert.equal(claimRequests.length, 2);
      const claimHeaders = OnboardAgentClaimTransportHeadersSchema.parse({
        reservationCapability: requestHeader(
          claimRequests[0],
          ONBOARD_AGENT_PUBLIC_HEADER_NAMES.reservationCapability,
        ),
        transportCapability: requestHeader(
          claimRequests[0],
          ONBOARD_AGENT_PUBLIC_HEADER_NAMES.transportCapability,
        ),
      });
      assert.equal(
        claimHeaders.reservationCapability,
        RESERVATION_CAPABILITY,
      );
      const claimBody = OnboardAgentClaimAttemptRequestSchema.parse(
        JSON.parse(claimRequests[0].body),
      );
      assert.equal(claimRequests[1].method, claimRequests[0].method);
      assert.equal(claimRequests[1].body, claimRequests[0].body);
      assert.deepEqual(
        [...new Headers(claimRequests[1].headers).entries()],
        [...new Headers(claimRequests[0].headers).entries()],
        "claim setup retry must preserve the exact private request",
      );

      const exchangePath = ONBOARD_AGENT_PUBLIC_ROUTE_PATHS.claimAttemptExchange
        .replace(":trialHandle", TRIAL_HANDLE)
        .replace(":attemptHandle", ATTEMPT_HANDLE);
      const exchangeRequests = requestsAt(api.requests, exchangePath);
      assert.equal(exchangeRequests.length, 2);
      const exchangeBodies = exchangeRequests.map((request) => {
        assert.equal(
          requestHeader(
            request,
            ONBOARD_AGENT_PUBLIC_HEADER_NAMES.transportCapability,
          ),
          claimHeaders.transportCapability,
        );
        return OnboardAgentClaimExchangeRequestSchema.parse(
          JSON.parse(request.body),
        );
      });
      assert.deepEqual(exchangeBodies[1], exchangeBodies[0]);
      assert.equal(
        createHash("sha256")
          .update(exchangeBodies[0].codeVerifier, "ascii")
          .digest("base64url"),
        claimBody.codeChallenge,
      );

      const postclaimPath = ONBOARD_AGENT_PUBLIC_ROUTE_PATHS.postclaim.replace(
        ":trialHandle",
        TRIAL_HANDLE,
      );
      const postclaimRequests = requestsAt(api.requests, postclaimPath);
      assert.equal(postclaimRequests.length, 1);
      OnboardAgentPostclaimHeadersSchema.parse({
        postclaimCapability: requestHeader(
          postclaimRequests[0],
          ONBOARD_AGENT_PUBLIC_HEADER_NAMES.postclaimCapability,
        ),
      });
      assert.equal(
        requestHeader(
          postclaimRequests[0],
          ONBOARD_AGENT_PUBLIC_HEADER_NAMES.postclaimCapability,
        ),
        POSTCLAIM_CAPABILITY,
      );
      assert.equal(api.requests.at(-1), postclaimRequests[0]);

      const combinedOutput = `${run.stdout}\n${run.stderr}`;
      for (const [label, secret] of [
        ["reservation capability", RESERVATION_CAPABILITY],
        ["internal probe", INTERNAL_PROBE_TOKEN],
        ["transport capability", claimHeaders.transportCapability],
        ["PKCE verifier", exchangeBodies[0].codeVerifier],
        ["postclaim capability", POSTCLAIM_CAPABILITY],
        ["legacy claim token", LEGACY_CLAIM_TOKEN],
        ["source body", SOURCE_BODY_SENTINEL],
        ["source secret", SOURCE_SECRET_SENTINEL],
      ]) {
        assert.equal(
          combinedOutput.includes(secret),
          false,
          `launcher output disclosed ${label}`,
        );
      }

      const stageDirectories = (
        await readdir(temporaryRoot, { withFileTypes: true })
      )
        .filter(
          (entry) => entry.isDirectory() && entry.name.startsWith(STAGE_PREFIX),
        )
        .map((entry) => entry.name);
      assert.deepEqual(stageDirectories, []);
    } finally {
      run?.lines.close();
      run?.child.stdin.destroy();
      if (
        run &&
        run.child.exitCode === null &&
        run.child.signalCode === null
      ) {
        run.child.kill();
        await withTimeout(run.exit, "launcher cleanup", 5_000).catch(() => {});
      }
      await api?.close();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  },
);

/** Walk the real collector to the exact approval command and send it. */
async function approveThroughCollector(run, { close = false } = {}) {
  await nextEvent(
    run,
    (event) => event.type === "inspection",
    "initial source inspection",
  );
  await nextEvent(
    run,
    (event) =>
      event.type === "input_required" && event.operation === "review_scope",
    "scope review prompt",
  );
  await writeCommand(run, "prepare");
  const proposal = await nextEvent(
    run,
    (event) => event.type === "consent_proposal",
    "consent proposal",
  );
  const approvalPrompt = await nextEvent(
    run,
    (event) =>
      event.type === "input_required" && event.operation === "approve_consent",
    "exact consent approval prompt",
  );
  const exactApproval =
    `approve ${proposal.displayEventId} ${proposal.canonicalProjectionSha256}`;
  assert.equal(approvalPrompt.commands[0], exactApproval);
  await writeCommand(run, exactApproval, close);
  return proposal;
}

test(
  "asks the canonical intake walk one question at a time and holds the claim link until the last answer",
  { timeout: 90_000 },
  async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "layers-source-intake-test-"),
    );
    let api;
    let run;
    try {
      const workspace = await createSingleProductGitFixture(temporaryRoot);
      api = await createMockApi(temporaryRoot, {
        intakeQuestions: INTAKE_WALK_QUESTIONS,
      });
      run = spawnLauncher(workspace, api.baseUrl, temporaryRoot);

      await approveThroughCollector(run);

      const claimAttemptsPath =
        ONBOARD_AGENT_PUBLIC_ROUTE_PATHS.claimAttempts.replace(
          ":trialHandle",
          TRIAL_HANDLE,
        );
      const intakePath = ONBOARD_AGENT_INTAKE_ANSWERS_ROUTE_PATH.replace(
        ":trialHandle",
        TRIAL_HANDLE,
      );

      const started = await nextEvent(
        run,
        (event) => event.type === "intake",
        "intake walk start",
      );
      assert.deepEqual(started, {
        type: "intake",
        message:
          "Answering Layers setup questions while the preview builds in the background.",
        state: "asking",
        complete: false,
        answered: 0,
        remaining: 2,
        answersConverged: true,
      });

      // ONE QUESTION AT A TIME, in walk order, carrying the canonical title and
      // the offered options verbatim.
      const firstTurn = await nextEvent(
        run,
        (event) =>
          event.type === "input_required" &&
          event.operation === "answer_intake",
        "first intake question",
      );
      assert.deepEqual(firstTurn, {
        type: "input_required",
        operation: "answer_intake",
        question: {
          field: "triedChannels",
          title: "Have you tried any of these growth strategies?",
          select: "multiple",
          allowsFreeText: false,
          options: [
            { value: "social", label: "Posted on social" },
            { value: "ads", label: "Ran paid ads" },
          ],
        },
        answered: 0,
        remaining: 2,
        commands: [
          "answer triedChannels social",
          "answer triedChannels ads",
          "answer triedChannels <value>,<value>",
          "answer triedChannels",
        ],
      });

      // The preview is ready from the first poll in this mock, so the claim
      // handoff is being held by intake alone.
      assert.equal(
        requestsAt(api.requests, claimAttemptsPath).length,
        0,
        "no claim attempt may exist while questions are outstanding",
      );
      const heldProgress = parseOutputEvents(run.stdout).filter(
        (event) => event.type === "progress",
      );
      for (const event of heldProgress) {
        assert.equal(event.progress.claimReady, false);
        assert.equal(event.progress.claimUrl, null);
      }

      await writeCommand(run, "answer triedChannels social");

      const recorded = await nextEvent(
        run,
        (event) => event.type === "intake",
        "first answer recorded",
      );
      assert.deepEqual(recorded, {
        type: "intake",
        message: "Answer recorded.",
        state: "asking",
        complete: false,
        answered: 1,
        remaining: 1,
        answersConverged: true,
      });

      const secondTurn = await nextEvent(
        run,
        (event) =>
          event.type === "input_required" &&
          event.operation === "answer_intake",
        "second intake question",
      );
      assert.deepEqual(secondTurn.question, {
        field: "goal",
        title: "What are you trying to grow?",
        subtitle: "Pick the one that matters most right now.",
        select: "single",
        allowsFreeText: true,
        options: [
          { value: "installs", label: "More installs" },
          { value: "other", label: "Something else" },
        ],
      });
      assert.deepEqual(secondTurn.commands, [
        "answer goal installs",
        "answer goal other",
        "answer goal other <your own words>",
      ]);

      // An answer line naming an option this question does not offer re-asks the
      // same question and spends no request doing it.
      const writesBeforeBadLine = requestsAt(api.requests, intakePath).filter(
        (request) => request.method === "POST",
      ).length;
      await writeCommand(run, "answer goal bananas");
      const reprompt = await nextEvent(
        run,
        (event) =>
          event.type === "input_required" &&
          event.operation === "answer_intake",
        "re-prompt after an unusable answer line",
      );
      assert.deepEqual(reprompt, secondTurn);
      assert.equal(
        requestsAt(api.requests, intakePath).filter(
          (request) => request.method === "POST",
        ).length,
        writesBeforeBadLine,
      );

      await writeCommand(run, "answer goal other selling more hats", true);

      const completedIntake = await nextEvent(
        run,
        (event) => event.type === "intake" && event.state === "complete",
        "intake completion",
      );
      assert.deepEqual(completedIntake, {
        type: "intake",
        message: "Every Layers setup question is answered.",
        state: "complete",
        complete: true,
        answered: 2,
        remaining: 0,
        answersConverged: true,
      });

      // Only now may the attempt-bound claim URL appear.
      const claimProgress = await nextEvent(
        run,
        (event) =>
          event.type === "progress" && event.progress?.claimUrl !== null,
        "claim handoff after the final answer",
      );
      assert.equal(claimProgress.progress.claimUrl, ATTEMPT_CLAIM_URL);

      const completeEvent = await nextEvent(
        run,
        (event) => event.type === "complete",
        "postclaim terminal result",
      );
      assert.deepEqual(completeEvent.intake, {
        state: "complete",
        complete: true,
        answered: 2,
        remaining: 0,
        answersConverged: true,
      });
      assert.deepEqual(await withTimeout(run.exit, "launcher exit"), {
        code: 0,
        signal: null,
      });
      assert.deepEqual(api.unexpectedRequests, []);

      const intakeWrites = requestsAt(api.requests, intakePath).filter(
        (request) => request.method === "POST",
      );
      assert.equal(intakeWrites.length, 2, "one write per answered question");
      assert.deepEqual(
        intakeWrites.map((request) => JSON.parse(request.body)),
        [
          {
            protocolVersion: 1,
            answers: [{ field: "triedChannels", optionValues: ["social"] }],
          },
          {
            protocolVersion: 1,
            answers: [
              {
                field: "goal",
                optionValues: ["other"],
                text: "selling more hats",
              },
            ],
          },
        ],
      );
      for (const request of requestsAt(api.requests, intakePath)) {
        assert.equal(
          requestHeader(
            request,
            ONBOARD_AGENT_PUBLIC_HEADER_NAMES.reservationCapability,
          ),
          RESERVATION_CAPABILITY,
        );
      }
      assert.equal(
        `${run.stdout}\n${run.stderr}`.includes(RESERVATION_CAPABILITY),
        false,
        "intake must not disclose the reservation capability",
      );
    } finally {
      run?.lines.close();
      run?.child.stdin.destroy();
      if (
        run &&
        run.child.exitCode === null &&
        run.child.signalCode === null
      ) {
        run.child.kill();
        await withTimeout(run.exit, "intake cleanup", 5_000).catch(() => {});
      }
      await api?.close();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  },
);

test(
  "expires review and approval generations, rejects stale commands, and resumes the same reservation with fresh consent",
  { timeout: 90_000 },
  async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "layers-source-resume-test-"),
    );
    let api;
    let run;
    try {
      const workspace = await createSingleProductGitFixture(temporaryRoot);
      const driverPath = await writeExpiryDriver(temporaryRoot);
      api = await createMockApi(temporaryRoot);
      run = spawnLauncher(workspace, api.baseUrl, temporaryRoot, {
        argv: [driverPath, api.baseUrl],
        extraEnv: {
          LAYERS_TEST_EXPIRING_GENERATIONS: "2",
          LAYERS_TEST_GENERATION_MS: "5000",
        },
      });

      const evidencePath = ONBOARD_AGENT_PUBLIC_ROUTE_PATHS.evidence.replace(
        ":trialHandle",
        TRIAL_HANDLE,
      );
      const startPath = ONBOARD_AGENT_PUBLIC_ROUTE_PATHS.start;
      const pathIds = (inspection) =>
        inspection.consentPathItems.map((item) => item.pathId).sort();

      const firstInspection = (
        await nextEvent(
          run,
          (event) => event.type === "inspection",
          "first inspection",
        )
      ).inspection;
      await nextEvent(
        run,
        (event) =>
          event.type === "input_required" &&
          event.operation === "review_scope",
        "first review prompt",
      );
      assert.equal(requestsAt(api.requests, evidencePath).length, 0);

      assert.deepEqual(
        await nextEvent(
          run,
          (event) => event.stage === "source_review_expired",
          "first generation expiry",
        ),
        {
          type: "status",
          stage: "source_review_expired",
          message:
            "The prior local inspection expired and was cleared. No evidence was sent.",
        },
      );
      assert.deepEqual(
        (await readdir(temporaryRoot, { withFileTypes: true }))
          .filter(
            (entry) =>
              entry.isDirectory() && entry.name.startsWith(STAGE_PREFIX),
          )
          .map((entry) => entry.name),
        [],
      );
      const firstResumePrompt = await nextEvent(
        run,
        (event) =>
          event.type === "input_required" &&
          event.operation === "resume_inspection",
        "first resume prompt",
      );
      assert.deepEqual(firstResumePrompt.commands, ["resume", "cancel"]);

      await writeCommand(run, "prepare");
      await nextEvent(
        run,
        (event) =>
          event.type === "input_required" &&
          event.operation === "resume_inspection",
        "resume prompt after stale prepare",
      );
      assert.equal(requestsAt(api.requests, evidencePath).length, 0);
      assert.equal(requestsAt(api.requests, startPath).length, 1);
      await writeCommand(run, "resume");

      const secondInspection = (
        await nextEvent(
          run,
          (event) => event.type === "inspection",
          "fresh inspection after review expiry",
        )
      ).inspection;
      assert.notDeepEqual(pathIds(secondInspection), pathIds(firstInspection));
      assert.equal(
        secondInspection.selectedCandidateId,
        firstInspection.selectedCandidateId,
      );
      await nextEvent(
        run,
        (event) =>
          event.type === "input_required" &&
          event.operation === "review_scope",
        "second review prompt",
      );
      await writeCommand(run, "prepare");

      const expiredProposal = await nextEvent(
        run,
        (event) => event.type === "consent_proposal",
        "proposal that will expire",
      );
      const staleApproval =
        `approve ${expiredProposal.displayEventId} ${expiredProposal.canonicalProjectionSha256}`;
      const secondApprovalPrompt = await nextEvent(
        run,
        (event) =>
          event.type === "input_required" &&
          event.operation === "approve_consent",
        "approval prompt that will expire",
      );
      assert.equal(secondApprovalPrompt.commands[0], staleApproval);
      assert.equal(requestsAt(api.requests, evidencePath).length, 0);

      await nextEvent(
        run,
        (event) => event.stage === "source_review_expired",
        "approval generation expiry",
      );
      assert.deepEqual(
        (await readdir(temporaryRoot, { withFileTypes: true }))
          .filter(
            (entry) =>
              entry.isDirectory() && entry.name.startsWith(STAGE_PREFIX),
          )
          .map((entry) => entry.name),
        [],
      );
      await nextEvent(
        run,
        (event) =>
          event.type === "input_required" &&
          event.operation === "resume_inspection",
        "resume prompt after approval expiry",
      );
      await writeCommand(run, staleApproval);
      await nextEvent(
        run,
        (event) =>
          event.type === "input_required" &&
          event.operation === "resume_inspection",
        "resume prompt after stale approval",
      );
      assert.equal(requestsAt(api.requests, evidencePath).length, 0);
      assert.equal(requestsAt(api.requests, startPath).length, 1);
      await writeCommand(run, "resume");

      const thirdInspection = (
        await nextEvent(
          run,
          (event) => event.type === "inspection",
          "fresh inspection after approval expiry",
        )
      ).inspection;
      assert.notDeepEqual(pathIds(thirdInspection), pathIds(secondInspection));
      assert.equal(
        thirdInspection.selectedCandidateId,
        secondInspection.selectedCandidateId,
      );
      await nextEvent(
        run,
        (event) =>
          event.type === "input_required" &&
          event.operation === "review_scope",
        "third review prompt",
      );
      await writeCommand(run, "prepare");

      const freshProposal = await nextEvent(
        run,
        (event) => event.type === "consent_proposal",
        "fresh proposal",
      );
      assert.notEqual(freshProposal.displayEventId, expiredProposal.displayEventId);
      assert.notEqual(
        freshProposal.canonicalProjectionSha256,
        expiredProposal.canonicalProjectionSha256,
      );
      const freshApproval =
        `approve ${freshProposal.displayEventId} ${freshProposal.canonicalProjectionSha256}`;
      assert.notEqual(freshApproval, staleApproval);
      const freshApprovalPrompt = await nextEvent(
        run,
        (event) =>
          event.type === "input_required" &&
          event.operation === "approve_consent",
        "fresh approval prompt",
      );
      assert.equal(freshApprovalPrompt.commands[0], freshApproval);
      assert.equal(requestsAt(api.requests, evidencePath).length, 0);
      await writeCommand(run, freshApproval, true);

      await nextEvent(
        run,
        (event) => event.type === "complete" && event.state === "claimed",
        "claimed completion after fresh approval",
      );
      assert.deepEqual(await withTimeout(run.exit, "resumed launcher exit"), {
        code: 0,
        signal: null,
      });

      const outputEvents = parseOutputEvents(run.stdout);
      assert.equal(
        outputEvents.filter(
          (event) =>
            event.type === "status" &&
            event.stage === "source_review_expired",
        ).length,
        2,
      );
      assert.equal(
        outputEvents.filter(
          (event) =>
            event.type === "input_required" &&
            event.operation === "resume_inspection",
        ).length,
        4,
      );
      assert.equal(requestsAt(api.requests, startPath).length, 1);
      const evidenceRequests = requestsAt(api.requests, evidencePath);
      assert.equal(evidenceRequests.length, 1);
      const envelope = OnboardingEvidenceEnvelopeSchema.parse(
        JSON.parse(evidenceRequests[0].body),
      );
      assert.deepEqual(
        envelope.consentProposal,
        JSON.parse(freshProposal.canonicalProjection),
      );
      assert.equal(
        envelope.consentDisplay.displayEventId,
        freshProposal.displayEventId,
      );
      assert.notEqual(
        envelope.consentDisplay.displayEventId,
        expiredProposal.displayEventId,
      );
      assert.equal(outputEvents.some((event) => event.type === "error"), false);
    } finally {
      run?.lines.close();
      run?.child.stdin.destroy();
      if (
        run &&
        run.child.exitCode === null &&
        run.child.signalCode === null
      ) {
        run.child.kill();
        await withTimeout(run.exit, "resume test cleanup", 5_000).catch(
          () => {},
        );
      }
      await api?.close();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  },
);

test(
  "preserves the consent stage when the reservation expires during resume wait",
  { timeout: 20_000 },
  async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "layers-source-approval-reservation-expiry-test-"),
    );
    let api;
    let run;
    try {
      const workspace = await createSingleProductGitFixture(temporaryRoot);
      const driverPath = await writeExpiryDriver(temporaryRoot);
      const startResponse = OnboardAgentEvidenceStartResponseSchema.parse({
        ...START_RESPONSE,
        expiresAt: new Date(Date.now() + 7_000).toISOString(),
      });
      api = await createMockApi(temporaryRoot, { startResponse });
      run = spawnLauncher(workspace, api.baseUrl, temporaryRoot, {
        argv: [driverPath, api.baseUrl],
        extraEnv: {
          LAYERS_TEST_EXPIRING_GENERATIONS: "1",
          LAYERS_TEST_GENERATION_MS: "2500",
        },
      });

      await nextEvent(
        run,
        (event) => event.type === "inspection",
        "approval reservation expiry inspection",
      );
      await nextEvent(
        run,
        (event) =>
          event.type === "input_required" &&
          event.operation === "review_scope",
        "approval reservation expiry review prompt",
      );
      await writeCommand(run, "prepare");
      await nextEvent(
        run,
        (event) => event.type === "consent_proposal",
        "approval reservation expiry proposal",
      );
      await nextEvent(
        run,
        (event) =>
          event.type === "input_required" &&
          event.operation === "approve_consent",
        "approval reservation expiry consent prompt",
      );
      await nextEvent(
        run,
        (event) => event.stage === "source_review_expired",
        "approval generation expiry",
      );
      await nextEvent(
        run,
        (event) =>
          event.type === "input_required" &&
          event.operation === "resume_inspection",
        "approval reservation expiry resume prompt",
      );

      const terminal = await nextEvent(
        run,
        (event) => event.type === "error",
        "approval reservation expiry terminal event",
      );
      const expected = {
        stage: "approve_consent",
        code: "ONBOARD_RESERVATION_EXPIRED",
        retryable: false,
        message: "The source reservation expired; no evidence was sent.",
      };
      assert.deepEqual(terminal, {
        type: "error",
        evidenceSubmitted: false,
        ...expected,
      });
      assert.deepEqual(
        await withTimeout(
          run.exit,
          "approval reservation expiry launcher exit",
        ),
        { code: 1, signal: null },
      );
      assertSingleTerminalError(run, expected);

      const evidencePath = ONBOARD_AGENT_PUBLIC_ROUTE_PATHS.evidence.replace(
        ":trialHandle",
        TRIAL_HANDLE,
      );
      assert.equal(requestsAt(api.requests, evidencePath).length, 0);
      assert.deepEqual(
        (await readdir(temporaryRoot, { withFileTypes: true }))
          .filter(
            (entry) =>
              entry.isDirectory() && entry.name.startsWith(STAGE_PREFIX),
          )
          .map((entry) => entry.name),
        [],
      );
    } finally {
      run?.lines.close();
      run?.child.stdin.destroy();
      if (
        run &&
        run.child.exitCode === null &&
        run.child.signalCode === null
      ) {
        run.child.kill();
        await withTimeout(
          run.exit,
          "approval reservation expiry cleanup",
          5_000,
        ).catch(() => {});
      }
      await api?.close();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  },
);

test(
  "emits one nonretryable reservation-expired event without opening a collector or submitting evidence",
  { timeout: 15_000 },
  async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "layers-source-reservation-expired-test-"),
    );
    let api;
    let run;
    try {
      const workspace = await createSingleProductGitFixture(temporaryRoot);
      const driverPath = await writeExpiryDriver(temporaryRoot);
      const startResponse = OnboardAgentEvidenceStartResponseSchema.parse({
        ...START_RESPONSE,
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      });
      api = await createMockApi(temporaryRoot, { startResponse });
      run = spawnLauncher(workspace, api.baseUrl, temporaryRoot, {
        argv: [driverPath, api.baseUrl],
      });

      const terminal = await nextEvent(
        run,
        (event) => event.type === "error",
        "reservation expiry",
      );
      assert.deepEqual(terminal, {
        type: "error",
        stage: "review_scope",
        code: "ONBOARD_RESERVATION_EXPIRED",
        retryable: false,
        evidenceSubmitted: false,
        message: "The source reservation expired; no evidence was sent.",
      });
      assert.deepEqual(
        await withTimeout(run.exit, "reservation-expired launcher exit"),
        { code: 1, signal: null },
      );
      assertSingleTerminalError(run, {
        code: "ONBOARD_RESERVATION_EXPIRED",
        retryable: false,
        message: "The source reservation expired; no evidence was sent.",
      });

      const evidencePath = ONBOARD_AGENT_PUBLIC_ROUTE_PATHS.evidence.replace(
        ":trialHandle",
        TRIAL_HANDLE,
      );
      assert.equal(requestsAt(api.requests, evidencePath).length, 0);
      assert.deepEqual(
        (await readdir(temporaryRoot, { withFileTypes: true }))
          .filter(
            (entry) =>
              entry.isDirectory() && entry.name.startsWith(STAGE_PREFIX),
          )
          .map((entry) => entry.name),
        [],
      );
    } finally {
      run?.lines.close();
      run?.child.stdin.destroy();
      if (
        run &&
        run.child.exitCode === null &&
        run.child.signalCode === null
      ) {
        run.child.kill();
        await withTimeout(run.exit, "reservation expiry cleanup", 5_000).catch(
          () => {},
        );
      }
      await api?.close();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  },
);

test(
  "validates expiry cleanup before terminal reservation classification",
  { timeout: 30_000 },
  async (testContext) => {
    const cases = [
      {
        name: "proved cleanup",
        cleanupUnproved: false,
        expected: {
          code: "ONBOARD_RESERVATION_EXPIRED",
          retryable: false,
          message: "The source reservation expired; no evidence was sent.",
        },
      },
      {
        name: "unproved cleanup",
        cleanupUnproved: true,
        expected: {
          code: "ONBOARD_COLLECTOR_FAILED",
          retryable: false,
          message: "Local source review could not continue; no evidence was sent.",
        },
      },
    ];

    for (const scenario of cases) {
      await testContext.test(scenario.name, { timeout: 15_000 }, async () => {
        const temporaryRoot = await mkdtemp(
          join(tmpdir(), "layers-source-deadline-cleanup-test-"),
        );
        let api;
        let run;
        try {
          const workspace = await createSingleProductGitFixture(temporaryRoot);
          const driverPath = await writeExpiryDriver(temporaryRoot);
          const startResponse = OnboardAgentEvidenceStartResponseSchema.parse({
            ...START_RESPONSE,
            expiresAt: new Date(Date.now() + 5_000).toISOString(),
          });
          api = await createMockApi(temporaryRoot, { startResponse });
          run = spawnLauncher(workspace, api.baseUrl, temporaryRoot, {
            argv: [driverPath, api.baseUrl],
            extraEnv: {
              ...(scenario.cleanupUnproved
                ? { LAYERS_TEST_CLEANUP_UNPROVED: "1" }
                : {}),
            },
          });

          await nextEvent(
            run,
            (event) => event.type === "inspection",
            `${scenario.name} inspection`,
          );
          await nextEvent(
            run,
            (event) =>
              event.type === "input_required" &&
              event.operation === "review_scope",
            `${scenario.name} review prompt`,
          );
          const terminal = await nextEvent(
            run,
            (event) => event.type === "error",
            `${scenario.name} terminal event`,
          );
          assert.deepEqual(terminal, {
            type: "error",
            stage: "review_scope",
            evidenceSubmitted: false,
            ...scenario.expected,
          });
          assert.deepEqual(
            await withTimeout(run.exit, `${scenario.name} launcher exit`),
            { code: 1, signal: null },
          );
          assertSingleTerminalError(run, scenario.expected);

          const events = parseOutputEvents(run.stdout);
          assert.equal(
            events.some((event) => event.stage === "source_review_expired"),
            false,
          );
          assert.equal(
            events.some(
              (event) =>
                event.type === "input_required" &&
                event.operation === "resume_inspection",
            ),
            false,
          );
          const evidencePath = ONBOARD_AGENT_PUBLIC_ROUTE_PATHS.evidence.replace(
            ":trialHandle",
            TRIAL_HANDLE,
          );
          assert.equal(requestsAt(api.requests, evidencePath).length, 0);
          assert.deepEqual(
            (await readdir(temporaryRoot, { withFileTypes: true }))
              .filter(
                (entry) =>
                  entry.isDirectory() && entry.name.startsWith(STAGE_PREFIX),
              )
              .map((entry) => entry.name),
            [],
          );
        } finally {
          run?.lines.close();
          run?.child.stdin.destroy();
          if (
            run &&
            run.child.exitCode === null &&
            run.child.signalCode === null
          ) {
            run.child.kill();
            await withTimeout(
              run.exit,
              `${scenario.name} cleanup`,
              5_000,
            ).catch(() => {});
          }
          await api?.close();
          await rm(temporaryRoot, { recursive: true, force: true });
        }
      });
    }
  },
);

test(
  "classifies an approval-time reinspection failure at the consent stage",
  { timeout: 20_000 },
  async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "layers-source-approval-reinspect-test-"),
    );
    let api;
    let run;
    try {
      const workspace = await createSingleProductGitFixture(temporaryRoot);
      const driverPath = await writeExpiryDriver(temporaryRoot);
      api = await createMockApi(temporaryRoot);
      run = spawnLauncher(workspace, api.baseUrl, temporaryRoot, {
        argv: [driverPath, api.baseUrl],
        extraEnv: {
          LAYERS_TEST_REINSPECT_SUPPORT_CODE: "ONBOARD_COLLECTOR_PROTOCOL",
        },
      });

      const inspection = (
        await nextEvent(
          run,
          (event) => event.type === "inspection",
          "approval reinspection initial scope",
        )
      ).inspection;
      const includedPath = inspection.consentPathItems.find(
        (item) => item.included,
      );
      assert.ok(includedPath, "fixture must expose an included consent path");

      await nextEvent(
        run,
        (event) =>
          event.type === "input_required" &&
          event.operation === "review_scope",
        "approval reinspection review prompt",
      );
      await writeCommand(run, "prepare");
      await nextEvent(
        run,
        (event) => event.type === "consent_proposal",
        "approval reinspection consent proposal",
      );
      await nextEvent(
        run,
        (event) =>
          event.type === "input_required" &&
          event.operation === "approve_consent",
        "approval reinspection consent prompt",
      );

      const evidencePath = ONBOARD_AGENT_PUBLIC_ROUTE_PATHS.evidence.replace(
        ":trialHandle",
        TRIAL_HANDLE,
      );
      assert.equal(requestsAt(api.requests, evidencePath).length, 0);
      await writeCommand(run, `exclude-path ${includedPath.pathId}`);

      const terminal = await nextEvent(
        run,
        (event) => event.type === "error",
        "approval reinspection terminal event",
      );
      const expected = {
        stage: "approve_consent",
        code: "ONBOARD_COLLECTOR_FAILED",
        retryable: false,
        message: "Local source review could not continue; no evidence was sent.",
      };
      assert.deepEqual(terminal, {
        type: "error",
        evidenceSubmitted: false,
        ...expected,
      });
      assert.deepEqual(
        await withTimeout(run.exit, "approval reinspection launcher exit"),
        { code: 1, signal: null },
      );
      assertSingleTerminalError(run, expected);
      assert.equal(requestsAt(api.requests, evidencePath).length, 0);
      assert.deepEqual(
        (await readdir(temporaryRoot, { withFileTypes: true }))
          .filter(
            (entry) =>
              entry.isDirectory() && entry.name.startsWith(STAGE_PREFIX),
          )
          .map((entry) => entry.name),
        [],
      );
    } finally {
      run?.lines.close();
      run?.child.stdin.destroy();
      if (
        run &&
        run.child.exitCode === null &&
        run.child.signalCode === null
      ) {
        run.child.kill();
        await withTimeout(
          run.exit,
          "approval reinspection cleanup",
          5_000,
        ).catch(() => {});
      }
      await api?.close();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  },
);

test(
  "preserves fresh-inspection support codes and only marks an actual timeout retryable",
  { timeout: 60_000 },
  async (testContext) => {
    const cases = [
      ["ONBOARD_COLLECTOR_TIMEOUT", true],
      ["ONBOARD_COLLECTOR_INTEGRITY", false],
      ["ONBOARD_COLLECTOR_PROTOCOL", false],
      ["ONBOARD_COLLECTOR_FAILED", false],
    ];

    for (const [supportCode, retryable] of cases) {
      await testContext.test(supportCode, { timeout: 20_000 }, async () => {
        const temporaryRoot = await mkdtemp(
          join(tmpdir(), "layers-source-support-code-test-"),
        );
        let api;
        let run;
        try {
          const workspace = await createSingleProductGitFixture(temporaryRoot);
          const driverPath = await writeExpiryDriver(temporaryRoot);
          api = await createMockApi(temporaryRoot);
          run = spawnLauncher(workspace, api.baseUrl, temporaryRoot, {
            argv: [driverPath, api.baseUrl],
            extraEnv: {
              LAYERS_TEST_COLLECTOR_SUPPORT_CODE: supportCode,
              LAYERS_TEST_COLLECTOR_FAIL_GENERATION: "2",
              LAYERS_TEST_EXPIRING_GENERATIONS: "1",
              LAYERS_TEST_GENERATION_MS: "4000",
            },
          });

          await nextEvent(
            run,
            (event) => event.type === "inspection",
            `${supportCode} first inspection`,
          );
          await nextEvent(
            run,
            (event) =>
              event.type === "input_required" &&
              event.operation === "review_scope",
            `${supportCode} first review prompt`,
          );
          await nextEvent(
            run,
            (event) => event.stage === "source_review_expired",
            `${supportCode} first generation expiry`,
          );
          await nextEvent(
            run,
            (event) =>
              event.type === "input_required" &&
              event.operation === "resume_inspection",
            `${supportCode} resume prompt`,
          );
          await writeCommand(run, "resume");

          const terminal = await nextEvent(
            run,
            (event) => event.type === "error",
            `${supportCode} terminal event`,
          );
          assert.deepEqual(terminal, {
            type: "error",
            stage: "review_scope",
            code: supportCode,
            retryable,
            evidenceSubmitted: false,
            message: "Local source review could not continue; no evidence was sent.",
          });
          assert.deepEqual(
            await withTimeout(run.exit, `${supportCode} launcher exit`),
            { code: 1, signal: null },
          );
          assertSingleTerminalError(run, {
            code: supportCode,
            retryable,
            message: "Local source review could not continue; no evidence was sent.",
          });

          assert.equal(
            requestsAt(
              api.requests,
              ONBOARD_AGENT_PUBLIC_ROUTE_PATHS.start,
            ).length,
            1,
          );
          const evidencePath = ONBOARD_AGENT_PUBLIC_ROUTE_PATHS.evidence.replace(
            ":trialHandle",
            TRIAL_HANDLE,
          );
          assert.equal(requestsAt(api.requests, evidencePath).length, 0);
          assert.deepEqual(
            (await readdir(temporaryRoot, { withFileTypes: true }))
              .filter(
                (entry) =>
                  entry.isDirectory() && entry.name.startsWith(STAGE_PREFIX),
              )
              .map((entry) => entry.name),
            [],
          );
        } finally {
          run?.lines.close();
          run?.child.stdin.destroy();
          if (
            run &&
            run.child.exitCode === null &&
            run.child.signalCode === null
          ) {
            run.child.kill();
            await withTimeout(run.exit, `${supportCode} cleanup`, 5_000).catch(
              () => {},
            );
          }
          await api?.close();
          await rm(temporaryRoot, { recursive: true, force: true });
        }
      });
    }
  },
);

test(
  "maps a real unsupported workspace to one nonretryable terminal event after cleanup",
  { timeout: 15_000 },
  async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "layers-source-unsupported-test-"),
    );
    let api;
    let run;
    try {
      const workspace = join(temporaryRoot, "unsupported-workspace");
      await mkdir(workspace, { recursive: true, mode: 0o755 });
      const driverPath = await writeExpiryDriver(temporaryRoot);
      api = await createMockApi(temporaryRoot);
      run = spawnLauncher(workspace, api.baseUrl, temporaryRoot, {
        argv: [driverPath, api.baseUrl],
      });

      const inspection = await nextEvent(
        run,
        (event) => event.type === "inspection",
        "unsupported workspace inspection",
      );
      assert.equal(inspection.inspection.status, "needs_url");
      const terminal = await nextEvent(
        run,
        (event) => event.type === "error",
        "unsupported workspace terminal event",
      );
      const expected = {
        code: "ONBOARD_COLLECTOR_UNSUPPORTED",
        retryable: false,
        message:
          "This folder does not contain a supported product workspace; no evidence was sent.",
      };
      assert.deepEqual(terminal, {
        type: "error",
        stage: "review_scope",
        evidenceSubmitted: false,
        ...expected,
      });
      assert.deepEqual(
        await withTimeout(run.exit, "unsupported workspace launcher exit"),
        { code: 1, signal: null },
      );
      assertSingleTerminalError(run, expected);

      const evidencePath = ONBOARD_AGENT_PUBLIC_ROUTE_PATHS.evidence.replace(
        ":trialHandle",
        TRIAL_HANDLE,
      );
      assert.equal(requestsAt(api.requests, evidencePath).length, 0);
      assert.deepEqual(
        (await readdir(temporaryRoot, { withFileTypes: true }))
          .filter(
            (entry) =>
              entry.isDirectory() && entry.name.startsWith(STAGE_PREFIX),
          )
          .map((entry) => entry.name),
        [],
      );
    } finally {
      run?.lines.close();
      run?.child.stdin.destroy();
      if (
        run &&
        run.child.exitCode === null &&
        run.child.signalCode === null
      ) {
        run.child.kill();
        await withTimeout(run.exit, "unsupported workspace cleanup", 5_000).catch(
          () => {},
        );
      }
      await api?.close();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  },
);

function rememberLauncherReservation(expiresAt) {
  rememberReservation({
    protocolVersion: 1,
    trialHandle: TRIAL_HANDLE,
    reservationCapability: RESERVATION_CAPABILITY,
    expiresAt,
    state: "awaiting_evidence",
  });
}

test("late claim setup surfaces its safe URL before awaiting-claim completion", async () => {
  // THE INVARIANT: a minted attempt's browser URL reaches the agent before the
  // wait can end. The wait is bounded here by the reservation rather than by a
  // dead transport leg — as of 1.3.1 an expired leg is re-armed, so it is no
  // longer a way to end anything.
  const reservationExpiresAt = new Date(Date.now() + 1_500).toISOString();
  rememberLauncherReservation(reservationExpiresAt);
  const originalFetch = globalThis.fetch;
  const events = [];

  globalThis.fetch = async (input) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname.endsWith("/progress")) {
      return Response.json(PROGRESS_RESPONSE, { status: 200 });
    }
    if (pathname.endsWith("/claim-attempts")) {
      return Response.json(CLAIM_ATTEMPT_RESPONSE, { status: 202 });
    }
    if (pathname.endsWith("/exchange")) {
      return Response.json(PENDING_EXCHANGE_RESPONSE, { status: 202 });
    }
    throw new Error(`unexpected request: ${pathname}`);
  };

  try {
    await withTimeout(
      waitForPreviewAndClaim(
        "https://api.layers.test",
        new AbortController().signal,
        reservationExpiresAt,
        (event) => events.push(event),
      ),
      "late claim setup",
      60_000,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  const safeProgressIndex = events.findIndex(
    (event) =>
      event.type === "progress" &&
      event.progress.claimUrl === ATTEMPT_CLAIM_URL,
  );
  const completionIndex = events.findIndex(
    (event) =>
      event.type === "complete" && event.state === "awaiting_claim",
  );
  assert.ok(safeProgressIndex >= 0, "the attempt-bound URL was published");
  assert.ok(completionIndex > safeProgressIndex);
  assert.equal(events[completionIndex].previewUrl, PREVIEW_URL);
  assert.equal(events[completionIndex].postclaim, null);
  // The portable trial-wide claim URL is still never exposed.
  assert.equal(
    events.some((event) => JSON.stringify(event).includes(LEGACY_CLAIM_TOKEN)),
    false,
  );
});

test("a server refusing every claim link stops early and blames the server", async () => {
  // Re-arming exists so a slow human still gets a live link. A server that
  // refuses every leg must not turn that into an unbounded mint loop.
  const reservationExpiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
  rememberLauncherReservation(reservationExpiresAt);
  const originalFetch = globalThis.fetch;
  const events = [];
  let attempts = 0;

  globalThis.fetch = async (input) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname.endsWith("/progress")) {
      return Response.json(PROGRESS_RESPONSE, { status: 200 });
    }
    if (pathname.endsWith("/claim-attempts")) {
      attempts += 1;
      return Response.json(
        {
          ...CLAIM_ATTEMPT_RESPONSE,
          claimUrl: `${ATTEMPT_CLAIM_URL}&mint=${attempts}`,
        },
        { status: 202 },
      );
    }
    if (pathname.endsWith("/exchange")) {
      // The server sweeps every leg the moment it is used.
      return Response.json({ error: "attempt expired" }, { status: 410 });
    }
    throw new Error(`unexpected request: ${pathname}`);
  };

  try {
    await withTimeout(
      waitForPreviewAndClaim(
        "https://api.layers.test",
        new AbortController().signal,
        reservationExpiresAt,
        (event) => events.push(event),
      ),
      "capped re-arm",
      90_000,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  // A leg that never completed one pending exchange was never usable by anybody,
  // so this stops at the DEAD-LEG limit and blames the server, not the human.
  assert.equal(attempts, 2, "a server refusing every leg stops early");
  const stillOpen = events.filter(
    (event) => event.type === "status" && event.stage === "claim_still_open",
  );
  assert.equal(stillOpen.length, 1);
  assert.match(stillOpen[0].message, /withdrew every claim link/u);
  assert.equal(
    /without being opened/u.test(stillOpen[0].message),
    false,
    "a link nobody could open must not be reported as one nobody opened",
  );
  // And a link that was never live is not announced as "refreshed".
  assert.equal(
    events.some(
      (event) =>
        event.type === "status" && event.stage === "claim_link_refreshed",
    ),
    false,
  );
  const terminal = events.filter((event) => event.type === "complete");
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].state, "awaiting_claim");
});

test("claimed progress gets its final exchange after the local deadline", async () => {
  const reservationExpiresAt = "2100-08-14T01:00:00.000Z";
  rememberLauncherReservation(reservationExpiresAt);
  const originalFetch = globalThis.fetch;
  const events = [];
  let exchangeRequests = 0;
  let postclaimRequests = 0;
  const claimedProgress = OnboardAgentProgressResponseSchema.parse({
    ...PROGRESS_RESPONSE,
    state: "claimed",
    stageLabel: "Workspace claimed",
    completedMilestones: [
      ...PROGRESS_RESPONSE.completedMilestones,
      "claimed",
    ],
  });

  globalThis.fetch = async (input) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname.endsWith("/progress")) {
      return Response.json(claimedProgress, { status: 200 });
    }
    if (pathname.endsWith("/claim-attempts")) {
      return Response.json(
        { ...CLAIM_ATTEMPT_RESPONSE, expiresAt: "2000-01-01T00:00:00.000Z" },
        { status: 202 },
      );
    }
    if (pathname.endsWith("/exchange")) {
      exchangeRequests += 1;
      return Response.json(CLAIMED_EXCHANGE_RESPONSE, { status: 200 });
    }
    if (pathname.endsWith("/postclaim")) {
      postclaimRequests += 1;
      return Response.json(POSTCLAIM_RESPONSE, { status: 200 });
    }
    throw new Error(`unexpected request: ${pathname}`);
  };

  try {
    await waitForPreviewAndClaim(
      "https://api.layers.test",
      new AbortController().signal,
      reservationExpiresAt,
      (event) => events.push(event),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  const safeProgressIndex = events.findIndex(
    (event) =>
      event.type === "progress" &&
      event.progress.claimUrl === ATTEMPT_CLAIM_URL,
  );
  const completionIndex = events.findIndex(
    (event) => event.type === "complete" && event.state === "claimed",
  );
  assert.ok(safeProgressIndex >= 0);
  assert.ok(completionIndex > safeProgressIndex);
  assert.deepEqual(events[completionIndex].postclaim, POSTCLAIM_RESPONSE);
  assert.equal(exchangeRequests, 1);
  assert.equal(postclaimRequests, 1);
});

test("claim setup exhaustion fails without claiming a handoff was exposed", async () => {
  const reservationExpiresAt = new Date(Date.now() + 1_000).toISOString();
  rememberLauncherReservation(reservationExpiresAt);
  const originalFetch = globalThis.fetch;
  const events = [];
  let claimAttemptRequests = 0;

  globalThis.fetch = async (input) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname.endsWith("/progress")) {
      return Response.json(PROGRESS_RESPONSE, { status: 200 });
    }
    if (pathname.endsWith("/claim-attempts")) {
      claimAttemptRequests += 1;
      return Response.json(
        { error: "claim setup is busy" },
        { status: 429, headers: { "retry-after": "0" } },
      );
    }
    throw new Error(`unexpected request: ${pathname}`);
  };

  try {
    await assert.rejects(
      waitForPreviewAndClaim(
        "https://api.layers.test",
        new AbortController().signal,
        reservationExpiresAt,
        (event) => events.push(event),
      ),
      (error) => error?.status === 429 && error?.retryable === true,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.ok(claimAttemptRequests >= 1);
  assert.equal(
    events.some((event) => event.type === "complete"),
    false,
  );
});

/**
 * WHAT A TERMINAL SERVER FAILURE SAYS.
 *
 * `Layers onboarding failed` gives a person nothing to act on and support
 * nothing to look up. The three facts always available are the trial handle,
 * the last state this process actually read, and the server's own failure code
 * when the projection carries one. An absent reason is reported as an absence
 * rather than papered over with a guess.
 */
function terminalProgress(state, failure) {
  return OnboardAgentProgressResponseSchema.parse({
    ...PROGRESS_RESPONSE,
    state,
    stageLabel: "Onboarding ended",
    previewReady: false,
    previewUrl: null,
    claimReady: false,
    claimUrl: null,
    failure,
  });
}

async function progressFailureMessage(progress) {
  const reservationExpiresAt = new Date(Date.now() + 60_000).toISOString();
  rememberLauncherReservation(reservationExpiresAt);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname.endsWith("/progress")) {
      return Response.json(progress, { status: 200 });
    }
    throw new Error(`unexpected request: ${pathname}`);
  };
  try {
    await waitForPreviewAndClaim(
      "https://api.layers.test",
      new AbortController().signal,
      reservationExpiresAt,
      () => {},
    );
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    globalThis.fetch = originalFetch;
  }
  return assert.fail("a failed progress projection must end the wait");
}

/**
 * THE 15-MINUTE EXIT. 1.3.0 clamped its whole claim wait down to the server's
 * transport-attempt expiry, so a link minted at 16:53 ended the session at 17:07
 * reporting `awaiting_claim` — while the trial stayed claimable for the rest of
 * the reservation and the human had simply not clicked yet.
 */
test("an expired transport attempt is re-armed instead of ending the wait", async () => {
  const reservationExpiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
  rememberLauncherReservation(reservationExpiresAt);
  const originalFetch = globalThis.fetch;
  const events = [];
  const mintedClaimUrls = [];
  let attempts = 0;
  let exchanges = 0;

  globalThis.fetch = async (input) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname.endsWith("/progress")) {
      return Response.json(PROGRESS_RESPONSE, { status: 200 });
    }
    if (pathname.endsWith("/claim-attempts")) {
      attempts += 1;
      const claimUrl = `${ATTEMPT_CLAIM_URL}&mint=${attempts}`;
      mintedClaimUrls.push(claimUrl);
      return Response.json(
        {
          protocolVersion: 1,
          trialHandle: TRIAL_HANDLE,
          attemptHandle: ATTEMPT_HANDLE,
          claimUrl,
          // The first attempt is already dead, exactly as a 15-minute leg is by
          // the time a person gets back to their terminal.
          expiresAt:
            attempts === 1
              ? new Date(Date.now() + 40).toISOString()
              : ATTEMPT_EXPIRES_AT,
          state: "pending",
        },
        { status: 202 },
      );
    }
    if (pathname.endsWith("/exchange")) {
      exchanges += 1;
      // The second attempt is the one the human finally opens.
      if (attempts >= 2) {
        return Response.json(CLAIMED_EXCHANGE_RESPONSE, { status: 200 });
      }
      return Response.json(PENDING_EXCHANGE_RESPONSE, { status: 202 });
    }
    if (pathname.endsWith("/postclaim")) {
      return Response.json(POSTCLAIM_RESPONSE, { status: 200 });
    }
    throw new Error(`unexpected request: ${pathname}`);
  };

  try {
    await withTimeout(
      waitForPreviewAndClaim(
        "https://api.layers.test",
        new AbortController().signal,
        reservationExpiresAt,
        (event) => events.push(event),
      ),
      "re-armed claim handoff",
      60_000,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(attempts, 2, "the expired attempt was replaced, not accepted");
  assert.ok(exchanges >= 1);

  // The wait ended on the claim, never on the transport leg.
  const terminal = events.filter((event) => event.type === "complete");
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].state, "claimed");
  assert.equal(terminal[0].previewUrl, PREVIEW_URL);

  // A replaced link must be announced, and the new URL published.
  const refreshed = events.filter(
    (event) => event.type === "status" && event.stage === "claim_link_refreshed",
  );
  assert.equal(refreshed.length, 1);
  const publishedClaimUrls = events
    .filter((event) => event.type === "progress")
    .map((event) => event.progress.claimUrl)
    .filter(Boolean);
  assert.equal(
    publishedClaimUrls.includes(mintedClaimUrls[1]),
    true,
    "the fresh claim link reached the agent",
  );
  // The portable trial-wide claim URL is still never exposed.
  assert.equal(
    events.some((event) => JSON.stringify(event).includes(LEGACY_CLAIM_TOKEN)),
    false,
  );
});

test("stopping the wait says the workspace is still claimable", async () => {
  // The wait is bounded by the reservation, so a reservation seconds from
  // expiry is the cheap way to reach the stop path.
  const reservationExpiresAt = new Date(Date.now() + 1_500).toISOString();
  rememberLauncherReservation(reservationExpiresAt);
  const originalFetch = globalThis.fetch;
  const events = [];

  globalThis.fetch = async (input) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname.endsWith("/progress")) {
      return Response.json(PROGRESS_RESPONSE, { status: 200 });
    }
    if (pathname.endsWith("/claim-attempts")) {
      return Response.json(
        {
          protocolVersion: 1,
          trialHandle: TRIAL_HANDLE,
          attemptHandle: ATTEMPT_HANDLE,
          claimUrl: ATTEMPT_CLAIM_URL,
          expiresAt: ATTEMPT_EXPIRES_AT,
          state: "pending",
        },
        { status: 202 },
      );
    }
    if (pathname.endsWith("/exchange")) {
      return Response.json(PENDING_EXCHANGE_RESPONSE, { status: 202 });
    }
    throw new Error(`unexpected request: ${pathname}`);
  };

  try {
    await withTimeout(
      waitForPreviewAndClaim(
        "https://api.layers.test",
        new AbortController().signal,
        reservationExpiresAt,
        (event) => events.push(event),
      ),
      "bounded claim wait",
      60_000,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  const stillOpen = events.filter(
    (event) => event.type === "status" && event.stage === "claim_still_open",
  );
  assert.equal(stillOpen.length, 1, "stopping must not be reported as expiring");
  assert.match(stillOpen[0].message, /still claimable until/u);
  assert.match(stillOpen[0].message, /nothing was cancelled/u);

  // The explanation precedes the terminal event, so an agent reading in order
  // has the reason before it has the verdict.
  const terminal = events.filter((event) => event.type === "complete");
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].state, "awaiting_claim");
  assert.ok(events.indexOf(stillOpen[0]) < events.indexOf(terminal[0]));
});

/**
 * A claim mock whose attempt the server has already swept.
 *
 * The exchange answers 410 for a swept attempt, and a clock a few seconds out
 * puts the launcher there before its own `attemptExpired()` is true. 1.3.0 —
 * and 1.3.1 before this fix — turned that into a dead run.
 */
test("a non-retryable exchange failure on a dead leg re-arms instead of ending the wait", async () => {
  const reservationExpiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
  rememberLauncherReservation(reservationExpiresAt);
  const originalFetch = globalThis.fetch;
  const events = [];
  let attempts = 0;
  let exchanges = 0;

  globalThis.fetch = async (input) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname.endsWith("/progress")) {
      return Response.json(PROGRESS_RESPONSE, { status: 200 });
    }
    if (pathname.endsWith("/claim-attempts")) {
      attempts += 1;
      return Response.json(
        {
          protocolVersion: 1,
          trialHandle: TRIAL_HANDLE,
          attemptHandle: ATTEMPT_HANDLE,
          claimUrl: `${ATTEMPT_CLAIM_URL}&mint=${attempts}`,
          // Server says the leg is alive for a while; the server then refuses
          // it anyway, which is the skew case this test exists for.
          expiresAt: ATTEMPT_EXPIRES_AT,
          state: "pending",
        },
        { status: 202 },
      );
    }
    if (pathname.endsWith("/exchange")) {
      exchanges += 1;
      if (attempts >= 2) {
        return Response.json(CLAIMED_EXCHANGE_RESPONSE, { status: 200 });
      }
      // The leg answers once (so it was demonstrably live), then the server
      // sweeps it. A sweep believed only after the leg proved it existed is the
      // narrowed signal: a 404 milliseconds after a mint is read-after-write
      // lag, not a sweep.
      if (exchanges === 1) {
        return Response.json(PENDING_EXCHANGE_RESPONSE, { status: 202 });
      }
      return Response.json({ error: "attempt expired" }, { status: 410 });
    }
    if (pathname.endsWith("/postclaim")) {
      return Response.json(POSTCLAIM_RESPONSE, { status: 200 });
    }
    throw new Error(`unexpected request: ${pathname}`);
  };

  try {
    await withTimeout(
      waitForPreviewAndClaim(
        "https://api.layers.test",
        new AbortController().signal,
        reservationExpiresAt,
        (event) => events.push(event),
      ),
      "re-armed claim handoff after a refused exchange",
      60_000,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(attempts, 2, "the refused leg was replaced");
  assert.ok(exchanges >= 2);
  const terminal = events.filter((event) => event.type === "complete");
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].state, "claimed");
});

test("an exchange state this version does not know retires the leg", async () => {
  const reservationExpiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
  rememberLauncherReservation(reservationExpiresAt);
  const originalFetch = globalThis.fetch;
  const events = [];
  let attempts = 0;

  globalThis.fetch = async (input) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname.endsWith("/progress")) {
      return Response.json(PROGRESS_RESPONSE, { status: 200 });
    }
    if (pathname.endsWith("/claim-attempts")) {
      attempts += 1;
      return Response.json(
        {
          protocolVersion: 1,
          trialHandle: TRIAL_HANDLE,
          attemptHandle: ATTEMPT_HANDLE,
          claimUrl: `${ATTEMPT_CLAIM_URL}&mint=${attempts}`,
          expiresAt: ATTEMPT_EXPIRES_AT,
          state: "pending",
        },
        { status: 202 },
      );
    }
    if (pathname.endsWith("/exchange")) {
      if (attempts >= 2) {
        return Response.json(CLAIMED_EXCHANGE_RESPONSE, { status: 200 });
      }
      // A 200 carrying a state neither `pending` nor `claimed`. Whatever it
      // means, it is not success and its expiry is unreadable.
      return Response.json(
        {
          protocolVersion: 1,
          trialHandle: TRIAL_HANDLE,
          attemptHandle: ATTEMPT_HANDLE,
          state: "quarantined",
        },
        { status: 200 },
      );
    }
    if (pathname.endsWith("/postclaim")) {
      return Response.json(POSTCLAIM_RESPONSE, { status: 200 });
    }
    if (pathname.endsWith("/postclaim")) {
      return Response.json(POSTCLAIM_RESPONSE, { status: 200 });
    }
    throw new Error(`unexpected request: ${pathname}`);
  };

  try {
    await withTimeout(
      waitForPreviewAndClaim(
        "https://api.layers.test",
        new AbortController().signal,
        reservationExpiresAt,
        (event) => events.push(event),
      ),
      "unknown exchange state",
      60_000,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(attempts, 2);
  const terminal = events.filter((event) => event.type === "complete");
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].state, "claimed");
});

test("an interrupt mid-wait still reports the workspace as claimable", async () => {
  const reservationExpiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
  rememberLauncherReservation(reservationExpiresAt);
  const originalFetch = globalThis.fetch;
  const events = [];
  const controller = new AbortController();

  globalThis.fetch = async (input) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname.endsWith("/progress")) {
      return Response.json(PROGRESS_RESPONSE, { status: 200 });
    }
    if (pathname.endsWith("/claim-attempts")) {
      return Response.json(
        {
          protocolVersion: 1,
          trialHandle: TRIAL_HANDLE,
          attemptHandle: ATTEMPT_HANDLE,
          claimUrl: ATTEMPT_CLAIM_URL,
          expiresAt: ATTEMPT_EXPIRES_AT,
          state: "pending",
        },
        { status: 202 },
      );
    }
    if (pathname.endsWith("/exchange")) {
      // The human hits Ctrl-C while the launcher sits in its poll sleep.
      queueMicrotask(() => controller.abort());
      return Response.json(PENDING_EXCHANGE_RESPONSE, { status: 202 });
    }
    throw new Error(`unexpected request: ${pathname}`);
  };

  try {
    await assert.rejects(
      withTimeout(
        waitForPreviewAndClaim(
          "https://api.layers.test",
          controller.signal,
          reservationExpiresAt,
          (event) => events.push(event),
        ),
        "interrupted claim wait",
        60_000,
      ),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  // The abort still propagates; what changed is that it no longer leaves the
  // agent with an empty stream and no way to tell cancellation from expiry.
  const stillOpen = events.filter(
    (event) => event.type === "status" && event.stage === "claim_still_open",
  );
  assert.equal(stillOpen.length, 1);
  assert.match(stillOpen[0].message, /interrupted before the claim completed/u);
  assert.match(stillOpen[0].message, /still claimable until/u);
  const terminal = events.filter((event) => event.type === "complete");
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].state, "awaiting_claim");
});

test("claim setup honors Retry-After and says it is retrying", async () => {
  const reservationExpiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
  rememberLauncherReservation(reservationExpiresAt);
  const originalFetch = globalThis.fetch;
  const events = [];
  let setupCalls = 0;

  globalThis.fetch = async (input) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname.endsWith("/progress")) {
      return Response.json(PROGRESS_RESPONSE, { status: 200 });
    }
    if (pathname.endsWith("/claim-attempts")) {
      setupCalls += 1;
      if (setupCalls <= 2) {
        return Response.json(
          { error: "claim setup is busy" },
          { status: 429, headers: { "retry-after": "0" } },
        );
      }
      return Response.json(
        {
          protocolVersion: 1,
          trialHandle: TRIAL_HANDLE,
          attemptHandle: ATTEMPT_HANDLE,
          claimUrl: ATTEMPT_CLAIM_URL,
          expiresAt: ATTEMPT_EXPIRES_AT,
          state: "pending",
        },
        { status: 202 },
      );
    }
    if (pathname.endsWith("/exchange")) {
      return Response.json(CLAIMED_EXCHANGE_RESPONSE, { status: 200 });
    }
    if (pathname.endsWith("/postclaim")) {
      return Response.json(POSTCLAIM_RESPONSE, { status: 200 });
    }
    throw new Error(`unexpected request: ${pathname}`);
  };

  try {
    await withTimeout(
      waitForPreviewAndClaim(
        "https://api.layers.test",
        new AbortController().signal,
        reservationExpiresAt,
        (event) => events.push(event),
      ),
      "claim setup retry",
      60_000,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  // The backoff used to be silent, which is indistinguishable from a hang to
  // whatever is polling this process.
  const retrying = events.filter(
    (event) => event.type === "status" && event.stage === "claim_setup_retrying",
  );
  assert.ok(retrying.length >= 1, "the retry announced itself");
  assert.match(retrying[0].message, /retrying in \d+s/u);
  assert.match(retrying[0].message, /nothing needs restarting/u);
  const terminal = events.filter((event) => event.type === "complete");
  assert.equal(terminal[0].state, "claimed");
});

test("a progress projection with unknown fields and states does not brick the wait", async () => {
  // The pinned canonical schema is `.strict()` with an enumerated `state`, so
  // this exact payload fails it. The launcher polls this route every few
  // seconds for hours; a server-added field must not end somebody's claim.
  const reservationExpiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
  rememberLauncherReservation(reservationExpiresAt);
  const originalFetch = globalThis.fetch;
  const events = [];
  let polls = 0;

  globalThis.fetch = async (input) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname.endsWith("/progress")) {
      polls += 1;
      return Response.json(
        {
          ...PROGRESS_RESPONSE,
          state: polls === 1 ? "reticulating_splines" : "awaiting_claim",
          brandNewServerField: { shape: "nobody here has seen" },
          groundedPlayback: [
            { fact: "layers_sdk_presence", value: "present", extra: "future" },
          ],
        },
        { status: 200 },
      );
    }
    if (pathname.endsWith("/claim-attempts")) {
      return Response.json(
        {
          protocolVersion: 1,
          trialHandle: TRIAL_HANDLE,
          attemptHandle: ATTEMPT_HANDLE,
          claimUrl: ATTEMPT_CLAIM_URL,
          expiresAt: ATTEMPT_EXPIRES_AT,
          state: "pending",
        },
        { status: 202 },
      );
    }
    if (pathname.endsWith("/exchange")) {
      return Response.json(CLAIMED_EXCHANGE_RESPONSE, { status: 200 });
    }
    if (pathname.endsWith("/postclaim")) {
      return Response.json(POSTCLAIM_RESPONSE, { status: 200 });
    }
    throw new Error(`unexpected request: ${pathname}`);
  };

  try {
    await withTimeout(
      waitForPreviewAndClaim(
        "https://api.layers.test",
        new AbortController().signal,
        reservationExpiresAt,
        (event) => events.push(event),
      ),
      "tolerant progress read",
      60_000,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  const terminal = events.filter((event) => event.type === "complete");
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].state, "claimed");

  // TOLERANT TO READ, NOT TOLERANT TO ECHO. The unknown field must not fail the
  // poll, and must not reach the transcript either.
  const progressEvents = events.filter((event) => event.type === "progress");
  assert.ok(progressEvents.length >= 1);
  for (const event of progressEvents) {
    assert.equal(
      "brandNewServerField" in event.progress,
      false,
      "an unreviewed server field must not be echoed to the agent",
    );
  }
  // groundedPlayback ELEMENTS are the deliberate exception: the agent reads
  // grounded facts out of them, so a future fact shape has to survive.
  assert.deepEqual(progressEvents[0].progress.groundedPlayback, [
    { fact: "layers_sdk_presence", value: "present", extra: "future" },
  ]);
  // The fields the launcher does relay are still there.
  assert.equal(typeof progressEvents[0].progress.stageLabel, "string");
  assert.ok(Array.isArray(progressEvents[0].progress.completedMilestones));
});

test("a young 404 is retried on the same leg rather than believed as a sweep", async () => {
  // READ-AFTER-WRITE LAG LOOKS EXACTLY LIKE A SWEEP. A 404 milliseconds after a
  // mint is far more likely a lagging replica than the server withdrawing the
  // attempt, so believing it would turn replica timing into a mint storm — and
  // throwing on it would kill a perfectly good claim.
  const reservationExpiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
  rememberLauncherReservation(reservationExpiresAt);
  const originalFetch = globalThis.fetch;
  const events = [];
  let attempts = 0;
  let exchanges = 0;

  globalThis.fetch = async (input) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname.endsWith("/progress")) {
      return Response.json(PROGRESS_RESPONSE, { status: 200 });
    }
    if (pathname.endsWith("/claim-attempts")) {
      attempts += 1;
      return Response.json(CLAIM_ATTEMPT_RESPONSE, { status: 202 });
    }
    if (pathname.endsWith("/exchange")) {
      exchanges += 1;
      // The lag clears on the second look.
      if (exchanges === 1) {
        return Response.json({ error: "not found" }, { status: 404 });
      }
      return Response.json(CLAIMED_EXCHANGE_RESPONSE, { status: 200 });
    }
    if (pathname.endsWith("/postclaim")) {
      return Response.json(POSTCLAIM_RESPONSE, { status: 200 });
    }
    throw new Error(`unexpected request: ${pathname}`);
  };

  try {
    await withTimeout(
      waitForPreviewAndClaim(
        "https://api.layers.test",
        new AbortController().signal,
        reservationExpiresAt,
        (event) => events.push(event),
      ),
      "young 404 retried",
      60_000,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(attempts, 1, "the leg was kept, not replaced");
  assert.equal(exchanges, 2, "the same leg was asked again");
  const terminal = events.filter((event) => event.type === "complete");
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].state, "claimed");
});

test("a claim link that arrives already long expired stops with an honest reason", async () => {
  // Under the skew tolerance this is two clocks disagreeing. Well over it, the
  // server really is issuing dead links, and minting six more buys nothing but
  // a worse diagnosis.
  const reservationExpiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
  rememberLauncherReservation(reservationExpiresAt);
  const originalFetch = globalThis.fetch;
  const events = [];
  let attempts = 0;

  globalThis.fetch = async (input) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname.endsWith("/progress")) {
      return Response.json(PROGRESS_RESPONSE, { status: 200 });
    }
    if (pathname.endsWith("/claim-attempts")) {
      attempts += 1;
      return Response.json(
        { ...CLAIM_ATTEMPT_RESPONSE, expiresAt: "2000-01-01T00:00:00.000Z" },
        { status: 202 },
      );
    }
    throw new Error(`unexpected request: ${pathname}`);
  };

  try {
    await withTimeout(
      waitForPreviewAndClaim(
        "https://api.layers.test",
        new AbortController().signal,
        reservationExpiresAt,
        (event) => events.push(event),
      ),
      "born-dead claim link",
      60_000,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(attempts, 1, "one dead link is enough to conclude");
  const stillOpen = events.filter(
    (event) => event.type === "status" && event.stage === "claim_still_open",
  );
  assert.equal(stillOpen.length, 1);
  assert.match(stillOpen[0].message, /had already expired when it arrived/u);
  assert.match(stillOpen[0].message, /more than clock differences explain/u);
  const terminal = events.filter((event) => event.type === "complete");
  assert.equal(terminal[0].state, "awaiting_claim");
});

test("a 409 on claim setup waits for the old leg instead of ending the run", async () => {
  // `claim-continuity.ts` answers 409 `active_attempt` while the previous
  // attempt has not been swept — exactly what a local retire ahead of the
  // server's clock produces. It is not retryable, and it used to kill the run.
  const reservationExpiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
  rememberLauncherReservation(reservationExpiresAt);
  const originalFetch = globalThis.fetch;
  const events = [];
  let setupCalls = 0;

  globalThis.fetch = async (input) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname.endsWith("/progress")) {
      return Response.json(PROGRESS_RESPONSE, { status: 200 });
    }
    if (pathname.endsWith("/claim-attempts")) {
      setupCalls += 1;
      if (setupCalls === 1) {
        return Response.json(
          { error: "A claim attempt is already active for this trial." },
          { status: 409 },
        );
      }
      return Response.json(CLAIM_ATTEMPT_RESPONSE, { status: 202 });
    }
    if (pathname.endsWith("/exchange")) {
      return Response.json(CLAIMED_EXCHANGE_RESPONSE, { status: 200 });
    }
    if (pathname.endsWith("/postclaim")) {
      return Response.json(POSTCLAIM_RESPONSE, { status: 200 });
    }
    throw new Error(`unexpected request: ${pathname}`);
  };

  try {
    await withTimeout(
      waitForPreviewAndClaim(
        "https://api.layers.test",
        new AbortController().signal,
        reservationExpiresAt,
        (event) => events.push(event),
      ),
      "409 on claim setup",
      60_000,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(setupCalls, 2, "the setup was asked again after the 409");
  const retrying = events.filter(
    (event) => event.type === "status" && event.stage === "claim_setup_retrying",
  );
  assert.ok(retrying.length >= 1);
  assert.match(retrying[0].message, /still holds the previous claim link open/u);
  const terminal = events.filter((event) => event.type === "complete");
  assert.equal(terminal[0].state, "claimed");
});

test("a terminal failure names the trial, the last state, and the server's code", async () => {
  const message = await progressFailureMessage(
    terminalProgress("failed", {
      retryable: false,
      supportCode: "ONBOARD_ANALYSIS_FAILED",
      retryOperation: "Start onboarding again from the repository root.",
    }),
  );
  assert.match(message, /Layers onboarding failed\./u);
  assert.match(message, new RegExp(`Trial handle: ${TRIAL_HANDLE}\\.`, "u"));
  assert.match(message, /Last progress state: failed\./u);
  assert.match(message, /Server failure code: ONBOARD_ANALYSIS_FAILED\./u);
  assert.equal(message.includes(RESERVATION_CAPABILITY), false);
});

test("a terminal end with no server reason says so rather than guessing", async () => {
  // `failed` always carries failure details (the projection refuses otherwise),
  // so the reason-less terminal state this branch exists for is `expired`.
  const message = await progressFailureMessage(
    terminalProgress("expired", null),
  );
  assert.match(message, /Layers onboarding expired\./u);
  assert.match(message, new RegExp(`Trial handle: ${TRIAL_HANDLE}\\.`, "u"));
  assert.match(message, /Last progress state: expired\./u);
  assert.match(message, /Server reported no reason\./u);
  assert.equal(/Server failure code/u.test(message), false);
});

test("needs_clarification ends the wait with the same named facts", async () => {
  const message = await progressFailureMessage(
    terminalProgress("needs_clarification", null),
  );
  assert.match(message, /needs clarification before this session can continue\./u);
  assert.match(message, new RegExp(`Trial handle: ${TRIAL_HANDLE}\\.`, "u"));
  assert.match(message, /Last progress state: needs_clarification\./u);
  assert.match(message, /Server reported no reason\./u);
});
