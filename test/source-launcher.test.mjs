import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { promisify } from "node:util";

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

import { waitForPreviewAndClaim } from "../dist/onboarding/launcher.js";
import { rememberReservation } from "../dist/onboarding/session.js";
import { SERVER } from "./helpers.mjs";

const execFileAsync = promisify(execFile);
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
  expiresAt: "2100-08-14T01:00:00.000Z",
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

async function createMockApi(temporaryRoot) {
  const requests = [];
  const unexpectedRequests = [];
  let exchangeCount = 0;
  let claimAttemptCount = 0;

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
        respondJson(response, 202, START_RESPONSE);
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

function spawnLauncher(workspace, baseUrl, temporaryRoot) {
  const env = {
    ...process.env,
    LAYERS_ONBOARD_INTERNAL_PROBE_TOKEN: INTERNAL_PROBE_TOKEN,
    TMPDIR: temporaryRoot,
    TMP: temporaryRoot,
    TEMP: temporaryRoot,
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
    [SERVER, "onboard", "--base-url", baseUrl],
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
      });
      assert.deepEqual(await withTimeout(run.exit, "launcher exit"), {
        code: 0,
        signal: null,
      });

      assert.deepEqual(api.unexpectedRequests, []);
      assert.equal(api.exchangeCount, 2);

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
  const reservationExpiresAt = "2100-08-14T01:00:00.000Z";
  rememberLauncherReservation(reservationExpiresAt);
  const originalFetch = globalThis.fetch;
  const events = [];
  let exchangeRequests = 0;

  globalThis.fetch = async (input) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname.endsWith("/progress")) {
      return Response.json(PROGRESS_RESPONSE, { status: 200 });
    }
    if (pathname.endsWith("/claim-attempts")) {
      return Response.json(
        { ...CLAIM_ATTEMPT_RESPONSE, expiresAt: "2000-01-01T00:00:00.000Z" },
        { status: 202 },
      );
    }
    exchangeRequests += 1;
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
    (event) =>
      event.type === "complete" && event.state === "awaiting_claim",
  );
  assert.ok(safeProgressIndex >= 0);
  assert.ok(completionIndex > safeProgressIndex);
  assert.equal(events[completionIndex].previewUrl, PREVIEW_URL);
  assert.equal(events[completionIndex].postclaim, null);
  assert.equal(exchangeRequests, 0);
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
