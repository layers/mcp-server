import { createHash, randomBytes } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { arch, platform } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  OnboardingCollectorCleanupResultSchema,
  OnboardingCollectorHandshakeSchema,
  OnboardingCollectorPrivateResponseSchema,
  OnboardingCollectorRequestSchema,
  OnboardingCollectorResponseSchema,
  type OnboardingCollectorHandshake,
  type OnboardingCollectorPrivateResponse,
  type OnboardingCollectorRequest,
  type OnboardingCollectorResponse,
  type OnboardingPreparedCodebaseArtifact,
  type OnboardingSourceInspection,
} from "@layers/onboarding-contracts";
import { z } from "zod";

const require = createRequire(import.meta.url);

const CONTROL_LINE_LIMIT_BYTES = 2 * 1024 * 1024;
const PRIVATE_LINE_LIMIT_BYTES = 2 * 1024 * 1024;
const COLLECTOR_START_TIMEOUT_MS = 10_000;
const COLLECTOR_OPERATION_TIMEOUT_MS = 30_000;
const WINDOWS_PIPE_PREFIX = "\\\\.\\pipe\\layers-onboarding-collector-";

const COLLECTOR_PACKAGES = {
  "darwin-arm64": "@layers/onboarding-collector-darwin-arm64",
  "darwin-x64": "@layers/onboarding-collector-darwin-x64",
  "linux-arm64": "@layers/onboarding-collector-linux-arm64",
  "linux-x64": "@layers/onboarding-collector-linux-x64",
  "win32-arm64": "@layers/onboarding-collector-win32-arm64",
  "win32-x64": "@layers/onboarding-collector-win32-x64",
} as const;

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const VersionSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/);

const CollectorIntegritySchema = z
  .object({
    schemaVersion: z.literal(1),
    packageName: z.enum(Object.values(COLLECTOR_PACKAGES)),
    packageVersion: VersionSchema,
    platform: z.enum(["darwin", "linux", "win32"]),
    arch: z.enum(["arm64", "x64"]),
    binaryPath: z.enum([
      "bin/layers-onboarding-collector",
      "bin/layers-onboarding-collector.exe",
    ]),
    binaryBytes: z.number().int().positive(),
    binarySha256: Sha256Schema,
    collectorVersion: VersionSchema,
    collectorProtocolVersion: z.literal(1),
    sourceInspectionSchemaVersion: z.literal(1),
    codebaseDigestSchemaVersion: z.literal(1),
    preparedSchemaVersion: z.literal(1),
    contractArtifactVersion: VersionSchema,
    contractManifestSha256: Sha256Schema,
    collectionPolicyVersion: VersionSchema,
    collectionPolicySha256: Sha256Schema,
  })
  .strict();

const ContractManifestSchema = z
  .object({
    artifactName: z.literal("@layers/onboarding-contracts"),
    artifactVersion: VersionSchema,
    protocolVersion: z.literal(1),
    collectorProtocolVersion: z.literal(1),
    sourceInspectionSchemaVersion: z.literal(1),
    codebaseDigestSchemaVersion: z.literal(1),
    evidenceSchemaVersion: z.literal(1),
    collectionPolicyVersion: VersionSchema,
    collectionPolicySha256: Sha256Schema,
  })
  .loose();

export class OnboardingCollectorUnavailableError extends Error {
  readonly supportCode = "ONBOARD_COLLECTOR_UNAVAILABLE";

  constructor(message = "The Layers source collector is unavailable on this platform.") {
    super(message);
    this.name = "OnboardingCollectorUnavailableError";
  }
}

export class OnboardingCollectorProtocolError extends Error {
  readonly supportCode = "ONBOARD_COLLECTOR_PROTOCOL";

  constructor(message = "The Layers source collector stopped safely.") {
    super(message);
    this.name = "OnboardingCollectorProtocolError";
  }
}

type CollectorIntegrity = z.infer<typeof CollectorIntegritySchema>;

interface ResolvedCollector {
  binaryPath: string;
  integrity: CollectorIntegrity;
  contractManifest: z.infer<typeof ContractManifestSchema>;
}

function sha256File(path: string): string {
  const hash = createHash("sha256");
  const bytes = readFileSync(path);
  try {
    hash.update(bytes);
    return hash.digest("hex");
  } finally {
    bytes.fill(0);
  }
}

function safeChildPath(root: string, relativePath: string): string {
  const absolute = resolve(root, relativePath);
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (!absolute.startsWith(prefix)) {
    throw new OnboardingCollectorUnavailableError();
  }
  return absolute;
}

function currentCollectorPackage(): string {
  const key = `${platform()}-${arch()}` as keyof typeof COLLECTOR_PACKAGES;
  const packageName = COLLECTOR_PACKAGES[key];
  if (!packageName) throw new OnboardingCollectorUnavailableError();
  return packageName;
}

function readPackageVersion(packageRoot: string): string {
  const parsed = z
    .object({ version: VersionSchema })
    .loose()
    .parse(JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")));
  return parsed.version;
}

function resolveCollector(): ResolvedCollector {
  const packageName = currentCollectorPackage();
  let packageJsonPath: string;
  let integrityPath: string;
  let contractManifestPath: string;
  try {
    packageJsonPath = require.resolve(`${packageName}/package.json`);
    integrityPath = require.resolve(`${packageName}/integrity.json`);
    contractManifestPath = require.resolve("@layers/onboarding-contracts/manifest.json");
  } catch {
    throw new OnboardingCollectorUnavailableError(
      `The Layers source collector for ${platform()}-${arch()} is not installed.`,
    );
  }

  const packageRoot = dirname(packageJsonPath);
  const integrity = CollectorIntegritySchema.parse(
    JSON.parse(readFileSync(integrityPath, "utf8")),
  );
  const contractManifest = ContractManifestSchema.parse(
    JSON.parse(readFileSync(contractManifestPath, "utf8")),
  );
  const binaryPath = safeChildPath(packageRoot, integrity.binaryPath);
  const packageRealRoot = realpathSync(packageRoot);
  const binaryStat = lstatSync(binaryPath, { throwIfNoEntry: false });
  const binaryRealPath = binaryStat ? realpathSync(binaryPath) : "";
  const packageRealPrefix = packageRealRoot.endsWith(sep)
    ? packageRealRoot
    : `${packageRealRoot}${sep}`;
  const expectedBinaryName = platform() === "win32"
    ? "bin/layers-onboarding-collector.exe"
    : "bin/layers-onboarding-collector";
  const packageVersion = readPackageVersion(packageRoot);
  const contractManifestSha256 = sha256File(contractManifestPath);

  if (
    integrity.packageName !== packageName ||
    integrity.packageVersion !== packageVersion ||
    integrity.platform !== platform() ||
    integrity.arch !== arch() ||
    integrity.binaryPath !== expectedBinaryName ||
    !binaryStat?.isFile() ||
    !binaryRealPath.startsWith(packageRealPrefix) ||
    binaryStat.size !== integrity.binaryBytes ||
    sha256File(binaryPath) !== integrity.binarySha256 ||
    integrity.contractArtifactVersion !== contractManifest.artifactVersion ||
    integrity.contractManifestSha256 !== contractManifestSha256 ||
    integrity.collectionPolicyVersion !== contractManifest.collectionPolicyVersion ||
    integrity.collectionPolicySha256 !== contractManifest.collectionPolicySha256 ||
    integrity.collectorProtocolVersion !== contractManifest.collectorProtocolVersion ||
    integrity.sourceInspectionSchemaVersion !==
      contractManifest.sourceInspectionSchemaVersion ||
    integrity.codebaseDigestSchemaVersion !== contractManifest.codebaseDigestSchemaVersion
  ) {
    throw new OnboardingCollectorUnavailableError(
      "The installed Layers source collector failed its integrity check.",
    );
  }

  return { binaryPath, integrity, contractManifest };
}

class JsonLineChannel {
  #buffer = Buffer.alloc(0);
  #ended = false;
  #failure: Error | null = null;
  #values: unknown[] = [];
  #waiters: Array<{
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  constructor(stream: Readable, private readonly maximumLineBytes: number) {
    stream.on("data", (chunk: Buffer | string) => this.#onData(chunk));
    stream.once("end", () => this.#finish(new OnboardingCollectorProtocolError()));
    stream.once("error", () => this.#finish(new OnboardingCollectorProtocolError()));
  }

  next(timeoutMs = COLLECTOR_OPERATION_TIMEOUT_MS): Promise<unknown> {
    if (this.#values.length > 0) return Promise.resolve(this.#values.shift());
    if (this.#failure) return Promise.reject(this.#failure);
    if (this.#ended) return Promise.reject(new OnboardingCollectorProtocolError());

    return new Promise((resolveValue, rejectValue) => {
      const waiter = {
        resolve: resolveValue,
        reject: rejectValue,
        timer: setTimeout(() => {
          const index = this.#waiters.indexOf(waiter);
          if (index !== -1) this.#waiters.splice(index, 1);
          rejectValue(new OnboardingCollectorProtocolError("The Layers source collector timed out."));
        }, timeoutMs),
      };
      this.#waiters.push(waiter);
    });
  }

  fail(error = new OnboardingCollectorProtocolError()): void {
    this.#finish(error);
  }

  #onData(chunk: Buffer | string): void {
    if (this.#ended) return;
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.#buffer = Buffer.concat([this.#buffer, next]);
    if (this.#buffer.length > this.maximumLineBytes && this.#buffer.indexOf(0x0a) === -1) {
      this.#finish(new OnboardingCollectorProtocolError());
      return;
    }

    while (true) {
      const newline = this.#buffer.indexOf(0x0a);
      if (newline === -1) break;
      const line = this.#buffer.subarray(0, newline);
      this.#buffer = this.#buffer.subarray(newline + 1);
      if (line.length === 0 || line.length > this.maximumLineBytes) {
        this.#finish(new OnboardingCollectorProtocolError());
        return;
      }

      let value: unknown;
      try {
        value = JSON.parse(line.toString("utf8"));
      } catch {
        this.#finish(new OnboardingCollectorProtocolError());
        return;
      } finally {
        line.fill(0);
      }

      const waiter = this.#waiters.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(value);
      } else {
        this.#values.push(value);
      }
    }
  }

  #finish(error: Error): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#failure = error;
    this.#buffer.fill(0);
    this.#buffer = Buffer.alloc(0);
    for (const waiter of this.#waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}

interface PrivateTransport {
  env: NodeJS.ProcessEnv;
  stdio: Array<"pipe" | "ignore">;
  start(): Promise<void>;
  stream(child: ChildProcess): Promise<Readable>;
  close(): Promise<void>;
}

function unixPrivateTransport(): PrivateTransport {
  return {
    env: {},
    stdio: ["pipe", "pipe", "pipe", "pipe"],
    async start() {},
    async stream(child) {
      const privateStream = child.stdio[3];
      if (!(privateStream instanceof Readable)) throw new OnboardingCollectorProtocolError();
      return privateStream;
    },
    async close() {},
  };
}

function windowsPrivateTransport(): PrivateTransport {
  const pipeName = `${WINDOWS_PIPE_PREFIX}${randomBytes(16).toString("hex")}`;
  let server: Server | null = null;
  let socketPromise: Promise<Socket> | null = null;

  return {
    env: { LAYERS_ONBOARDING_PRIVATE_PIPE: pipeName },
    stdio: ["pipe", "pipe", "pipe", "ignore"],
    async start() {
      server = createServer({ pauseOnConnect: true });
      server.maxConnections = 1;
      socketPromise = new Promise((resolveSocket, rejectSocket) => {
        server!.once("connection", (socket) => {
          socket.resume();
          resolveSocket(socket);
        });
        server!.once("error", () => rejectSocket(new OnboardingCollectorProtocolError()));
      });
      await new Promise<void>((resolveListen, rejectListen) => {
        server!.listen({ path: pipeName, readableAll: false, writableAll: false }, resolveListen);
        server!.once("error", () => rejectListen(new OnboardingCollectorProtocolError()));
      });
    },
    async stream() {
      if (!socketPromise) throw new OnboardingCollectorProtocolError();
      return Promise.race([
        socketPromise,
        new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new OnboardingCollectorProtocolError("The Layers source collector timed out.")),
            COLLECTOR_START_TIMEOUT_MS,
          );
        }),
      ]);
    },
    async close() {
      if (!server) return;
      await new Promise<void>((resolveClose) => server!.close(() => resolveClose()));
      server = null;
    },
  };
}

function privateTransport(): PrivateTransport {
  if (platform() === "win32") return windowsPrivateTransport();
  if (["aix", "darwin", "freebsd", "linux", "netbsd", "openbsd", "sunos"].includes(platform())) {
    return unixPrivateTransport();
  }
  throw new OnboardingCollectorUnavailableError();
}

function collectorEnvironment(privateEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {
    GCM_INTERACTIVE: "never",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    ...privateEnv,
  };
  if (platform() === "win32") {
    childEnv.Path = process.env.Path ?? process.env.PATH;
    childEnv.SystemRoot = process.env.SystemRoot;
    childEnv.ComSpec = process.env.ComSpec;
    childEnv.PATHEXT = process.env.PATHEXT;
    childEnv.GIT_CONFIG_GLOBAL = "NUL";
  } else {
    childEnv.PATH = process.env.PATH;
    childEnv.GIT_CONFIG_GLOBAL = "/dev/null";
  }
  return Object.fromEntries(
    Object.entries(childEnv).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function verifyHandshake(
  value: unknown,
  resolved: ResolvedCollector,
): OnboardingCollectorHandshake {
  const handshake = OnboardingCollectorHandshakeSchema.parse(value);
  const { integrity } = resolved;
  if (
    handshake.collectorVersion !== integrity.collectorVersion ||
    handshake.collectorProtocolVersion !== integrity.collectorProtocolVersion ||
    handshake.sourceInspectionSchemaVersion !== integrity.sourceInspectionSchemaVersion ||
    handshake.codebaseDigestSchemaVersion !== integrity.codebaseDigestSchemaVersion ||
    handshake.preparedSchemaVersion !== integrity.preparedSchemaVersion ||
    handshake.contractArtifactVersion !== integrity.contractArtifactVersion ||
    handshake.contractManifestSha256 !== integrity.contractManifestSha256 ||
    handshake.collectionPolicyVersion !== integrity.collectionPolicyVersion ||
    handshake.collectionPolicySha256 !== integrity.collectionPolicySha256
  ) {
    throw new OnboardingCollectorUnavailableError(
      "The installed Layers source collector is not compatible with this launcher.",
    );
  }
  return handshake;
}

export class OnboardingCollectorSession {
  readonly handshake: OnboardingCollectorHandshake;
  #closed = false;

  private constructor(
    private readonly child: ChildProcess,
    private readonly input: Writable,
    private readonly control: JsonLineChannel,
    private readonly privateOutput: JsonLineChannel,
    private readonly transport: PrivateTransport,
    handshake: OnboardingCollectorHandshake,
  ) {
    this.handshake = handshake;
  }

  static async open(): Promise<OnboardingCollectorSession> {
    const resolved = resolveCollector();
    const transport = privateTransport();
    await transport.start();

    const child = spawn(resolved.binaryPath, [], {
      // The collector receives no host, provider, or Layers credentials from
      // the parent environment. It needs only the executable search path for
      // local Git plus its one private-channel locator on Windows.
      env: collectorEnvironment(transport.env),
      stdio: transport.stdio,
      windowsHide: true,
    });
    const input = child.stdin;
    const output = child.stdout;
    const stderr = child.stderr;
    if (!(input instanceof Writable) || !(output instanceof Readable)) {
      child.kill();
      await transport.close();
      throw new OnboardingCollectorProtocolError();
    }

    // Drain the collector's intentionally generic diagnostics without ever
    // copying child stderr into a model-visible error or transcript.
    if (stderr instanceof Readable) stderr.on("data", () => {});

    const privateStream = await transport.stream(child);
    const control = new JsonLineChannel(output, CONTROL_LINE_LIMIT_BYTES);
    const privateOutput = new JsonLineChannel(privateStream, PRIVATE_LINE_LIMIT_BYTES);
    child.once("exit", () => {
      control.fail();
      privateOutput.fail();
    });
    child.once("error", () => {
      control.fail();
      privateOutput.fail();
    });

    try {
      const handshake = verifyHandshake(
        await control.next(COLLECTOR_START_TIMEOUT_MS),
        resolved,
      );
      return new OnboardingCollectorSession(
        child,
        input,
        control,
        privateOutput,
        transport,
        handshake,
      );
    } catch (error) {
      child.kill();
      await transport.close();
      throw error;
    }
  }

  async inspect(root?: string): Promise<OnboardingSourceInspection> {
    return this.#inspection({ type: "inspect", ...(root ? { root } : {}) });
  }

  async select(selectedCandidateId: string): Promise<OnboardingSourceInspection> {
    return this.#inspection({ type: "select", selectedCandidateId });
  }

  async reinspect(input: {
    excludedPathIds: string[];
    excludedTargetIds: string[];
    selectedTargetIds: string[];
  }): Promise<OnboardingSourceInspection> {
    return this.#inspection({
      type: "reinspect",
      excludedPathIds: [...input.excludedPathIds].sort(),
      excludedTargetIds: [...input.excludedTargetIds].sort(),
      selectedTargetIds: [...input.selectedTargetIds].sort(),
    });
  }

  async prepare(): Promise<OnboardingPreparedCodebaseArtifact> {
    this.#assertOpen();
    this.#send({ type: "prepare" });
    const [controlValue, privateValue] = await Promise.all([
      this.control.next(),
      this.privateOutput.next(),
    ]);
    const response = OnboardingCollectorResponseSchema.parse(controlValue);
    const privateResponse: OnboardingCollectorPrivateResponse =
      OnboardingCollectorPrivateResponseSchema.parse(privateValue);
    if (response.type !== "prepared" || privateResponse.type !== "prepared_artifact") {
      throw new OnboardingCollectorProtocolError();
    }
    return privateResponse.preparedArtifact;
  }

  async complete(): Promise<z.infer<typeof OnboardingCollectorCleanupResultSchema>> {
    return this.#close("complete");
  }

  async cancel(): Promise<z.infer<typeof OnboardingCollectorCleanupResultSchema>> {
    return this.#close("cancel");
  }

  async #inspection(request: OnboardingCollectorRequest): Promise<OnboardingSourceInspection> {
    this.#assertOpen();
    this.#send(request);
    const response: OnboardingCollectorResponse = OnboardingCollectorResponseSchema.parse(
      await this.control.next(),
    );
    if (response.type !== "inspection") throw new OnboardingCollectorProtocolError();
    return response.projection;
  }

  #send(request: OnboardingCollectorRequest): void {
    const value = OnboardingCollectorRequestSchema.parse(request);
    this.input.write(`${JSON.stringify(value)}\n`, "utf8");
  }

  #assertOpen(): void {
    if (this.#closed || this.child.exitCode !== null) {
      throw new OnboardingCollectorProtocolError();
    }
  }

  async #close(
    type: "cancel" | "complete",
  ): Promise<z.infer<typeof OnboardingCollectorCleanupResultSchema>> {
    if (this.#closed) throw new OnboardingCollectorProtocolError();
    this.#closed = true;
    try {
      if (this.child.exitCode !== null) throw new OnboardingCollectorProtocolError();
      this.#send({ type });
      const response: OnboardingCollectorResponse = OnboardingCollectorResponseSchema.parse(
        await this.control.next(),
      );
      if (response.type !== (type === "cancel" ? "canceled" : "completed")) {
        throw new OnboardingCollectorProtocolError();
      }
      if (response.cleanup.bufferCount !== 0 || response.cleanup.bufferBytes !== 0) {
        throw new OnboardingCollectorProtocolError(
          "The Layers source collector did not prove local buffer cleanup.",
        );
      }
      return response.cleanup;
    } finally {
      this.input.end();
      if (this.child.exitCode === null) this.child.kill();
      await this.transport.close();
    }
  }
}
