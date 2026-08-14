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

import { openOnboardingCollector } from "../dist/onboarding/collector-host.js";

const require = createRequire(import.meta.url);
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COLLECTOR_VERSION = "0.1.3";
const CONTRACT_MANIFEST_SHA256 =
  "9633a66e7095fd473483a4dee1fb4e5bc328f3f75ed322096f5a6ed2a1a71aa4";
const COLLECTION_POLICY_SHA256 =
  "d35170d24c54f0dfad57cce99bfeaf69ca05d779c4e422a1fa5636680c2127b6";
const STAGE_PREFIX = "layers-onboarding-collector-";
const EXCLUDED_SECRET_SENTINEL = "collector-secret-must-never-cross";

const EXPECTED_BINARIES = {
  "@layers/onboarding-collector-darwin-arm64": {
    bytes: 5_718_898,
    sha256: "d544a7e9a860cb832cab5fe58c149c05bcc54156c7462d117cb1cc0d52431615",
  },
  "@layers/onboarding-collector-darwin-x64": {
    bytes: 5_877_392,
    sha256: "2e1aad9a651f7d5a58470cacd1617a47f1071a6e0ae625a27b535117ef8aaa8c",
  },
  "@layers/onboarding-collector-linux-arm64": {
    bytes: 5_762_951,
    sha256: "e9c9e8db97e16ccd1846d196139b235b1e30435925afe1d0ef4966810ef9c037",
  },
  "@layers/onboarding-collector-linux-x64": {
    bytes: 5_930_867,
    sha256: "1092f14b7df175e56c95d9d13ea4ee007317a872588eae5fcc7e46db3ac3a1ff",
  },
  "@layers/onboarding-collector-win32-arm64": {
    bytes: 5_949_952,
    sha256: "e6e89f1b07614aa372f1e83e6da91e5d7efec4a586811d68472f201e6e5d8797",
  },
  "@layers/onboarding-collector-win32-x64": {
    bytes: 6_237_184,
    sha256: "e8ea8d9845cd451016ef538dea0b0b60af34ffef8fd2541c7de19f26202073d9",
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

test("pins the exact installed 0.1.3 contract and current-platform collector artifacts", async () => {
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
  } finally {
    await rm(copyRoot, { recursive: true, force: true });
  }
});
