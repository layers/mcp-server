import { createHash, randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ONBOARDING_CONSENT_RETENTION_COPY,
  OnboardingEvidenceEnvelopeSchema,
  approveOnboardingCodebaseConsent,
  prepareOnboardingCodebaseConsentDraft,
  prepareOnboardingIncrementalPublicPagesDraft,
  type OnboardingCodebaseConsentDraft,
  type OnboardingIncrementalPublicPagesDraft,
  type OnboardingSourceInspection,
} from "@layers/onboarding-contracts";
import { z } from "zod";
import type { ToolResult } from "../api.js";
import { WRITE } from "../api.js";
import { OnboardingCollectorSession } from "./collector.js";
import { getReservation, redact, type OnboardingReservation } from "./session.js";

const SOURCE_TERMS_URL = "https://layers.com/legal/onboarding-source-data";
const SOURCE_PROCESSORS = [
  `Google Cloud transient object storage — ${SOURCE_TERMS_URL}`,
  `Layers API — ${SOURCE_TERMS_URL}`,
  `Supabase — ${SOURCE_TERMS_URL}`,
  `Vertex AI — ${SOURCE_TERMS_URL}`,
] as const;

// SOURCE_DATA_CONTRACT.md item 13, approved verbatim for closed implementation.
// Keep this in sync with the public terms; shortening it would change the scope
// the human sees before approval.
const TEMPORARY_WORKSPACE_TERMS = [
  "Layers creates an isolated, trial-scoped workspace only to analyze the approved evidence, build the preview, and let you claim or resume it.",
  "Depending on the branch, it may include an upload grant and fenced upload-intent generation/lease, evidence and public-validation records, analysis and preview jobs, an anonymous Supabase Auth user, organization, and membership, and—only for a normal new-product preview—a temporary project, SDK record, entitlement, organization/onboarding credits, media, and preview assets.",
  "For a public GitHub URL, the same-session bootstrap may inspect policy-eligible files from the pinned revision in a bounded, memory-only local workspace to prepare the receipt; no fetched Git blob, full file, or unapproved repository content is sent to Layers, and only the approved bounded facts and excerpts may be sent after consent.",
  "Existing-App-ID previews create no duplicate project before authorization.",
  "The browser may also create or sign into your normal Layers account; that account remains yours even if this product claim is denied, and you can delete it through the normal account-deletion flow.",
  "Nothing is exposed to another account before an authorized claim.",
].join(" ");

const EvidenceUploadResponseSchema = z
  .object({
    protocolVersion: z.literal(1),
    trialHandle: z.string().min(1),
    evidenceId: z.string().uuid(),
    state: z.literal("evidence_received"),
  })
  .strict();

const WorkspaceOperationSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("inspect") }).strict(),
  z
    .object({
      operation: z.literal("select_product"),
      candidateId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("reinspect"),
      excludedPathIds: z.array(z.string().regex(/^[0-9a-f]{64}$/)).max(1024).default([]),
      excludedTargetIds: z.array(z.string().uuid()).max(128).default([]),
      selectedTargetIds: z.array(z.string().uuid()).max(128).default([]),
    })
    .strict(),
  z.object({ operation: z.literal("display_source_consent") }).strict(),
  z
    .object({
      operation: z.literal("approve_source_consent"),
      decision: z.literal("APPROVE_EXACT_SCOPE"),
    })
    .strict(),
  z.object({ operation: z.literal("cancel") }).strict(),
]);

type WorkspaceOperation = z.infer<typeof WorkspaceOperationSchema>;

interface DisplayedSourceDraft {
  draft: OnboardingCodebaseConsentDraft;
  displayEventId: string;
  displayedAt: string;
}

interface DisplayedIncrementalDraft {
  draft: OnboardingIncrementalPublicPagesDraft;
  displayEventId: string;
  displayedAt: string;
}

interface SourceFlowState {
  collector: OnboardingCollectorSession;
  inspection: OnboardingSourceInspection;
  collectorClosed?: boolean;
  sourceDisplay?: DisplayedSourceDraft;
  sourceSubmissionRequestId?: string;
  approvedSourceEnvelope?: unknown;
  pendingIncrementalDraft?: OnboardingIncrementalPublicPagesDraft;
  incrementalDisplay?: DisplayedIncrementalDraft;
}

let currentFlow: SourceFlowState | undefined;
let operationTail: Promise<void> = Promise.resolve();

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function publicResult(value: unknown): ToolResult {
  return {
    content: [{ type: "text", text: redact(JSON.stringify(value)) }],
  };
}

function errorResult(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text", text: redact(message) }],
  };
}

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const next = operationTail.then(operation, operation);
  operationTail = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

function activeReservation(): OnboardingReservation | undefined {
  const reservation = getReservation();
  if (!reservation) return undefined;
  return Date.parse(reservation.expiresAt) > Date.now() ? reservation : undefined;
}

function assertReadyInspection(
  inspection: OnboardingSourceInspection,
): asserts inspection is OnboardingSourceInspection & { status: "ready" } {
  if (inspection.status !== "ready") {
    throw new Error(
      inspection.status === "needs_url"
        ? "No viable local product was found. Ask once for the public product URL."
        : "Select one of the displayed product candidates before preparing consent.",
    );
  }
}

async function replaceCollector(): Promise<OnboardingCollectorSession> {
  const previous = currentFlow?.collector;
  currentFlow = undefined;
  if (previous) {
    try {
      await previous.cancel();
    } catch {
      // The old process is already unusable; opening a new fail-closed child is safe.
    }
  }
  return OnboardingCollectorSession.open();
}

function clearDrafts(flow: SourceFlowState): void {
  flow.sourceDisplay = undefined;
  flow.sourceSubmissionRequestId = undefined;
  flow.approvedSourceEnvelope = undefined;
  flow.pendingIncrementalDraft = undefined;
  flow.incrementalDisplay = undefined;
}

async function inspectWorkspace(
  reserve: () => Promise<unknown>,
): Promise<OnboardingSourceInspection> {
  if (!activeReservation()) await reserve();
  if (!activeReservation()) throw new Error("Layers source admission is not available yet.");

  const collector = await replaceCollector();
  try {
    const inspection = await collector.inspect();
    currentFlow = { collector, inspection };
    return inspection;
  } catch (error) {
    try {
      await collector.cancel();
    } catch {
      // Preserve the original bounded error.
    }
    throw error;
  }
}

async function selectProduct(candidateId: string): Promise<OnboardingSourceInspection> {
  if (!currentFlow) throw new Error("Inspect the current workspace first.");
  if (currentFlow.approvedSourceEnvelope) {
    throw new Error("Retry the same approved submission or cancel before changing its scope.");
  }
  const inspection = await currentFlow.collector.select(candidateId);
  currentFlow.inspection = inspection;
  clearDrafts(currentFlow);
  return inspection;
}

async function reinspect(input: Extract<WorkspaceOperation, { operation: "reinspect" }>) {
  if (!currentFlow) throw new Error("Inspect the current workspace first.");
  if (currentFlow.approvedSourceEnvelope) {
    throw new Error("Retry the same approved submission or cancel before changing its scope.");
  }
  const inspection = await currentFlow.collector.reinspect({
    excludedPathIds: input.excludedPathIds,
    excludedTargetIds: input.excludedTargetIds,
    selectedTargetIds: input.selectedTargetIds,
  });
  currentFlow.inspection = inspection;
  clearDrafts(currentFlow);
  return inspection;
}

async function displaySourceConsent(): Promise<unknown> {
  const flow = currentFlow;
  if (!flow) throw new Error("Inspect the current workspace first.");
  assertReadyInspection(flow.inspection);
  if (flow.sourceDisplay) {
    return {
      state: "source_consent_required",
      proposal: flow.sourceDisplay.draft.proposal,
      canonicalProjectionSha256: flow.sourceDisplay.draft.canonicalProjectionSha256,
      requiredDecision: "APPROVE_EXACT_SCOPE",
    };
  }

  const activeTargets = flow.inspection.publicTargets.filter(
    (target) => target.disposition === "proposed" || target.disposition === "user_selected",
  );
  if (activeTargets.length > 4) {
    return {
      state: "public_target_selection_required",
      maximumTargetCount: 4,
      activeTargetCount: activeTargets.length,
      instruction:
        "Ask the human once which displayed public targets to keep, then call reinspect with stable target IDs.",
    };
  }

  const prepared = await flow.collector.prepare();
  const createdAt = new Date().toISOString();
  const draft = prepareOnboardingCodebaseConsentDraft({
    prepared,
    receiptId: randomUUID(),
    createdAt,
    processorCategoriesAndPublicServices: SOURCE_PROCESSORS,
    temporaryWorkspaceTerms: TEMPORARY_WORKSPACE_TERMS,
    retentionAndDeletionTerms: ONBOARDING_CONSENT_RETENTION_COPY,
    sha256,
  });
  flow.sourceDisplay = {
    draft,
    displayEventId: randomUUID(),
    displayedAt: new Date().toISOString(),
  };

  return {
    state: "source_consent_required",
    proposal: draft.proposal,
    canonicalProjectionSha256: draft.canonicalProjectionSha256,
    requiredDecision: "APPROVE_EXACT_SCOPE",
    instruction:
      "Display this exact proposal. Approval must be a later human interaction; do not approve in this call.",
  };
}

async function uploadSourceEvidence(
  baseUrl: string,
  reservation: OnboardingReservation,
  submissionRequestId: string,
  envelope: unknown,
): Promise<z.infer<typeof EvidenceUploadResponseSchema>> {
  const parsedEnvelope = OnboardingEvidenceEnvelopeSchema.parse(envelope);
  const serialized = Buffer.from(JSON.stringify(parsedEnvelope), "utf8");
  try {
    let response: Response | undefined;
    let transportError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        response = await fetch(
          new URL(
            `/api/onboard/agent/trials/${encodeURIComponent(reservation.trialHandle)}/evidence`,
            baseUrl,
          ),
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": String(serialized.byteLength),
              "Idempotency-Key": submissionRequestId,
              "X-Layers-Onboard-Capability": reservation.reservationCapability,
              "X-Layers-Evidence-Kind": "codebase",
              "X-Layers-Evidence-Schema-Version": "1",
              "X-Layers-Collection-Policy-Version": "v1",
            },
            body: serialized,
          },
        );
        break;
      } catch (error) {
        transportError = error;
      }
    }
    if (!response) {
      throw new Error(
        transportError
          ? "The approved source could not be securely submitted. Retry the same approval."
          : "The approved source could not be securely submitted.",
      );
    }
    const body: unknown = await response.json().catch(() => null);
    if (response.status !== 202) {
      if (response.status === 401 || response.status === 410) {
        throw new Error("The source reservation expired. Start a fresh inspection.");
      }
      if (response.status === 429 || response.status >= 500) {
        throw new Error("Source submission is temporarily unavailable. Retry the same approval.");
      }
      throw new Error("The approved source submission was rejected safely.");
    }
    const accepted = EvidenceUploadResponseSchema.parse(body);
    if (accepted.trialHandle !== reservation.trialHandle) {
      throw new Error("Source submission returned a mismatched trial identity.");
    }
    return accepted;
  } finally {
    serialized.fill(0);
  }
}

async function approveSourceConsent(baseUrl: string): Promise<unknown> {
  const flow = currentFlow;
  const reservation = activeReservation();
  if (!flow?.sourceDisplay) throw new Error("Display the exact source proposal first.");
  if (!reservation) throw new Error("The source reservation expired. Start a fresh inspection.");

  if (!flow.approvedSourceEnvelope) {
    const approvedAt = new Date().toISOString();
    const envelope = approveOnboardingCodebaseConsent({
      draft: flow.sourceDisplay.draft,
      displayEventId: flow.sourceDisplay.displayEventId,
      displayedAt: flow.sourceDisplay.displayedAt,
      displaySequence: 1,
      approvalRecordId: randomUUID(),
      approvingInteractionId: randomUUID(),
      approvedAt,
      approvalSequence: 2,
      displaySurface: "host_conversation",
      sha256,
    });

    const selectedTargetIds = flow.sourceDisplay.draft.publicSurfaceCandidates
      .filter(
        (candidate) =>
          candidate.disposition === "proposed" || candidate.disposition === "user_selected",
      )
      .map((candidate) => candidate.candidateId)
      .sort();
    if (selectedTargetIds.length > 0) {
      flow.pendingIncrementalDraft = prepareOnboardingIncrementalPublicPagesDraft({
        sourceEnvelope: envelope,
        availableCandidates: flow.sourceDisplay.draft.publicSurfaceCandidates,
        selectedCandidateIds: selectedTargetIds,
        receiptId: randomUUID(),
        createdAt: new Date().toISOString(),
        sha256,
      });
    }
    flow.approvedSourceEnvelope = envelope;
    flow.sourceSubmissionRequestId = randomUUID();
  }

  const accepted = await uploadSourceEvidence(
    baseUrl,
    reservation,
    flow.sourceSubmissionRequestId!,
    flow.approvedSourceEnvelope,
  );
  const cleanup = await flow.collector.complete();
  flow.collectorClosed = true;
  const incrementalDraft = flow.pendingIncrementalDraft;

  // Drop the source envelope/draft (and its excerpt strings) immediately after
  // the accepted upload. The optional child draft is content-free.
  flow.sourceDisplay = undefined;
  flow.sourceSubmissionRequestId = undefined;
  flow.approvedSourceEnvelope = undefined;
  flow.pendingIncrementalDraft = undefined;
  if (incrementalDraft) {
    flow.incrementalDisplay = {
      draft: incrementalDraft,
      displayEventId: randomUUID(),
      displayedAt: new Date().toISOString(),
    };
    return {
      ...accepted,
      attemptId: reservation.attemptId,
      localCleanup: cleanup,
      nextState: "public_pages_consent_required",
      publicPagesProposal: incrementalDraft.proposal,
      canonicalProjectionSha256: incrementalDraft.canonicalProjectionSha256,
      requiredDecision: "APPROVE_EXACT_SCOPE",
      instruction:
        "Display this public-lookup proposal once. No public service has been contacted yet.",
    };
  }

  return {
    ...accepted,
    attemptId: reservation.attemptId,
    localCleanup: cleanup,
    nextState: "evidence_processing",
  };
}

async function cancelFlow(): Promise<unknown> {
  const flow = currentFlow;
  currentFlow = undefined;
  if (!flow) return { state: "canceled", cleanup: { bufferCount: 0, bufferBytes: 0 } };
  const cleanup = flow.collectorClosed
    ? { bufferCount: 0, bufferBytes: 0 }
    : await flow.collector.cancel();
  return { state: "canceled", cleanup };
}

async function runOperation(
  baseUrl: string,
  reserve: () => Promise<unknown>,
  input: WorkspaceOperation,
): Promise<unknown> {
  switch (input.operation) {
    case "inspect":
      return inspectWorkspace(reserve);
    case "select_product":
      return selectProduct(input.candidateId);
    case "reinspect":
      return reinspect(input);
    case "display_source_consent":
      return displaySourceConsent();
    case "approve_source_consent":
      return approveSourceConsent(baseUrl);
    case "cancel":
      return cancelFlow();
  }
}

export function registerSourceOnboardingTool(
  server: McpServer,
  baseUrl: string,
  reserve: () => Promise<unknown>,
): void {
  server.registerTool(
    "onboard_workspace",
    {
      title: "Onboard the current workspace",
      annotations: WRITE,
      description:
        "Primary code-workspace onboarding flow. Inspect locally without exposing source, select or exclude by stable IDs, display the exact consent proposal, and submit only after a separate human approval interaction. Start with operation=inspect. Never call approve_source_consent in the same turn that displays the proposal.",
      inputSchema: WorkspaceOperationSchema,
    },
    async (input) => {
      try {
        return publicResult(await serialize(() => runOperation(baseUrl, reserve, input)));
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
