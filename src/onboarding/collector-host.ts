import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdtemp,
  open,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { createServer, type Server, type Socket } from "node:net";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import type { Readable, Writable } from "node:stream";
import { TextDecoder } from "node:util";
import {
  ONBOARD_AGENT_EVIDENCE_MAX_BODY_BYTES,
  ONBOARDING_COLLECTOR_MAX_REQUEST_BYTES,
  ONBOARDING_COLLECTOR_PRIVATE_OUTPUT_TRANSPORTS,
  ONBOARDING_COLLECTOR_TARGETS,
  OnboardingCollectorHandshakeSchema,
  OnboardingCollectorIntegritySchema,
  OnboardingCollectorPrivateResponseSchema,
  OnboardingCollectorRequestSchema,
  OnboardingCollectorResponseSchema,
  type OnboardingCollectorHandshake,
  type OnboardingCollectorIntegrity,
  type OnboardingCollectorPrivateResponse,
  type OnboardingCollectorRequest,
  type OnboardingCollectorResponse,
  type OnboardingPreparedCodebaseArtifact,
  type OnboardingSourceInspection,
} from "@layers/onboarding-contracts";

const require = createRequire(import.meta.url);

/**
 * The onboarding artifact set this launcher will run: the contracts package and
 * the six native collector packages, which move together.
 *
 * ONE NUMBER BECAUSE UPSTREAM STAMPS ONE NUMBER.
 * `scripts/build-onboarding-collector-packages.mjs` in `layers/layers` hard-
 * fails unless `@layers/onboarding-contracts` carries its `PACKAGE_VERSION`,
 * and writes that same value into each collector package's version, its
 * `collectorVersion`, and its `contractArtifactVersion`;
 * `collector-protocol.ts` then requires all three to agree. There is no
 * releasable combination where the collector moves and the contracts artifact
 * does not, so splitting this constant would only let this file describe a
 * state that cannot exist.
 *
 * DIGESTS BELOW ARE PART OF THIS PIN. Bumping this without re-measuring
 * `CONTRACT_MANIFEST_SHA256`, `COLLECTION_POLICY_SHA256` and every
 * `EXPECTED_BINARIES` entry leaves the launcher refusing artifacts it just
 * installed. `test/collector-host.test.mjs` is the gate: it re-derives all
 * eight from the installed packages.
 *
 * The 0.1.5 values below were measured from the published tarballs and
 * cross-checked against each package's own `integrity.json` and against the
 * contracts manifest the collectors were built from.
 */
const COLLECTOR_PACKAGE_VERSION = "0.1.5";
const CONTRACT_PACKAGE_NAME = "@layers/onboarding-contracts";
const CONTRACT_MANIFEST_SHA256 =
  "a8139e2110716f59a2d2f13719e3f0d0da11a65d36970531b2f306c7b3e89127";
const COLLECTION_POLICY_SHA256 =
  "d35170d24c54f0dfad57cce99bfeaf69ca05d779c4e422a1fa5636680c2127b6";
const JSON_METADATA_MAX_BYTES = 1024 * 1024;
const INBOUND_FRAME_MAX_BYTES = ONBOARD_AGENT_EVIDENCE_MAX_BODY_BYTES;
const STDERR_MAX_BYTES = 64 * 1024;
const PIPE_LISTEN_TIMEOUT_MS = 5_000;
const PIPE_CONNECT_TIMEOUT_MS = 5_000;
const HANDSHAKE_TIMEOUT_MS = 5_000;
const INSPECTION_TIMEOUT_MS = 60_000;
const SELECT_TIMEOUT_MS = 10_000;
const PREPARE_TIMEOUT_MS = 10_000;
const CLEANUP_TIMEOUT_MS = 5_000;
const KILL_GRACE_MS = 2_000;
const SESSION_MAX_MS = 15 * 60_000;
const STAGE_PREFIX = "layers-onboarding-collector-";
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/**
 * The exact bytes of each published 0.1.5 collector.
 *
 * Re-derive from the published tarballs (not just the locally installed one —
 * only the current platform's package installs here) and cross-check each pair
 * against that package's own `integrity.json` before changing them.
 */
const EXPECTED_BINARIES: Readonly<
  Record<string, { readonly bytes: number; readonly sha256: string }>
> = {
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

const REQUIRED_MANIFEST_SCHEMAS = new Set([
  "collector-handshake-v1",
  "collector-integrity-v1",
  "collector-private-response-v1",
  "collector-request-v1",
  "collector-response-v1",
  "collection-policy-v1",
  "prepared-codebase-v1",
  "source-inspection-v1",
]);

export const ONBOARDING_COLLECTOR_UPDATE_COMMAND =
  "npx --yes @layers/mcp-server@latest onboard";

export type OnboardingCollectorSupportCode =
  | "ONBOARD_COLLECTOR_UNSUPPORTED"
  /**
   * The platform package is not on disk at all.
   *
   * DISTINCT FROM INTEGRITY, because the remedy is the opposite. An integrity
   * failure means "what is installed is not what this launcher trusts" and the
   * honest response is to stop. This means "nothing is installed", which is
   * almost always `--omit=optional`, `--no-optional`, or a lockfile that pruned
   * the optional deps — a reinstall fixes it. Reporting the two the same way
   * sent people hunting for a supply-chain problem they did not have.
   */
  | "ONBOARD_COLLECTOR_NOT_INSTALLED"
  | "ONBOARD_COLLECTOR_INTEGRITY"
  | "ONBOARD_COLLECTOR_PROTOCOL"
  | "ONBOARD_COLLECTOR_TIMEOUT"
  | "ONBOARD_COLLECTOR_FAILED";

/**
 * The command that actually resolves each fault, where one exists.
 *
 * A REMEDY IS A PROMISE. Handing back "re-run the onboard command" for every
 * failure tells somebody on an unsupported CPU to run the thing that just told
 * them their CPU is unsupported, and it tells somebody with a pruned optional
 * dependency to re-run a command that will prune it again. Only codes with a
 * real fix get one; the rest get none, and the caller says nothing rather than
 * something untrue.
 */
const COLLECTOR_REMEDY_COMMANDS: Readonly<
  Partial<Record<OnboardingCollectorSupportCode, string>>
> = {
  // The package was never installed, so install it. `npx` caches aggressively
  // enough that a fresh cache is the reliable form.
  ONBOARD_COLLECTOR_NOT_INSTALLED:
    "npm install --include=optional @layers/mcp-server",
  // A timeout is the one collector fault that a second run genuinely fixes.
  ONBOARD_COLLECTOR_TIMEOUT: ONBOARDING_COLLECTOR_UPDATE_COMMAND,
  // Nothing local fixes an unsupported platform, and nothing local fixes an
  // integrity mismatch either — that one is deliberately not a "try again".
};

export class OnboardingCollectorHostError extends Error {
  readonly supportCode: OnboardingCollectorSupportCode;
  /**
   * Retained for callers that still read it, but no longer implies the command
   * will help. `remedyCommand` is the one that does.
   */
  readonly retryCommand: string;
  /** The command that resolves THIS fault, when one exists. */
  readonly remedyCommand?: string;

  constructor(supportCode: OnboardingCollectorSupportCode, message: string) {
    super(message);
    this.name = "OnboardingCollectorHostError";
    this.supportCode = supportCode;
    this.retryCommand = ONBOARDING_COLLECTOR_UPDATE_COMMAND;
    const remedy = COLLECTOR_REMEDY_COMMANDS[supportCode];
    if (remedy !== undefined) this.remedyCommand = remedy;
  }
}

type InspectionResponse = Extract<
  OnboardingCollectorResponse,
  { type: "inspection" }
>;
type CleanupResult = Extract<
  OnboardingCollectorResponse,
  { type: "canceled" | "completed" }
>["cleanup"];

export interface OnboardingCollectorSession {
  readonly deadlineAtMs: number;
  waitForTermination(): Promise<OnboardingCollectorTermination>;
  inspect(input?: {
    root?: string;
    selectedCandidateId?: string;
  }): Promise<InspectionResponse>;
  select(selectedCandidateId: string): Promise<InspectionResponse>;
  reinspect(input: {
    excludedPathIds: string[];
    excludedTargetIds: string[];
    selectedTargetIds: string[];
  }): Promise<InspectionResponse>;
  prepare(): Promise<OnboardingPreparedCodebaseArtifact>;
  complete(): Promise<CleanupResult>;
  cancel(): Promise<CleanupResult>;
  abort(): void;
}

export interface OnboardingCollectorTermination {
  reason: "expired" | "failed";
  error: OnboardingCollectorHostError;
  /**
   * Resolves after the staged binary and every collector-owned buffer have
   * been released. A clean idle expiry returns the collector's bounded cleanup
   * receipt; any termination without a native cleanup receipt returns null.
   */
  cleanup: Promise<CleanupResult | null>;
}

export interface OpenOnboardingCollectorOptions {
  signal?: AbortSignal;
  /** Epoch milliseconds; callers should pass the reservation expiry. */
  deadlineAtMs?: number;
}

interface VerifiedCollector {
  binary: Buffer;
  integrity: OnboardingCollectorIntegrity;
  target: (typeof ONBOARDING_COLLECTOR_TARGETS)[number];
}

interface StagedCollector {
  binaryPath: string;
  directory: string;
}

interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  spawnFailed: boolean;
}

interface FrameWaiter {
  resolve: (frame: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  deadlineAtMs?: number;
}

interface EndWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface ManifestEntry {
  name: string;
  path: string;
  sha256: string;
}

interface ContractManifest {
  artifactName: string;
  artifactVersion: string;
  hashEncoding: string;
  protocolVersion: number;
  collectorProtocolVersion: number;
  sourceInspectionSchemaVersion: number;
  codebaseDigestSchemaVersion: number;
  evidenceSchemaVersion: number;
  collectionPolicyVersion: string;
  collectionPolicyEffectiveDate: string;
  collectionPolicySha256: string;
  sourceTermsVersion: string;
  sourceTermsUrl: string;
  schemas: ManifestEntry[];
  fixtures: ManifestEntry[];
}

function protocolError(): OnboardingCollectorHostError {
  return new OnboardingCollectorHostError(
    "ONBOARD_COLLECTOR_PROTOCOL",
    "The local onboarding collector returned an invalid response.",
  );
}

/**
 * Why the platform package could not be resolved.
 *
 * "NOT INSTALLED" AND "NOT TRUSTWORTHY" NEED OPPOSITE RESPONSES. An integrity
 * failure means what is on disk is not what this launcher trusts, and the
 * correct move is to stop and not run it. A missing module means nothing is on
 * disk — nearly always `--omit=optional`, `--no-optional`, or a lockfile that
 * pruned the optional deps — and the correct move is to reinstall. Reporting
 * both as "could not be verified" sent people hunting a supply-chain problem
 * they did not have.
 */
export function collectorResolutionError(
  error: unknown,
  packageName: string,
): OnboardingCollectorHostError {
  if (
    (error as NodeJS.ErrnoException | undefined)?.code === "MODULE_NOT_FOUND"
  ) {
    return new OnboardingCollectorHostError(
      "ONBOARD_COLLECTOR_NOT_INSTALLED",
      `${packageName} is not installed. Layers onboarding ships the collector as an optional platform dependency, so an install run with --omit=optional or --no-optional leaves nothing to verify. Reinstall without omitting optional dependencies.`,
    );
  }
  return integrityError();
}

function integrityError(): OnboardingCollectorHostError {
  return new OnboardingCollectorHostError(
    "ONBOARD_COLLECTOR_INTEGRITY",
    "The local onboarding collector could not be verified.",
  );
}

function timeoutError(): OnboardingCollectorHostError {
  return new OnboardingCollectorHostError(
    "ONBOARD_COLLECTOR_TIMEOUT",
    "The local onboarding collector timed out.",
  );
}

function failedError(): OnboardingCollectorHostError {
  return new OnboardingCollectorHostError(
    "ONBOARD_COLLECTOR_FAILED",
    "The local onboarding collector stopped before cleanup completed.",
  );
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isInside(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return (
    child === "" ||
    (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

function decodeJson(bytes: Buffer): unknown {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    throw integrityError();
  }
}

async function readRegularFile(
  file: string,
  maxBytes: number,
): Promise<Buffer> {
  const leaf = await lstat(file);
  if (!leaf.isFile() || leaf.isSymbolicLink() || leaf.size > maxBytes)
    throw integrityError();

  const noFollow =
    typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(file, fsConstants.O_RDONLY | noFollow);
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.size !== leaf.size ||
      metadata.size > maxBytes
    ) {
      throw integrityError();
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength !== metadata.size) throw integrityError();
    return bytes;
  } finally {
    await handle.close();
  }
}

async function resolveRegularFile(file: string, root: string): Promise<string> {
  const unresolved = await lstat(file);
  if (!unresolved.isFile() || unresolved.isSymbolicLink())
    throw integrityError();
  const resolved = await realpath(file);
  if (!isInside(root, resolved)) throw integrityError();
  const metadata = await lstat(resolved);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw integrityError();
  return resolved;
}

function parseManifestEntry(value: unknown): ManifestEntry {
  const record = asRecord(value);
  if (
    !record ||
    !hasExactKeys(record, ["name", "path", "sha256"]) ||
    typeof record.name !== "string" ||
    record.name.length === 0 ||
    typeof record.path !== "string" ||
    record.path.length === 0 ||
    typeof record.sha256 !== "string" ||
    !SHA256_PATTERN.test(record.sha256)
  ) {
    throw integrityError();
  }
  return { name: record.name, path: record.path, sha256: record.sha256 };
}

function parseManifest(value: unknown): ContractManifest {
  const record = asRecord(value);
  const keys = [
    "artifactName",
    "artifactVersion",
    "hashEncoding",
    "protocolVersion",
    "collectorProtocolVersion",
    "sourceInspectionSchemaVersion",
    "codebaseDigestSchemaVersion",
    "evidenceSchemaVersion",
    "collectionPolicyVersion",
    "collectionPolicyEffectiveDate",
    "collectionPolicySha256",
    "sourceTermsVersion",
    "sourceTermsUrl",
    "schemas",
    "fixtures",
  ] as const;
  if (
    !record ||
    !hasExactKeys(record, keys) ||
    !Array.isArray(record.schemas) ||
    !Array.isArray(record.fixtures)
  ) {
    throw integrityError();
  }

  const manifest: ContractManifest = {
    artifactName: String(record.artifactName),
    artifactVersion: String(record.artifactVersion),
    hashEncoding: String(record.hashEncoding),
    protocolVersion: Number(record.protocolVersion),
    collectorProtocolVersion: Number(record.collectorProtocolVersion),
    sourceInspectionSchemaVersion: Number(record.sourceInspectionSchemaVersion),
    codebaseDigestSchemaVersion: Number(record.codebaseDigestSchemaVersion),
    evidenceSchemaVersion: Number(record.evidenceSchemaVersion),
    collectionPolicyVersion: String(record.collectionPolicyVersion),
    collectionPolicyEffectiveDate: String(record.collectionPolicyEffectiveDate),
    collectionPolicySha256: String(record.collectionPolicySha256),
    sourceTermsVersion: String(record.sourceTermsVersion),
    sourceTermsUrl: String(record.sourceTermsUrl),
    schemas: record.schemas.map(parseManifestEntry),
    fixtures: record.fixtures.map(parseManifestEntry),
  };
  if (
    manifest.artifactName !== CONTRACT_PACKAGE_NAME ||
    manifest.artifactVersion !== COLLECTOR_PACKAGE_VERSION ||
    manifest.hashEncoding !== "exact-file-bytes" ||
    manifest.protocolVersion !== 1 ||
    manifest.collectorProtocolVersion !== 1 ||
    manifest.sourceInspectionSchemaVersion !== 1 ||
    manifest.codebaseDigestSchemaVersion !== 1 ||
    manifest.evidenceSchemaVersion !== 1 ||
    manifest.collectionPolicyVersion !== "v1" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(manifest.collectionPolicyEffectiveDate) ||
    manifest.collectionPolicySha256 !== COLLECTION_POLICY_SHA256 ||
    manifest.sourceTermsVersion !== "v1" ||
    manifest.sourceTermsUrl !==
      "https://layers.com/legal/onboarding-source-data" ||
    manifest.schemas.length === 0
  ) {
    throw integrityError();
  }
  return manifest;
}

function safeInventoryPath(root: string, entryPath: string): string {
  if (
    entryPath.includes("\\") ||
    entryPath.startsWith("/") ||
    entryPath.endsWith("/") ||
    entryPath
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  ) {
    throw integrityError();
  }
  const candidate = resolve(root, ...entryPath.split("/"));
  if (!isInside(root, candidate)) throw integrityError();
  return candidate;
}

async function verifyManifestInventory(
  manifest: ContractManifest,
  contractDistRoot: string,
): Promise<void> {
  const schemaNames = new Set<string>();
  const fixtureNames = new Set<string>();
  const paths = new Set<string>();
  const entries = [
    ...manifest.schemas.map((entry) => ({ entry, names: schemaNames })),
    ...manifest.fixtures.map((entry) => ({ entry, names: fixtureNames })),
  ];
  for (const { entry, names } of entries) {
    if (names.has(entry.name) || paths.has(entry.path)) throw integrityError();
    names.add(entry.name);
    paths.add(entry.path);
  }
  for (const required of REQUIRED_MANIFEST_SCHEMAS) {
    if (!schemaNames.has(required)) throw integrityError();
  }

  await Promise.all(
    entries.map(async ({ entry }) => {
      const candidate = safeInventoryPath(contractDistRoot, entry.path);
      const resolved = await resolveRegularFile(candidate, contractDistRoot);
      const bytes = await readRegularFile(resolved, INBOUND_FRAME_MAX_BYTES);
      if (sha256(bytes) !== entry.sha256) throw integrityError();
    }),
  );
}

async function verifyContractArtifact(
  integrity: OnboardingCollectorIntegrity,
): Promise<void> {
  const contractIndex = await realpath(require.resolve(CONTRACT_PACKAGE_NAME));
  const contractDistRoot = dirname(contractIndex);
  const contractRoot = await realpath(resolve(contractDistRoot, ".."));
  if (!isInside(contractRoot, contractIndex)) throw integrityError();

  const packagePath = await resolveRegularFile(
    join(contractRoot, "package.json"),
    contractRoot,
  );
  const manifestPath = await resolveRegularFile(
    require.resolve(`${CONTRACT_PACKAGE_NAME}/manifest.json`),
    contractRoot,
  );
  const policyPath = await resolveRegularFile(
    require.resolve(`${CONTRACT_PACKAGE_NAME}/collection-policy-v1.json`),
    contractRoot,
  );
  if (
    !isInside(contractDistRoot, manifestPath) ||
    !isInside(contractDistRoot, policyPath)
  ) {
    throw integrityError();
  }

  const [packageBytes, manifestBytes, policyBytes] = await Promise.all([
    readRegularFile(packagePath, JSON_METADATA_MAX_BYTES),
    readRegularFile(manifestPath, JSON_METADATA_MAX_BYTES),
    readRegularFile(policyPath, JSON_METADATA_MAX_BYTES),
  ]);
  const packageJson = asRecord(decodeJson(packageBytes));
  const manifest = parseManifest(decodeJson(manifestBytes));
  if (
    packageJson?.name !== CONTRACT_PACKAGE_NAME ||
    packageJson.version !== COLLECTOR_PACKAGE_VERSION ||
    integrity.contractArtifactVersion !== COLLECTOR_PACKAGE_VERSION ||
    integrity.contractManifestSha256 !== CONTRACT_MANIFEST_SHA256 ||
    integrity.collectionPolicyVersion !== "v1" ||
    integrity.collectionPolicySha256 !== COLLECTION_POLICY_SHA256 ||
    sha256(manifestBytes) !== CONTRACT_MANIFEST_SHA256 ||
    sha256(policyBytes) !== COLLECTION_POLICY_SHA256 ||
    manifest.collectorProtocolVersion !== integrity.collectorProtocolVersion ||
    manifest.sourceInspectionSchemaVersion !==
      integrity.sourceInspectionSchemaVersion ||
    manifest.codebaseDigestSchemaVersion !==
      integrity.codebaseDigestSchemaVersion
  ) {
    throw integrityError();
  }
  await verifyManifestInventory(manifest, contractDistRoot);
}

async function verifyCollectorInstallation(
  metadataOnly: false,
): Promise<VerifiedCollector>;
async function verifyCollectorInstallation(metadataOnly: true): Promise<null>;
async function verifyCollectorInstallation(
  metadataOnly = false,
): Promise<VerifiedCollector | null> {
  const target = ONBOARDING_COLLECTOR_TARGETS.find(
    (candidate) =>
      candidate.platform === process.platform &&
      candidate.arch === process.arch,
  );
  if (!target) {
    throw new OnboardingCollectorHostError(
      "ONBOARD_COLLECTOR_UNSUPPORTED",
      `Layers onboarding does not support ${process.platform}/${process.arch}.`,
    );
  }

  // RESOLUTION IS ITS OWN FAILURE MODE, checked before anything can call the
  // result an integrity problem. `require.resolve` throwing MODULE_NOT_FOUND
  // means the optional platform package was never installed; every later check
  // in this function is about a package that IS installed.
  let packageJsonUnresolved: string;
  let integrityUnresolved: string;
  try {
    packageJsonUnresolved = require.resolve(
      `${target.packageName}/package.json`,
    );
    integrityUnresolved = require.resolve(`${target.packageName}/integrity.json`);
  } catch (error) {
    throw collectorResolutionError(error, target.packageName);
  }

  try {
    const packageRoot = await realpath(dirname(packageJsonUnresolved));
    const packageJsonPath = await resolveRegularFile(
      packageJsonUnresolved,
      packageRoot,
    );
    const integrityPath = await resolveRegularFile(
      integrityUnresolved,
      packageRoot,
    );
    const [packageBytes, integrityBytes] = await Promise.all([
      readRegularFile(packageJsonPath, JSON_METADATA_MAX_BYTES),
      readRegularFile(integrityPath, JSON_METADATA_MAX_BYTES),
    ]);
    const packageJson = asRecord(decodeJson(packageBytes));
    const integrity = OnboardingCollectorIntegritySchema.parse(
      decodeJson(integrityBytes),
    );
    const expectedBinary = EXPECTED_BINARIES[target.packageName];
    if (
      !packageJson ||
      packageJson.name !== target.packageName ||
      packageJson.version !== COLLECTOR_PACKAGE_VERSION ||
      JSON.stringify(packageJson.os) !== JSON.stringify([target.platform]) ||
      JSON.stringify(packageJson.cpu) !== JSON.stringify([target.arch]) ||
      JSON.stringify(packageJson.files) !==
        JSON.stringify(["bin", "integrity.json"]) ||
      integrity.packageName !== target.packageName ||
      integrity.packageVersion !== COLLECTOR_PACKAGE_VERSION ||
      integrity.platform !== target.platform ||
      integrity.arch !== target.arch ||
      integrity.binaryPath !== target.binaryPath ||
      integrity.collectorVersion !== COLLECTOR_PACKAGE_VERSION ||
      integrity.contractArtifactVersion !== COLLECTOR_PACKAGE_VERSION ||
      !expectedBinary ||
      integrity.binaryBytes !== expectedBinary.bytes ||
      integrity.binarySha256 !== expectedBinary.sha256
    ) {
      throw integrityError();
    }

    const binaryPath = await resolveRegularFile(
      resolve(packageRoot, target.binaryPath),
      packageRoot,
    );
    if (metadataOnly) {
      // THE PRE-RESERVATION PASS STOPS HERE. It has already proved the package
      // identity, the pinned version, the integrity manifest and the contract
      // inventory — everything a wrong or pruned install gets caught by. What
      // it deliberately skips is reading and hashing six megabytes of binary,
      // because the open that follows a few seconds later has to do exactly
      // that anyway and doing it twice per run buys no additional guarantee.
      await verifyContractArtifact(integrity);
      return null;
    }
    const binary = await readRegularFile(binaryPath, expectedBinary.bytes);
    if (
      binary.byteLength !== expectedBinary.bytes ||
      sha256(binary) !== expectedBinary.sha256
    ) {
      binary.fill(0);
      throw integrityError();
    }
    try {
      await verifyContractArtifact(integrity);
    } catch (error) {
      binary.fill(0);
      throw error;
    }
    return { binary, integrity, target };
  } catch (error) {
    if (error instanceof OnboardingCollectorHostError) throw error;
    throw integrityError();
  }
}

/**
 * Verify the installed collector artifacts without staging or running one.
 *
 * WHY THE LAUNCHER CALLS THIS FIRST. A local artifact fault — wrong version,
 * bad digest, platform package pruned by `--omit=optional` — is knowable before
 * anything is reserved. `openOnboardingCollector` only runs after a reservation
 * exists, so the same fault used to cost a trial row, a reservation the person
 * never uses, and a session that has to explain why it stopped. Checking here
 * costs one filesystem read and zero server state.
 *
 * The verified binary is released immediately: this answers a question, it does
 * not hold a collector open.
 */
export async function verifyOnboardingCollectorArtifacts(): Promise<void> {
  await verifyCollectorInstallation(true);
}

async function stageCollector(
  verified: VerifiedCollector,
): Promise<StagedCollector> {
  const directory = await mkdtemp(join(tmpdir(), STAGE_PREFIX));
  try {
    await chmod(directory, 0o700);
    const binaryPath = join(
      directory,
      verified.target.platform === "win32"
        ? "layers-onboarding-collector.exe"
        : "layers-onboarding-collector",
    );
    await writeFile(binaryPath, verified.binary, { flag: "wx", mode: 0o600 });
    await chmod(binaryPath, 0o500);
    const staged = await readRegularFile(
      binaryPath,
      verified.integrity.binaryBytes,
    );
    try {
      if (
        staged.byteLength !== verified.integrity.binaryBytes ||
        sha256(staged) !== verified.integrity.binarySha256
      ) {
        throw integrityError();
      }
    } finally {
      staged.fill(0);
    }
    return { binaryPath, directory };
  } catch (error) {
    await removeStageDirectory(directory);
    throw error;
  }
}

async function removeStageDirectory(directory: string): Promise<void> {
  const parent = resolve(dirname(directory));
  const candidate = resolve(directory);
  if (
    parent !== resolve(tmpdir()) ||
    !basename(candidate).startsWith(STAGE_PREFIX)
  ) {
    throw failedError();
  }
  await rm(candidate, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 50,
  });
}

function childEnvironment(
  stageDirectory: string,
  privatePipeName?: string,
): NodeJS.ProcessEnv {
  const allowed = new Set([
    "COMSPEC",
    "LANG",
    "LC_ALL",
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "TZ",
    "WINDIR",
  ]);
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (typeof value === "string" && allowed.has(name.toUpperCase()))
      environment[name] = value;
  }
  Object.assign(environment, {
    GCM_INTERACTIVE: "Never",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    HOME: stageDirectory,
    TEMP: stageDirectory,
    TMP: stageDirectory,
    TMPDIR: stageDirectory,
    USERPROFILE: stageDirectory,
  });
  if (privatePipeName) {
    environment[
      ONBOARDING_COLLECTOR_PRIVATE_OUTPUT_TRANSPORTS.windows_named_pipe.environmentVariable
    ] = privatePipeName;
  }
  return environment;
}

function handshakeMatches(
  handshake: OnboardingCollectorHandshake,
  integrity: OnboardingCollectorIntegrity,
): boolean {
  return (
    handshake.collectorVersion === integrity.collectorVersion &&
    handshake.collectorProtocolVersion === integrity.collectorProtocolVersion &&
    handshake.sourceInspectionSchemaVersion ===
      integrity.sourceInspectionSchemaVersion &&
    handshake.codebaseDigestSchemaVersion ===
      integrity.codebaseDigestSchemaVersion &&
    handshake.preparedSchemaVersion === integrity.preparedSchemaVersion &&
    handshake.contractArtifactVersion === integrity.contractArtifactVersion &&
    handshake.contractManifestSha256 === integrity.contractManifestSha256 &&
    handshake.collectionPolicyVersion === integrity.collectionPolicyVersion &&
    handshake.collectionPolicySha256 === integrity.collectionPolicySha256
  );
}

function waitWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolveValue, rejectValue) => {
    const timeout = setTimeout(() => rejectValue(timeoutError()), timeoutMs);
    timeout.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolveValue(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        rejectValue(error);
      },
    );
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    const timeout = setTimeout(resolveDelay, ms);
    timeout.unref?.();
  });
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolveClose) => {
    if (!server.listening) {
      resolveClose();
      return;
    }
    server.close(() => resolveClose());
  });
}

class BoundedJsonlReader {
  readonly #stream: Readable;
  readonly #maxFrameBytes: number;
  readonly #onFatal: (error: Error) => void;
  readonly #wipeChunks: boolean;
  #buffer = Buffer.alloc(0);
  #waiter: FrameWaiter | undefined;
  #endWaiters: EndWaiter[] = [];
  #failure: Error | undefined;
  #ended = false;
  #closedByHost = false;

  constructor(
    stream: Readable,
    maxFrameBytes: number,
    onFatal: (error: Error) => void,
    wipeChunks = false,
  ) {
    this.#stream = stream;
    this.#maxFrameBytes = maxFrameBytes;
    this.#onFatal = onFatal;
    this.#wipeChunks = wipeChunks;
    stream.on("data", (chunk: Buffer | string) => this.#receive(chunk));
    stream.once("error", () => {
      if (!this.#closedByHost) this.#fail(protocolError());
    });
    stream.once("end", () => this.#finish());
    stream.once("close", () => this.#finish());
  }

  next(timeoutMs: number, deadlineAtMs?: number): Promise<unknown> {
    if (this.#failure) return Promise.reject(this.#failure);
    if (this.#ended || this.#waiter) return Promise.reject(protocolError());
    const now = Date.now();
    if (
      deadlineAtMs !== undefined &&
      (!Number.isFinite(deadlineAtMs) || now >= deadlineAtMs)
    ) {
      const error = timeoutError();
      this.#fail(error);
      return Promise.reject(error);
    }
    const effectiveTimeoutMs =
      deadlineAtMs === undefined
        ? timeoutMs
        : Math.min(timeoutMs, deadlineAtMs - now);
    return new Promise<unknown>((resolveFrame, rejectFrame) => {
      const timeout = setTimeout(() => {
        this.#waiter = undefined;
        const error = timeoutError();
        rejectFrame(error);
        this.#fail(error);
      }, effectiveTimeoutMs);
      timeout.unref?.();
      this.#waiter = {
        resolve: resolveFrame,
        reject: rejectFrame,
        timeout,
        ...(deadlineAtMs !== undefined ? { deadlineAtMs } : {}),
      };
    });
  }

  waitForEnd(timeoutMs: number): Promise<void> {
    if (this.#failure) return Promise.reject(this.#failure);
    if (this.#ended) return Promise.resolve();
    return new Promise<void>((resolveEnd, rejectEnd) => {
      const waiter: EndWaiter = {
        resolve: resolveEnd,
        reject: rejectEnd,
        timeout: setTimeout(() => {
          const index = this.#endWaiters.indexOf(waiter);
          if (index !== -1) this.#endWaiters.splice(index, 1);
          const error = timeoutError();
          rejectEnd(error);
          this.#fail(error);
        }, timeoutMs),
      };
      waiter.timeout.unref?.();
      this.#endWaiters.push(waiter);
    });
  }

  assertHealthy(): void {
    if (this.#failure) throw this.#failure;
  }

  assertOpen(): void {
    this.assertHealthy();
    if (this.#ended || this.#closedByHost) throw protocolError();
  }

  closeByHost(): void {
    if (this.#closedByHost) return;
    this.#closedByHost = true;
    this.#buffer.fill(0);
    this.#buffer = Buffer.alloc(0);
    this.#stream.destroy();
    this.#finish();
  }

  #receive(chunk: Buffer | string): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    if (this.#failure || this.#closedByHost) {
      if (this.#wipeChunks) bytes.fill(0);
      return;
    }
    // The collector protocol is serialized: bytes are permitted only while
    // one response is actively awaited. Reject even an unterminated chunk
    // received between requests so it cannot be prefixed to a later frame.
    if (!this.#waiter) {
      if (this.#wipeChunks) bytes.fill(0);
      this.#fail(protocolError());
      return;
    }
    if (
      this.#waiter.deadlineAtMs !== undefined &&
      Date.now() >= this.#waiter.deadlineAtMs
    ) {
      if (this.#wipeChunks) bytes.fill(0);
      this.#fail(timeoutError());
      return;
    }
    if (this.#buffer.byteLength + bytes.byteLength > this.#maxFrameBytes + 1) {
      if (this.#wipeChunks) bytes.fill(0);
      this.#fail(protocolError());
      return;
    }
    const previous = this.#buffer;
    this.#buffer = Buffer.concat([previous, bytes]);
    if (this.#wipeChunks) {
      previous.fill(0);
      bytes.fill(0);
    }

    for (;;) {
      const newline = this.#buffer.indexOf(0x0a);
      if (newline === -1) break;
      if (newline === 0 || newline > this.#maxFrameBytes || !this.#waiter) {
        this.#fail(protocolError());
        return;
      }
      const raw = this.#buffer.subarray(0, newline);
      this.#buffer = this.#buffer.subarray(newline + 1);
      const waiter = this.#waiter;
      this.#waiter = undefined;
      clearTimeout(waiter.timeout);
      try {
        if (raw[raw.byteLength - 1] === 0x0d) throw protocolError();
        // Private response frames can contain bounded excerpts. Re-check the
        // absolute generation deadline immediately before decoding so a host
        // that resumes after suspend clears bytes instead of materializing a
        // stale excerpt-bearing body.
        if (
          waiter.deadlineAtMs !== undefined &&
          Date.now() >= waiter.deadlineAtMs
        ) {
          throw timeoutError();
        }
        const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
        if (
          waiter.deadlineAtMs !== undefined &&
          Date.now() >= waiter.deadlineAtMs
        ) {
          throw timeoutError();
        }
        const frame = JSON.parse(text) as unknown;
        if (
          waiter.deadlineAtMs !== undefined &&
          Date.now() >= waiter.deadlineAtMs
        ) {
          throw timeoutError();
        }
        if (!asRecord(frame)) throw protocolError();
        // The collector protocol is serialized: one request permits exactly
        // one frame on this stream. Even an unterminated suffix is therefore
        // unsolicited output, not a legitimate partial next response.
        if (this.#buffer.byteLength !== 0) throw protocolError();
        waiter.resolve(frame);
      } catch (error) {
        const safeError =
          error instanceof OnboardingCollectorHostError
            ? error
            : protocolError();
        waiter.reject(safeError);
        this.#fail(safeError);
        return;
      } finally {
        raw.fill(0);
      }
    }

    if (this.#buffer.byteLength > this.#maxFrameBytes)
      this.#fail(protocolError());
  }

  #finish(): void {
    if (this.#ended) return;
    this.#ended = true;
    if (!this.#closedByHost && this.#buffer.byteLength !== 0) {
      this.#fail(protocolError());
      return;
    }
    this.#buffer.fill(0);
    this.#buffer = Buffer.alloc(0);
    if (this.#waiter) {
      const waiter = this.#waiter;
      this.#waiter = undefined;
      clearTimeout(waiter.timeout);
      waiter.reject(protocolError());
    }
    for (const waiter of this.#endWaiters.splice(0)) {
      clearTimeout(waiter.timeout);
      waiter.resolve();
    }
  }

  #fail(error: Error): void {
    if (this.#failure) return;
    this.#failure = error;
    this.#buffer.fill(0);
    this.#buffer = Buffer.alloc(0);
    if (this.#waiter) {
      const waiter = this.#waiter;
      this.#waiter = undefined;
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    for (const waiter of this.#endWaiters.splice(0)) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.#onFatal(error);
    this.#stream.destroy();
  }
}

interface WindowsPrivateListener {
  server: Server;
  pipeName: string;
  connection: Promise<Socket>;
  markSpawnStarted(): void;
  setViolationHandler(handler: (error: Error) => void): void;
}

async function listenOnPrivatePipe(): Promise<WindowsPrivateListener> {
  const transport =
    ONBOARDING_COLLECTOR_PRIVATE_OUTPUT_TRANSPORTS.windows_named_pipe;
  const suffix = randomBytes(transport.randomSuffixHexLength / 2).toString(
    "hex",
  );
  const pipeName = `${transport.pipeNamePrefix}${suffix}`;
  if (!new RegExp(transport.pipeNamePattern).test(pipeName))
    throw protocolError();

  const server = createServer({ allowHalfOpen: false, pauseOnConnect: true });
  let spawnStarted = false;
  let accepted = false;
  let settled = false;
  let violationHandler: (error: Error) => void = () => undefined;
  let resolveSocket!: (socket: Socket) => void;
  let rejectSocket!: (error: Error) => void;
  const connection = new Promise<Socket>(
    (resolveConnection, rejectConnection) => {
      resolveSocket = resolveConnection;
      rejectSocket = rejectConnection;
    },
  );
  // The listen phase can fail before the caller starts awaiting `connection`.
  // Attach a rejection observer immediately while preserving the same promise
  // for the startup barrier below.
  void connection.catch(() => undefined);
  const violate = (): void => {
    const error = protocolError();
    if (!settled) {
      settled = true;
      rejectSocket(error);
    }
    violationHandler(error);
  };
  server.on("connection", (socket) => {
    if (!spawnStarted || accepted) {
      socket.destroy();
      violate();
      return;
    }
    accepted = true;
    settled = true;
    socket.pause();
    resolveSocket(socket);
    server.close();
  });
  server.on("error", () => violate());

  try {
    await waitWithTimeout(
      new Promise<void>((resolveListen, rejectListen) => {
        const onError = (): void => rejectListen(protocolError());
        server.once("error", onError);
        server.listen(
          {
            path: pipeName,
            backlog: 1,
            exclusive: true,
            readableAll: false,
            writableAll: false,
          },
          () => {
            server.off("error", onError);
            resolveListen();
          },
        );
      }),
      PIPE_LISTEN_TIMEOUT_MS,
    );
  } catch {
    await closeServer(server);
    throw protocolError();
  }
  return {
    server,
    pipeName,
    connection,
    markSpawnStarted: () => {
      spawnStarted = true;
    },
    setViolationHandler: (handler) => {
      violationHandler = handler;
    },
  };
}

class CollectorRuntime {
  readonly child: ChildProcess;
  readonly input: Writable;
  readonly exit: Promise<ProcessExit>;
  readonly stageDirectory: string;
  privateServer: Server | undefined;
  privateStream: Readable | undefined;
  failure: Error | undefined;
  #cleanup: Promise<void> | undefined;

  constructor(
    child: ChildProcess,
    input: Writable,
    stageDirectory: string,
    privateServer?: Server,
  ) {
    this.child = child;
    this.input = input;
    this.stageDirectory = stageDirectory;
    this.privateServer = privateServer;
    let spawnFailed = false;
    this.exit = new Promise<ProcessExit>((resolveExit) => {
      child.once("error", () => {
        spawnFailed = true;
      });
      child.once("close", (code, signal) =>
        resolveExit({ code, signal, spawnFailed }),
      );
    });
  }

  isRunning(): boolean {
    return (
      this.child.exitCode === null &&
      this.child.signalCode === null &&
      !this.failure
    );
  }

  setPrivateStream(stream: Readable): void {
    this.privateStream = stream;
  }

  fail(error: Error): void {
    if (!this.failure) this.failure = error;
    void this.hardStop().catch(() => undefined);
  }

  throwIfFailed(): void {
    if (this.failure) throw this.failure;
  }

  async hardStop(): Promise<void> {
    if (this.#cleanup) return await this.#cleanup;
    this.#cleanup = (async () => {
      this.input.destroy();
      this.privateStream?.destroy();
      await closeServer(this.privateServer);
      if (this.child.exitCode === null && this.child.signalCode === null)
        this.child.kill("SIGTERM");
      let exited = false;
      await Promise.race([
        this.exit.then(() => {
          exited = true;
        }),
        delay(KILL_GRACE_MS),
      ]);
      if (
        !exited &&
        this.child.exitCode === null &&
        this.child.signalCode === null
      ) {
        this.child.kill("SIGKILL");
        await Promise.race([
          this.exit.then(() => undefined),
          delay(KILL_GRACE_MS),
        ]);
      }
      await removeStageDirectory(this.stageDirectory);
    })();
    return await this.#cleanup;
  }

  async releaseAfterCleanExit(): Promise<void> {
    if (this.#cleanup) return await this.#cleanup;
    this.#cleanup = (async () => {
      this.input.destroy();
      this.privateStream?.destroy();
      await closeServer(this.privateServer);
      await removeStageDirectory(this.stageDirectory);
    })();
    return await this.#cleanup;
  }
}

class NativeCollectorSession implements OnboardingCollectorSession {
  readonly #runtime: CollectorRuntime;
  readonly #publicFrames: BoundedJsonlReader;
  readonly #privateFrames: BoundedJsonlReader;
  readonly #launchDirectory: string;
  readonly #signal: AbortSignal | undefined;
  readonly #abortListener: (() => void) | undefined;
  readonly #deadlineAtMs: number;
  readonly #deadlineTimer: NodeJS.Timeout;
  readonly #termination: Promise<OnboardingCollectorTermination>;
  readonly #resolveTermination: (
    termination: OnboardingCollectorTermination,
  ) => void;
  #state:
    | "opened"
    | "inspected"
    | "prepared"
    | "closing"
    | "closed"
    | "expired"
    | "failed" = "opened";
  #operationActive = false;
  #terminationPublished = false;
  #latestInspection: InspectionResponse | undefined;
  #latestPrepared: OnboardingPreparedCodebaseArtifact | undefined;

  constructor(
    runtime: CollectorRuntime,
    publicFrames: BoundedJsonlReader,
    privateFrames: BoundedJsonlReader,
    launchDirectory: string,
    options: OpenOnboardingCollectorOptions,
  ) {
    this.#runtime = runtime;
    this.#publicFrames = publicFrames;
    this.#privateFrames = privateFrames;
    this.#launchDirectory = launchDirectory;
    this.#signal = options.signal;
    let resolveTermination:
      | ((termination: OnboardingCollectorTermination) => void)
      | undefined;
    this.#termination = new Promise<OnboardingCollectorTermination>(
      (resolveValue) => {
        resolveTermination = resolveValue;
      },
    );
    this.#resolveTermination = (termination) =>
      resolveTermination?.(termination);
    this.#abortListener = options.signal
      ? () => {
          this.abort();
        }
      : undefined;
    const requestedDeadline = options.deadlineAtMs ?? Number.POSITIVE_INFINITY;
    const deadlineAt = Math.min(Date.now() + SESSION_MAX_MS, requestedDeadline);
    this.#deadlineAtMs = deadlineAt;
    const remaining = Math.max(0, deadlineAt - Date.now());
    this.#deadlineTimer = setTimeout(() => {
      if (
        !this.#operationActive &&
        this.#state !== "closing" &&
        this.#state !== "closed" &&
        this.#state !== "expired" &&
        this.#state !== "failed"
      ) {
        const error = timeoutError();
        const cleanup = this.cancel().then(
          (result) => {
            this.#state = "expired";
            return result;
          },
          async () => {
            this.#state = "expired";
            await this.#runtime.hardStop();
            return null;
          },
        );
        this.#publishTermination({ reason: "expired", error, cleanup });
      } else {
        this.#fail(timeoutError(), "expired");
      }
    }, remaining);
    this.#deadlineTimer.unref?.();

    if (this.#abortListener) {
      options.signal?.addEventListener("abort", this.#abortListener, {
        once: true,
      });
      if (options.signal?.aborted) {
        this.abort();
        throw failedError();
      }
    }

    void runtime.exit.then(() => {
      if (
        this.#state !== "closing" &&
        this.#state !== "closed" &&
        this.#state !== "expired" &&
        this.#state !== "failed"
      ) {
        this.#state = "failed";
        this.#latestPrepared = undefined;
        this.#latestInspection = undefined;
        this.#clearLifecycleHooks();
        const cleanup = runtime
          .releaseAfterCleanExit()
          .then(() => null as CleanupResult | null);
        this.#publishTermination({
          reason: "failed",
          error: failedError(),
          cleanup,
        });
      }
    });
  }

  waitForTermination(): Promise<OnboardingCollectorTermination> {
    return this.#termination;
  }

  get deadlineAtMs(): number {
    return this.#deadlineAtMs;
  }

  transportFailed(error: Error): void {
    const expired =
      error instanceof OnboardingCollectorHostError &&
      error.supportCode === "ONBOARD_COLLECTOR_TIMEOUT" &&
      Date.now() >= this.#deadlineAtMs;
    this.#fail(error, expired ? "expired" : "failed");
  }

  async inspect(
    input: {
      root?: string;
      selectedCandidateId?: string;
    } = {},
  ): Promise<InspectionResponse> {
    return await this.#exclusive(async () => {
      this.#requireBeforeDeadline();
      this.#requireState("opened");
      const root = resolve(this.#launchDirectory, input.root ?? ".");
      const request = OnboardingCollectorRequestSchema.parse({
        type: "inspect",
        root,
        ...(input.selectedCandidateId !== undefined
          ? { selectedCandidateId: input.selectedCandidateId }
          : {}),
      });
      const response = await this.#requestInspection(
        request,
        INSPECTION_TIMEOUT_MS,
      );
      this.#latestInspection = response;
      this.#state = "inspected";
      return response;
    });
  }

  async select(selectedCandidateId: string): Promise<InspectionResponse> {
    return await this.#exclusive(async () => {
      this.#requireBeforeDeadline();
      this.#requireState("inspected");
      const request = OnboardingCollectorRequestSchema.parse({
        type: "select",
        selectedCandidateId,
      });
      const response = await this.#requestInspection(
        request,
        SELECT_TIMEOUT_MS,
      );
      this.#latestInspection = response;
      return response;
    });
  }

  async reinspect(input: {
    excludedPathIds: string[];
    excludedTargetIds: string[];
    selectedTargetIds: string[];
  }): Promise<InspectionResponse> {
    return await this.#exclusive(async () => {
      this.#requireBeforeDeadline();
      this.#requireOneOfStates("inspected", "prepared");
      // A displayed proposal may be corrected. Its private artifact is no
      // longer eligible for approval once a reinspection starts; retain only
      // the fresh artifact produced by the next prepare operation.
      this.#latestPrepared = undefined;
      const request = OnboardingCollectorRequestSchema.parse({
        type: "reinspect",
        ...input,
      });
      const response = await this.#requestInspection(
        request,
        INSPECTION_TIMEOUT_MS,
      );
      this.#latestInspection = response;
      this.#state = "inspected";
      return response;
    });
  }

  async prepare(): Promise<OnboardingPreparedCodebaseArtifact> {
    return await this.#exclusive(async () => {
      this.#requireBeforeDeadline();
      this.#requireOneOfStates("inspected", "prepared");
      if (this.#latestInspection?.projection.status !== "ready") {
        throw protocolError();
      }
      // Repeated preparation replaces, rather than accumulates, the host's
      // parsed reference. Raw private frame bytes are zeroed by the reader.
      this.#latestPrepared = undefined;
      const request = OnboardingCollectorRequestSchema.parse({
        type: "prepare",
      });
      const publicFrame = this.#publicFrames.next(
        PREPARE_TIMEOUT_MS,
        this.#deadlineAtMs,
      );
      const privateFrame = this.#privateFrames.next(
        PREPARE_TIMEOUT_MS,
        this.#deadlineAtMs,
      );
      const [, publicValue, privateValue] = await Promise.all([
        this.#send(request),
        publicFrame,
        privateFrame,
      ]);
      this.#requireBeforeDeadline();
      const publicResponse =
        OnboardingCollectorResponseSchema.parse(publicValue);
      const privateResponse: OnboardingCollectorPrivateResponse =
        OnboardingCollectorPrivateResponseSchema.parse(privateValue);
      this.#publicFrames.assertOpen();
      this.#privateFrames.assertOpen();
      if (
        publicResponse.type !== "prepared" ||
        privateResponse.type !== "prepared_artifact" ||
        !this.#runtime.isRunning()
      ) {
        throw protocolError();
      }
      this.#state = "prepared";
      this.#latestPrepared = privateResponse.preparedArtifact;
      return this.#latestPrepared;
    });
  }

  async complete(): Promise<CleanupResult> {
    this.#requireBeforeDeadline();
    this.#requireState("prepared");
    return await this.#cleanup("complete");
  }

  async cancel(): Promise<CleanupResult> {
    if (
      this.#state === "closed" ||
      this.#state === "expired" ||
      this.#state === "failed" ||
      this.#state === "closing"
    ) {
      throw protocolError();
    }
    return await this.#cleanup("cancel");
  }

  abort(): void {
    if (
      this.#state === "closed" ||
      this.#state === "expired" ||
      this.#state === "failed"
    )
      return;
    this.#fail(failedError());
  }

  async #requestInspection(
    request: OnboardingCollectorRequest,
    timeoutMs: number,
  ): Promise<InspectionResponse> {
    const responseFrame = this.#publicFrames.next(
      timeoutMs,
      this.#deadlineAtMs,
    );
    const [, value] = await Promise.all([this.#send(request), responseFrame]);
    const response = OnboardingCollectorResponseSchema.parse(value);
    this.#publicFrames.assertOpen();
    this.#privateFrames.assertOpen();
    this.#runtime.throwIfFailed();
    if (response.type !== "inspection" || !this.#runtime.isRunning())
      throw protocolError();
    return response;
  }

  async #cleanup(operation: "cancel" | "complete"): Promise<CleanupResult> {
    return await this.#exclusive(async () => {
      if (operation === "complete") this.#requireState("prepared");
      const cleanupDeadlineAt = Date.now() + CLEANUP_TIMEOUT_MS;
      const request = OnboardingCollectorRequestSchema.parse({
        type: operation,
      });
      const responseFrame = this.#publicFrames.next(CLEANUP_TIMEOUT_MS);
      this.#state = "closing";
      const [, value] = await Promise.all([this.#send(request), responseFrame]);
      this.#runtime.input.end();
      const response = OnboardingCollectorResponseSchema.parse(value);
      const expected = operation === "cancel" ? "canceled" : "completed";
      if (response.type !== expected) throw protocolError();

      const remaining = cleanupDeadlineAt - Date.now();
      if (remaining <= 0) throw timeoutError();
      const waits: Promise<unknown>[] = [
        waitWithTimeout(this.#runtime.exit, remaining),
        this.#publicFrames.waitForEnd(remaining),
        this.#privateFrames.waitForEnd(remaining),
      ];
      const [exit] = (await Promise.all(waits)) as [ProcessExit, ...unknown[]];
      if (exit.code !== 0 || exit.signal !== null || exit.spawnFailed)
        throw failedError();
      this.#publicFrames.assertHealthy();
      this.#privateFrames.assertHealthy();
      await this.#runtime.releaseAfterCleanExit();
      this.#latestPrepared = undefined;
      this.#state = "closed";
      this.#clearLifecycleHooks();
      return response.cleanup;
    });
  }

  async #send(request: OnboardingCollectorRequest): Promise<void> {
    this.#runtime.throwIfFailed();
    const payload = JSON.stringify(request);
    if (
      Buffer.byteLength(payload, "utf8") >
      ONBOARDING_COLLECTOR_MAX_REQUEST_BYTES
    ) {
      throw protocolError();
    }
    await new Promise<void>((resolveWrite, rejectWrite) => {
      this.#runtime.input.write(`${payload}\n`, "utf8", (error) => {
        if (error) rejectWrite(protocolError());
        else resolveWrite();
      });
    });
  }

  #requireState(expected: "opened" | "inspected" | "prepared"): void {
    if (this.#state !== expected) throw protocolError();
  }

  #requireOneOfStates(
    first: "opened" | "inspected" | "prepared",
    second: "opened" | "inspected" | "prepared",
  ): void {
    if (this.#state !== first && this.#state !== second) throw protocolError();
  }

  #requireBeforeDeadline(): void {
    if (Date.now() < this.#deadlineAtMs) return;
    const error = timeoutError();
    this.#fail(error, "expired");
    throw error;
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#operationActive) throw protocolError();
    this.#operationActive = true;
    try {
      this.#runtime.throwIfFailed();
      return await operation();
    } catch (error) {
      const safeError =
        error instanceof OnboardingCollectorHostError ? error : protocolError();
      this.#fail(safeError);
      await this.#runtime.hardStop().catch(() => undefined);
      throw safeError;
    } finally {
      this.#operationActive = false;
    }
  }

  #fail(
    error: Error,
    reason: OnboardingCollectorTermination["reason"] = "failed",
  ): void {
    if (
      this.#state === "closed" ||
      this.#state === "expired" ||
      this.#state === "failed" ||
      (this.#state === "closing" && this.#terminationPublished)
    )
      return;
    this.#state = reason === "expired" ? "expired" : "failed";
    this.#latestPrepared = undefined;
    this.#latestInspection = undefined;
    this.#clearLifecycleHooks();
    this.#runtime.fail(error);
    const safeError =
      error instanceof OnboardingCollectorHostError ? error : failedError();
    this.#publishTermination({
      reason,
      error: safeError,
      cleanup: this.#runtime
        .hardStop()
        .then(() => null as CleanupResult | null),
    });
  }

  #publishTermination(termination: OnboardingCollectorTermination): void {
    if (this.#terminationPublished) return;
    this.#terminationPublished = true;
    this.#latestPrepared = undefined;
    this.#latestInspection = undefined;
    this.#resolveTermination(termination);
  }

  #clearLifecycleHooks(): void {
    clearTimeout(this.#deadlineTimer);
    if (this.#abortListener)
      this.#signal?.removeEventListener("abort", this.#abortListener);
  }
}

export async function openOnboardingCollector(
  options: OpenOnboardingCollectorOptions = {},
): Promise<OnboardingCollectorSession> {
  const launchDirectory = process.cwd();
  const openedAtMs = Date.now();
  if (options.signal?.aborted) throw failedError();
  if (
    options.deadlineAtMs !== undefined &&
    (!Number.isFinite(options.deadlineAtMs) ||
      options.deadlineAtMs <= Date.now())
  ) {
    throw timeoutError();
  }
  const sessionDeadlineAtMs = Math.min(
    openedAtMs + SESSION_MAX_MS,
    options.deadlineAtMs ?? Number.POSITIVE_INFINITY,
  );

  const verified = await verifyCollectorInstallation(false);
  let staged: StagedCollector | undefined;
  let listener: WindowsPrivateListener | undefined;
  let runtime: CollectorRuntime | undefined;
  let publicFrames: BoundedJsonlReader | undefined;
  let privateFrames: BoundedJsonlReader | undefined;
  let session: NativeCollectorSession | undefined;
  try {
    staged = await stageCollector(verified);
    if (verified.target.privateOutputTransport === "windows_named_pipe") {
      listener = await listenOnPrivatePipe();
    }
    if (options.signal?.aborted) throw failedError();
    if (sessionDeadlineAtMs <= Date.now()) throw timeoutError();

    listener?.markSpawnStarted();
    const child = spawn(staged.binaryPath, [], {
      cwd: staged.directory,
      detached: false,
      env: childEnvironment(staged.directory, listener?.pipeName),
      shell: false,
      stdio:
        verified.target.privateOutputTransport === "windows_named_pipe"
          ? ["pipe", "pipe", "pipe"]
          : ["pipe", "pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const input = child.stdin;
    const output = child.stdout;
    const stderr = child.stderr;
    const unixPrivate =
      verified.target.privateOutputTransport === "unix_fd"
        ? child.stdio[3]
        : undefined;
    if (
      !input ||
      !output ||
      !stderr ||
      (verified.target.privateOutputTransport === "unix_fd" && !unixPrivate)
    ) {
      child.kill("SIGKILL");
      throw protocolError();
    }

    runtime = new CollectorRuntime(
      child,
      input,
      staged.directory,
      listener?.server,
    );
    listener?.setViolationHandler((error) => runtime?.fail(error));
    let stderrBytes = 0;
    stderr.on("data", (chunk: Buffer | string) => {
      stderrBytes += Buffer.isBuffer(chunk)
        ? chunk.byteLength
        : Buffer.byteLength(chunk, "utf8");
      if (Buffer.isBuffer(chunk)) chunk.fill(0);
      if (stderrBytes > STDERR_MAX_BYTES) runtime?.fail(protocolError());
    });

    const onFatal = (error: Error): void => {
      runtime?.fail(error);
      session?.transportFailed(error);
    };
    publicFrames = new BoundedJsonlReader(
      output,
      INBOUND_FRAME_MAX_BYTES,
      onFatal,
    );
    const handshakeFrame = publicFrames.next(HANDSHAKE_TIMEOUT_MS);

    let privateStream: Readable;
    if (listener) {
      const [handshakeValue, socket] = await Promise.all([
        handshakeFrame,
        waitWithTimeout(listener.connection, PIPE_CONNECT_TIMEOUT_MS),
      ]);
      runtime.setPrivateStream(socket);
      privateStream = socket;
      privateFrames = new BoundedJsonlReader(
        privateStream,
        INBOUND_FRAME_MAX_BYTES,
        onFatal,
        true,
      );
      socket.resume();
      const handshake =
        OnboardingCollectorHandshakeSchema.parse(handshakeValue);
      publicFrames.assertOpen();
      runtime.throwIfFailed();
      if (!handshakeMatches(handshake, verified.integrity))
        throw integrityError();
    } else {
      privateStream = unixPrivate as Readable;
      runtime.setPrivateStream(privateStream);
      privateFrames = new BoundedJsonlReader(
        privateStream,
        INBOUND_FRAME_MAX_BYTES,
        onFatal,
        true,
      );
      const handshake = OnboardingCollectorHandshakeSchema.parse(
        await handshakeFrame,
      );
      publicFrames.assertOpen();
      runtime.throwIfFailed();
      if (!handshakeMatches(handshake, verified.integrity))
        throw integrityError();
    }
    privateFrames.assertOpen();
    if (options.signal?.aborted) throw failedError();
    if (sessionDeadlineAtMs <= Date.now()) throw timeoutError();

    session = new NativeCollectorSession(
      runtime,
      publicFrames,
      privateFrames,
      launchDirectory,
      { ...options, deadlineAtMs: sessionDeadlineAtMs },
    );
    return session;
  } catch (error) {
    publicFrames?.closeByHost();
    privateFrames?.closeByHost();
    if (runtime) {
      await runtime.hardStop().catch(() => undefined);
    } else {
      await closeServer(listener?.server).catch(() => undefined);
      if (staged)
        await removeStageDirectory(staged.directory).catch(() => undefined);
    }
    if (error instanceof OnboardingCollectorHostError) throw error;
    throw protocolError();
  } finally {
    verified.binary.fill(0);
  }
}

export type SourceInspection = OnboardingSourceInspection;
