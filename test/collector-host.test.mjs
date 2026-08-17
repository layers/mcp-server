import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  ONBOARDING_COLLECTION_POLICY,
  ONBOARDING_COLLECTOR_TARGETS,
  OnboardingCollectorIntegritySchema,
  OnboardingPreparedCodebaseArtifactSchema,
  OnboardingSourceInspectionSchema,
} from "@layers/onboarding-contracts";

import {
  collectorResolutionError,
  openOnboardingCollector,
} from "../dist/onboarding/collector-host.js";

const require = createRequire(import.meta.url);
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// The contracts package and the six collector packages ship as one versioned
// artifact set, so one constant covers both here exactly as it does upstream.
const COLLECTOR_VERSION = "0.1.5";
const CONTRACT_MANIFEST_SHA256 =
  "a8139e2110716f59a2d2f13719e3f0d0da11a65d36970531b2f306c7b3e89127";
const COLLECTION_POLICY_SHA256 =
  "d35170d24c54f0dfad57cce99bfeaf69ca05d779c4e422a1fa5636680c2127b6";
const STAGE_PREFIX = "layers-onboarding-collector-";
const EXCLUDED_SECRET_SENTINEL = "collector-secret-must-never-cross";

const EXPECTED_BINARIES = {
  "@layers/onboarding-collector-darwin-arm64": {
    bytes: 5_753_330,
    sha256: "be8add935d55cc5c0aed6c198fd4aae8cff90e0bc9788d868686a066334e3d50",
  },
  "@layers/onboarding-collector-darwin-x64": {
    bytes: 5_907_456,
    sha256: "1fb1ec90036966d8611552172538b3dc02663ac43a8d47fd51e1c82d3d895139",
  },
  "@layers/onboarding-collector-linux-arm64": {
    bytes: 5_771_488,
    sha256: "e6a2d085e0b2c3cb3c33fb1e11302a09270bf2c3b35f01f9cfac85385df60b23",
  },
  "@layers/onboarding-collector-linux-x64": {
    bytes: 5_952_500,
    sha256: "ed2bb914cdc6487ef752d2974e4cf826ed40b67d3075b3627b46a783d622e42d",
  },
  "@layers/onboarding-collector-win32-arm64": {
    bytes: 5_974_016,
    sha256: "d8511c7d08bfa6c6353fd16f8be03835bfaba91732d06ce168fae2d0f3d8be41",
  },
  "@layers/onboarding-collector-win32-x64": {
    bytes: 6_262_272,
    sha256: "420d9e1030249a45438b2ee0715455cbff9ee319792c12f5b70a4e082d6a7fa7",
  },
};

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function currentTarget() {
  const target = ONBOARDING_COLLECTOR_TARGETS.find(
    (candidate) =>
      candidate.platform === process.platform && candidate.arch === process.arch,
  );
  assert.ok(target, `missing collector target for ${process.platform}/${process.arch}`);
  return target;
}

async function stageDirectories(root) {
  return (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(STAGE_PREFIX))
    .map((entry) => join(root, entry.name))
    .sort();
}

async function waitForStageCleanup(root) {
  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline) {
    if ((await stageDirectories(root)).length === 0) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  assert.deepEqual(await stageDirectories(root), []);
}

function suspendEventLoopUntilAfter(deadlineAtMs) {
  const remainingMs = Math.max(0, deadlineAtMs - Date.now() + 5);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, remainingMs);
  assert.ok(Date.now() >= deadlineAtMs);
}

async function createWorkspace(root) {
  const workspace = join(root, "workspace");
  await mkdir(workspace, { mode: 0o755 });
  await mkdir(join(workspace, "src"), { mode: 0o755 });
  await writeFile(
    join(workspace, "package.json"),
    `${JSON.stringify(
      {
        name: "collector-host-fixture",
        version: "1.0.0",
        private: true,
        description: "A deterministic product fixture for collector host tests.",
        scripts: { start: "node src/index.js" },
        dependencies: { react: "19.1.1" },
      },
      null,
      2,
    )}\n`,
    { mode: 0o644 },
  );
  await writeFile(
    join(workspace, "README.md"),
    "# Collector Host Fixture\n",
    { mode: 0o644 },
  );
  await writeFile(join(workspace, "src", "index.js"), "export {};\n", {
    mode: 0o644,
  });
  await writeFile(
    join(workspace, ".env"),
    `PRIVATE_KEY=${EXCLUDED_SECRET_SENTINEL}\n`,
    { mode: 0o644 },
  );
  return workspace;
}

async function inspectReady(session, workspace) {
  let response = await session.inspect({ root: workspace });
  if (response.projection.status === "needs_product_selection") {
    const candidate =
      response.projection.candidates.find((item) => item.recommended) ??
      response.projection.candidates[0];
    assert.ok(candidate, "collector requested a selection without candidates");
    response = await session.select(candidate.candidateId);
  }
  const projection = OnboardingSourceInspectionSchema.parse(response.projection);
  assert.equal(projection.status, "ready");
  assert.equal(JSON.stringify(projection).includes(EXCLUDED_SECRET_SENTINEL), false);
  return projection;
}

function assertPreparedPairsWithProjection(preparedValue, projection) {
  const prepared = OnboardingPreparedCodebaseArtifactSchema.parse(preparedValue);
  assert.equal(
    prepared.sourceIdentity.repositoryContentHash,
    projection.repositoryContentHash,
  );
  assert.equal(prepared.productSelection.candidateId, projection.selectedCandidateId);
  assert.deepEqual(
    [...prepared.candidateSetIds].sort(),
    projection.candidates.map((candidate) => candidate.candidateId).sort(),
  );
  assert.deepEqual(prepared.consentPathItems, projection.consentPathItems);
  assert.equal(
    prepared.sanitizedStructuralFacts.collectionPolicyVersion,
    projection.collectionPolicyVersion,
  );
  assert.equal(
    prepared.sanitizedStructuralFacts.includedPathCount,
    projection.sanitizedStructuralFacts?.includedPathCount,
  );
  const includedPathIds = new Set(
    projection.consentPathItems
      .filter((item) => item.included)
      .map((item) => item.pathId),
  );
  for (const excerpt of prepared.transientExcerpts) {
    assert.ok(includedPathIds.has(excerpt.pathId));
    assert.equal(excerpt.byteCount, Buffer.byteLength(excerpt.content, "utf8"));
    assert.equal(excerpt.contentSha256, sha256(Buffer.from(excerpt.content, "utf8")));
  }
  assert.ok(prepared.transientExcerpts.length > 0);
  assert.equal(Object.hasOwn(projection, "transientExcerpts"), false);
  assert.equal(JSON.stringify(prepared).includes(EXCLUDED_SECRET_SENTINEL), false);
  return prepared;
}

function assertProtocolError(error) {
  assert.equal(error?.supportCode, "ONBOARD_COLLECTOR_PROTOCOL");
  return true;
}

function assertTimeoutError(error) {
  assert.equal(error?.supportCode, "ONBOARD_COLLECTOR_TIMEOUT");
  return true;
}

test("a missing platform package is not reported as an integrity failure", () => {
  // OPPOSITE REMEDIES. An integrity failure means what is on disk is not what
  // this launcher trusts, and the answer is to stop. A missing module means
  // nothing is on disk — almost always --omit=optional — and the answer is to
  // reinstall. Reporting both as "could not be verified" sent people hunting a
  // supply-chain problem they did not have.
  const missing = Object.assign(new Error("Cannot find module"), {
    code: "MODULE_NOT_FOUND",
  });
  const notInstalled = collectorResolutionError(
    missing,
    "@layers/onboarding-collector-linux-x64",
  );
  assert.equal(notInstalled.supportCode, "ONBOARD_COLLECTOR_NOT_INSTALLED");
  assert.match(notInstalled.message, /@layers\/onboarding-collector-linux-x64/u);
  assert.match(notInstalled.message, /omitted optional dependencies/u);
  assert.match(notInstalled.message, /Re-run with --include=optional/u);

  // Anything else resolving badly is still an integrity failure.
  const other = collectorResolutionError(
    new Error("EACCES: permission denied"),
    "@layers/onboarding-collector-linux-x64",
  );
  assert.equal(other.supportCode, "ONBOARD_COLLECTOR_INTEGRITY");

  // A REMEDY IS A PROMISE. Only faults a command actually fixes get one.
  assert.equal(
    notInstalled.remedyCommand,
    "npx --yes --include=optional @layers/mcp-server@1.3.1 onboard",
  );
  // IT MUST NOT WRITE TO THE USER'S REPO. This launcher writes only inside its
  // own mkdtemp; a remedy that edits package.json and the lockfile breaks that.
  assert.equal(/npm install/u.test(notInstalled.remedyCommand), false);
  // AND IT MUST RUN ON WINDOWS. `VAR=value cmd` is POSIX shell syntax that
  // cmd.exe and PowerShell do not understand; `--include=optional` is a plain
  // npm flag, which is why it replaced the env-var form.
  assert.equal(/^\w+=/u.test(notInstalled.remedyCommand), false);
  // The message has to say what the command does and what to do when a stale
  // npx cache means the flag alone is not enough.
  assert.match(notInstalled.message, /optional dependencies/u);
  assert.match(notInstalled.message, /npm cache clean --force/u);
  assert.equal(
    other.remedyCommand,
    undefined,
    "an integrity mismatch is not a try-again",
  );

  // The real resolver does produce MODULE_NOT_FOUND for a package that is not
  // installed, so the discriminator above is the one that actually fires.
  //
  // NOT a real platform package: which of the six is installed depends on the
  // machine, and naming `linux-x64` passed on a darwin laptop while failing on
  // a linux-x64 CI runner where that package is exactly the one present.
  assert.throws(
    () =>
      require.resolve(
        "@layers/onboarding-collector-nosucharch/package.json",
      ),
    (error) => error.code === "MODULE_NOT_FOUND",
  );
});

test("pins the exact installed contract and current-platform collector artifacts", async () => {
  const hostPackage = await readJson(join(PROJECT_ROOT, "package.json"));
  assert.equal(hostPackage.dependencies["@layers/onboarding-contracts"], COLLECTOR_VERSION);
  for (const target of ONBOARDING_COLLECTOR_TARGETS) {
    assert.equal(hostPackage.optionalDependencies[target.packageName], COLLECTOR_VERSION);
  }

  const contractDistRoot = dirname(
    require.resolve("@layers/onboarding-contracts"),
  );
  const contractRoot = resolve(contractDistRoot, "..");
  const contractPackagePath = join(contractRoot, "package.json");
  const contractPackage = await readJson(contractPackagePath);
  assert.deepEqual(
    {
      name: contractPackage.name,
      version: contractPackage.version,
      main: contractPackage.main,
      type: contractPackage.type,
      files: contractPackage.files,
      peerDependencies: contractPackage.peerDependencies,
    },
    {
      name: "@layers/onboarding-contracts",
      version: COLLECTOR_VERSION,
      main: "./dist/index.js",
      type: "module",
      files: ["dist", "README.md"],
      peerDependencies: { zod: ">=4.1.8 <5" },
    },
  );

  const manifestPath = require.resolve("@layers/onboarding-contracts/manifest.json");
  const policyPath = require.resolve(
    "@layers/onboarding-contracts/collection-policy-v1.json",
  );
  const [manifestBytes, policyBytes] = await Promise.all([
    readFile(manifestPath),
    readFile(policyPath),
  ]);
  assert.equal(sha256(manifestBytes), CONTRACT_MANIFEST_SHA256);
  assert.equal(sha256(policyBytes), COLLECTION_POLICY_SHA256);

  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  assert.deepEqual(
    {
      artifactName: manifest.artifactName,
      artifactVersion: manifest.artifactVersion,
      hashEncoding: manifest.hashEncoding,
      protocolVersion: manifest.protocolVersion,
      collectorProtocolVersion: manifest.collectorProtocolVersion,
      sourceInspectionSchemaVersion: manifest.sourceInspectionSchemaVersion,
      codebaseDigestSchemaVersion: manifest.codebaseDigestSchemaVersion,
      evidenceSchemaVersion: manifest.evidenceSchemaVersion,
      collectionPolicyVersion: manifest.collectionPolicyVersion,
      collectionPolicySha256: manifest.collectionPolicySha256,
    },
    {
      artifactName: "@layers/onboarding-contracts",
      artifactVersion: COLLECTOR_VERSION,
      hashEncoding: "exact-file-bytes",
      protocolVersion: 1,
      collectorProtocolVersion: 1,
      sourceInspectionSchemaVersion: 1,
      codebaseDigestSchemaVersion: 1,
      evidenceSchemaVersion: 1,
      collectionPolicyVersion: "v1",
      collectionPolicySha256: COLLECTION_POLICY_SHA256,
    },
  );
  assert.deepEqual(JSON.parse(policyBytes.toString("utf8")), ONBOARDING_COLLECTION_POLICY);

  const inventory = [...manifest.schemas, ...manifest.fixtures];
  assert.equal(
    new Set(inventory.map((entry) => entry.path)).size,
    inventory.length,
  );
  for (const entry of inventory) {
    const artifactPath = resolve(contractRoot, "dist", ...entry.path.split("/"));
    assert.equal(sha256(await readFile(artifactPath)), entry.sha256, entry.path);
  }

  const target = currentTarget();
  const expectedBinary = EXPECTED_BINARIES[target.packageName];
  assert.ok(expectedBinary);
  const collectorPackagePath = require.resolve(`${target.packageName}/package.json`);
  const collectorRoot = dirname(collectorPackagePath);
  const [collectorPackage, integrityValue] = await Promise.all([
    readJson(collectorPackagePath),
    readJson(require.resolve(`${target.packageName}/integrity.json`)),
  ]);
  assert.deepEqual(
    {
      name: collectorPackage.name,
      version: collectorPackage.version,
      os: collectorPackage.os,
      cpu: collectorPackage.cpu,
      files: collectorPackage.files,
      exports: collectorPackage.exports,
    },
    {
      name: target.packageName,
      version: COLLECTOR_VERSION,
      os: [target.platform],
      cpu: [target.arch],
      files: ["bin", "integrity.json"],
      exports: {
        "./package.json": "./package.json",
        "./integrity.json": "./integrity.json",
      },
    },
  );

  const integrity = OnboardingCollectorIntegritySchema.parse(integrityValue);
  assert.deepEqual(integrity, {
    schemaVersion: 1,
    packageName: target.packageName,
    packageVersion: COLLECTOR_VERSION,
    platform: target.platform,
    arch: target.arch,
    binaryPath: target.binaryPath,
    binaryBytes: expectedBinary.bytes,
    binarySha256: expectedBinary.sha256,
    collectorVersion: COLLECTOR_VERSION,
    collectorProtocolVersion: 1,
    sourceInspectionSchemaVersion: 1,
    codebaseDigestSchemaVersion: 1,
    preparedSchemaVersion: 1,
    contractArtifactVersion: COLLECTOR_VERSION,
    contractManifestSha256: CONTRACT_MANIFEST_SHA256,
    collectionPolicyVersion: "v1",
    collectionPolicySha256: COLLECTION_POLICY_SHA256,
  });

  const binaryPath = resolve(collectorRoot, ...target.binaryPath.split("/"));
  const binaryBytes = await readFile(binaryPath);
  assert.equal((await stat(binaryPath)).size, expectedBinary.bytes);
  assert.equal(sha256(binaryBytes), expectedBinary.sha256);
});

test("runs the real handshake, inspect/prepare/reinspect/prepare/complete and cancel lifecycles", async () => {
  const outerTmp = await mkdtemp(join(tmpdir(), "layers-collector-host-test-"));
  const savedTmp = new Map(
    ["TMPDIR", "TMP", "TEMP"].map((name) => [name, process.env[name]]),
  );
  for (const name of savedTmp.keys()) process.env[name] = outerTmp;

  let completingSession;
  let cancelingSession;
  try {
    const workspace = await createWorkspace(outerTmp);
    const target = currentTarget();
    const expectedBinary = EXPECTED_BINARIES[target.packageName];
    assert.ok(expectedBinary);

    completingSession = await openOnboardingCollector({
      deadlineAtMs: Date.now() + 120_000,
    });
    let stages = await stageDirectories(outerTmp);
    assert.equal(stages.length, 1);
    const stagedBinaryPath = join(stages[0], basename(target.binaryPath));
    assert.equal(sha256(await readFile(stagedBinaryPath)), expectedBinary.sha256);
    if (process.platform !== "win32") {
      assert.equal((await stat(stages[0])).mode & 0o777, 0o700);
      assert.equal((await stat(stagedBinaryPath)).mode & 0o777, 0o500);
    }

    const initial = await inspectReady(completingSession, workspace);
    const firstPrepared = assertPreparedPairsWithProjection(
      await completingSession.prepare(),
      initial,
    );
    const revisedResponse = await completingSession.reinspect({
      excludedPathIds: [],
      excludedTargetIds: [],
      selectedTargetIds: [],
    });
    const revised = OnboardingSourceInspectionSchema.parse(
      revisedResponse.projection,
    );
    assert.equal(revised.status, "ready");
    const secondPrepared = assertPreparedPairsWithProjection(
      await completingSession.prepare(),
      revised,
    );
    assert.notStrictEqual(secondPrepared, firstPrepared);
    assert.deepEqual(await completingSession.complete(), {
      bufferCount: secondPrepared.transientExcerpts.length,
      bufferBytes: secondPrepared.transientExcerpts.reduce(
        (total, excerpt) => total + Buffer.byteLength(excerpt.content, "utf8"),
        0,
      ),
    });
    completingSession = undefined;
    assert.deepEqual(await stageDirectories(outerTmp), []);

    cancelingSession = await openOnboardingCollector({
      deadlineAtMs: Date.now() + 120_000,
    });
    stages = await stageDirectories(outerTmp);
    assert.equal(stages.length, 1);
    const cancelProjection = await inspectReady(cancelingSession, workspace);
    assert.deepEqual(await cancelingSession.cancel(), {
      bufferCount: cancelProjection.excerptSummary.count,
      bufferBytes: cancelProjection.excerptSummary.totalBytes,
    });
    cancelingSession = undefined;
    assert.deepEqual(await stageDirectories(outerTmp), []);
  } finally {
    try {
      completingSession?.abort();
      cancelingSession?.abort();
      await waitForStageCleanup(outerTmp);
    } finally {
      for (const [name, value] of savedTmp) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await rm(outerTmp, { recursive: true, force: true });
    }
  }
});

test(
  "expires an idle inspected generation with an exact cleanup receipt before later body access",
  { timeout: 15_000 },
  async () => {
    const outerTmp = await mkdtemp(join(tmpdir(), "layers-collector-expiry-test-"));
    const savedTmp = new Map(
      ["TMPDIR", "TMP", "TEMP"].map((name) => [name, process.env[name]]),
    );
    for (const name of savedTmp.keys()) process.env[name] = outerTmp;

    let session;
    try {
      const workspace = await createWorkspace(outerTmp);
      const requestedDeadlineAtMs = Date.now() + 4_000;
      session = await openOnboardingCollector({
        deadlineAtMs: requestedDeadlineAtMs,
      });
      assert.ok(session.deadlineAtMs <= requestedDeadlineAtMs);
      assert.ok(session.deadlineAtMs > Date.now());

      const projection = await inspectReady(session, workspace);
      assert.equal((await stageDirectories(outerTmp)).length, 1);

      const termination = await session.waitForTermination();
      assert.equal(termination.reason, "expired");
      assert.equal(termination.error.supportCode, "ONBOARD_COLLECTOR_TIMEOUT");

      // Graceful expiry enters closing before publishing termination. A signal
      // delivered after the event must not clobber its native cleanup receipt.
      session.abort();

      // A caller can observe expiry before graceful native cancellation has
      // finished. A late operation must not replace that in-flight cleanup
      // with a hard stop or erase its exact receipt.
      await assert.rejects(session.complete(), assertTimeoutError);
      assert.deepEqual(await termination.cleanup, {
        bufferCount: projection.excerptSummary.count,
        bufferBytes: projection.excerptSummary.totalBytes,
      });
      assert.deepEqual(await stageDirectories(outerTmp), []);

      await assert.rejects(
        session.prepare(),
        (error) => error?.supportCode === "ONBOARD_COLLECTOR_TIMEOUT",
      );
      await assert.rejects(session.cancel(), assertProtocolError);
      session = undefined;
    } finally {
      try {
        session?.abort();
        await waitForStageCleanup(outerTmp);
      } finally {
        for (const [name, value] of savedTmp) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
        await rm(outerTmp, { recursive: true, force: true });
      }
    }
  },
);

test(
  "fails closed when a suspended host starts an operation after generation expiry",
  { timeout: 15_000 },
  async () => {
    const outerTmp = await mkdtemp(
      join(tmpdir(), "layers-collector-active-expiry-test-"),
    );
    const savedTmp = new Map(
      ["TMPDIR", "TMP", "TEMP"].map((name) => [name, process.env[name]]),
    );
    for (const name of savedTmp.keys()) process.env[name] = outerTmp;

    let session;
    try {
      const workspace = await createWorkspace(outerTmp);
      session = await openOnboardingCollector({
        deadlineAtMs: Date.now() + 4_000,
      });
      await inspectReady(session, workspace);

      // The deadline timer is deliberately unable to run during this simulated
      // host suspend. The resumed operation must enforce the same absolute TTL.
      suspendEventLoopUntilAfter(session.deadlineAtMs);
      await assert.rejects(session.prepare(), assertTimeoutError);

      const termination = await session.waitForTermination();
      assert.equal(termination.reason, "expired");
      assertTimeoutError(termination.error);
      assert.equal(await termination.cleanup, null);
      assert.deepEqual(await stageDirectories(outerTmp), []);
      session = undefined;
    } finally {
      try {
        session?.abort();
        await waitForStageCleanup(outerTmp);
      } finally {
        for (const [name, value] of savedTmp) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
        await rm(outerTmp, { recursive: true, force: true });
      }
    }
  },
);

test(
  "publishes failed termination when abort races ordinary cleanup",
  { timeout: 15_000 },
  async () => {
    const outerTmp = await mkdtemp(
      join(tmpdir(), "layers-collector-cleanup-failure-test-"),
    );
    const savedTmp = new Map(
      ["TMPDIR", "TMP", "TEMP"].map((name) => [name, process.env[name]]),
    );
    for (const name of savedTmp.keys()) process.env[name] = outerTmp;

    let session;
    try {
      const workspace = await createWorkspace(outerTmp);
      session = await openOnboardingCollector({
        deadlineAtMs: Date.now() + 120_000,
      });
      await inspectReady(session, workspace);
      await session.prepare();

      const completion = session.complete();
      session.abort();
      const termination = await session.waitForTermination();
      assert.equal(termination.reason, "failed");
      assert.equal(
        termination.error.supportCode,
        "ONBOARD_COLLECTOR_FAILED",
      );
      assert.equal(await termination.cleanup, null);
      await completion.catch(() => undefined);
      await waitForStageCleanup(outerTmp);
      session = undefined;
    } finally {
      try {
        session?.abort();
        await waitForStageCleanup(outerTmp);
      } finally {
        for (const [name, value] of savedTmp) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
        await rm(outerTmp, { recursive: true, force: true });
      }
    }
  },
);

test("enforces serialized, bounded JSONL framing on a temporary host copy", async () => {
  const copyRoot = await mkdtemp(join(tmpdir(), "layers-collector-reader-test-"));
  try {
    const sourcePath = join(PROJECT_ROOT, "dist", "onboarding", "collector-host.js");
    const copiedPath = join(copyRoot, "collector-host-reader.mjs");
    const contractModuleUrl = pathToFileURL(
      require.resolve("@layers/onboarding-contracts"),
    ).href;
    const source = await readFile(sourcePath, "utf8");
    const rewritten = source.replace(
      'from "@layers/onboarding-contracts";',
      `from ${JSON.stringify(contractModuleUrl)};`,
    );
    assert.notEqual(rewritten, source);
    await writeFile(
      copiedPath,
      `${rewritten}\nexport { BoundedJsonlReader as __TestBoundedJsonlReader };\n`,
      { mode: 0o600 },
    );
    await chmod(copiedPath, 0o600);
    const { __TestBoundedJsonlReader: BoundedJsonlReader } = await import(
      `${pathToFileURL(copiedPath).href}?copy=${Date.now()}`
    );

    {
      const stream = new PassThrough();
      const fatals = [];
      const reader = new BoundedJsonlReader(stream, 128, (error) => {
        fatals.push(error);
      }, true);
      const frame = reader.next(1_000);
      const first = Buffer.from('{"type":"frag');
      const second = Buffer.from('mented"}\n');
      stream.write(first);
      stream.write(second);
      assert.deepEqual(await frame, { type: "fragmented" });
      assert.ok(first.every((byte) => byte === 0));
      assert.ok(second.every((byte) => byte === 0));
      stream.end();
      await reader.waitForEnd(1_000);
      assert.deepEqual(fatals, []);
    }

    {
      const stream = new PassThrough();
      const fatals = [];
      const reader = new BoundedJsonlReader(stream, 128, (error) => {
        fatals.push(error);
      });
      stream.write('{"unsolicited":true}\n');
      assert.equal(fatals.length, 1);
      assertProtocolError(fatals[0]);
      assert.throws(() => reader.assertHealthy(), assertProtocolError);
    }

    {
      const stream = new PassThrough();
      const fatals = [];
      const reader = new BoundedJsonlReader(stream, 128, (error) => {
        fatals.push(error);
      });
      const frame = reader.next(1_000);
      stream.write('{"valid":true}\ntrailing');
      await assert.rejects(frame, assertProtocolError);
      assert.equal(fatals.length, 1);
      assertProtocolError(fatals[0]);
    }

    {
      const stream = new PassThrough();
      const fatals = [];
      const reader = new BoundedJsonlReader(stream, 128, (error) => {
        fatals.push(error);
      });
      const frame = reader.next(1_000);
      stream.end('{"partial":true');
      await assert.rejects(frame, assertProtocolError);
      assert.equal(fatals.length, 1);
      assertProtocolError(fatals[0]);
    }

    {
      const stream = new PassThrough();
      const fatals = [];
      const reader = new BoundedJsonlReader(stream, 128, (error) => {
        fatals.push(error);
      });
      const frame = reader.next(1_000);
      stream.write(Buffer.alloc(130, 0x61));
      await assert.rejects(frame, assertProtocolError);
      assert.equal(fatals.length, 1);
      assertProtocolError(fatals[0]);
    }

    {
      const stream = new PassThrough();
      const fatals = [];
      const reader = new BoundedJsonlReader(stream, 256, (error) => {
        fatals.push(error);
      }, true);
      const deadlineAtMs = Date.now() + 25;
      const frame = reader.next(1_000, deadlineAtMs);
      const privateBody = Buffer.from(
        '{"type":"prepared_artifact","body":"must-not-materialize"}\n',
      );
      const originalJsonParse = JSON.parse;
      let privateBodyParsed = false;
      JSON.parse = (value, reviver) => {
        if (String(value).includes("must-not-materialize")) {
          privateBodyParsed = true;
        }
        return originalJsonParse(value, reviver);
      };
      try {
        // Model host suspend: the absolute deadline passes while the event loop
        // cannot service either the frame or its timer. The data callback runs
        // first on resume and must still reject before UTF-8/JSON materialization.
        suspendEventLoopUntilAfter(deadlineAtMs);
        stream.write(privateBody);
        await assert.rejects(frame, assertTimeoutError);
      } finally {
        JSON.parse = originalJsonParse;
      }
      assert.equal(privateBodyParsed, false);
      assert.ok(privateBody.every((byte) => byte === 0));
      assert.equal(fatals.length, 1);
      assertTimeoutError(fatals[0]);
    }
  } finally {
    await rm(copyRoot, { recursive: true, force: true });
  }
});
