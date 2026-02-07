import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type {
  ApprovalRecord,
  AuditEvent,
  ExecutionPlan,
  ExecutionPlanDraft,
  GeneratedFileArtifact,
  InboundMessage,
  ModelTurnResponse,
  WorkItem,
} from "@delegate/domain";
import type {
  ApprovalStore,
  ArtifactStore,
  AuditPort,
  ChatPort,
  ModelPort,
  PlanStore,
  PolicyEngine,
  VcsPort,
  WorkItemStore,
} from "@delegate/ports";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const nowIso = (): string => new Date().toISOString();

const approvalActionType = "publish_pr" as const;

const naturalApprovePhrases = new Set([
  "approve",
  "go ahead",
  "yes approve",
  "ship it",
]);

const naturalDenyPhrases = new Set([
  "deny",
  "no deny",
  "stop this",
  "do not proceed",
]);

type WorkerDeps = {
  chatPort: ChatPort;
  modelPort: ModelPort;
  workItemStore: WorkItemStore;
  planStore: PlanStore;
  approvalStore: ApprovalStore;
  artifactStore: ArtifactStore;
  policyEngine: PolicyEngine;
  auditPort: AuditPort;
  vcsPort: VcsPort;
};

type WorkerOptions = {
  executionIntentConfidenceThreshold?: number;
  assistantRepoPath?: string;
  previewDiffFirst?: boolean;
};

type LogFields = Record<string, string | number | boolean | null>;

type ParsedAction =
  | { type: "start" }
  | { type: "approve" }
  | { type: "deny" }
  | { type: "revise"; text: string }
  | { type: "chat"; text: string };

type ChatState = {
  history: string[];
  pendingApprovalId: string | null;
};

type PendingLocalAction = {
  artifact: GeneratedFileArtifact;
  originalRequest: string;
};

const chatStateByChatId = new Map<string, ChatState>();
const chatMessageCountByChatId = new Map<string, number>();
const pendingLocalActionByChatId = new Map<string, PendingLocalAction>();

const logInfo = (event: string, fields: LogFields = {}): void => {
  console.log(
    JSON.stringify({
      level: "info",
      event,
      ...fields,
    }),
  );
};

const logError = (event: string, fields: LogFields = {}): void => {
  console.error(
    JSON.stringify({
      level: "error",
      event,
      ...fields,
    }),
  );
};

const normalizePhrase = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const isRevisePhrase = (normalized: string): boolean =>
  normalized.startsWith("revise ") || normalized.startsWith("change ");

const publishIntentPattern =
  /\b(open\s+a\s+pr|open\s+pr|pull\s+request|create\s+pr|publish|push|merge|release)\b/i;

const destructiveIntentPattern = /\b(delete|remove|drop|rm\s+-rf|wipe)\b/i;

const isPublishIntent = (text: string): boolean =>
  publishIntentPattern.test(text);

const isDestructiveIntent = (text: string): boolean =>
  destructiveIntentPattern.test(text);

const parseAction = (text: string): ParsedAction => {
  const trimmed = text.trim();
  if (trimmed.toLowerCase() === "/start") {
    return { type: "start" };
  }

  const normalized = normalizePhrase(trimmed);
  if (naturalApprovePhrases.has(normalized)) {
    return { type: "approve" };
  }

  if (naturalDenyPhrases.has(normalized)) {
    return { type: "deny" };
  }

  if (isRevisePhrase(normalized)) {
    const reviseText = trimmed.split(/\s+/).slice(1).join(" ").trim();
    return { type: "revise", text: reviseText };
  }

  return { type: "chat", text: trimmed };
};

const getChatState = (chatId: string): ChatState => {
  const existing = chatStateByChatId.get(chatId);
  if (existing) {
    return existing;
  }

  const initial: ChatState = {
    history: [],
    pendingApprovalId: null,
  };
  chatStateByChatId.set(chatId, initial);
  return initial;
};

const appendHistory = (
  state: ChatState,
  speaker: "user" | "assistant",
  text: string,
): void => {
  state.history.push(`${speaker}: ${text}`);
  if (state.history.length > 12) {
    state.history = state.history.slice(-12);
  }
};

const toSha256Hex = async (input: string): Promise<string> => {
  const encoded = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

const addHours = (iso: string, hours: number): string => {
  const value = new Date(iso).getTime() + hours * 60 * 60 * 1000;
  return new Date(value).toISOString();
};

const isExpired = (expiryIso: string, now: string): boolean =>
  new Date(expiryIso).getTime() <= new Date(now).getTime();

const approvalPayloadHash = async (
  plan: ExecutionPlan,
  artifact: GeneratedFileArtifact,
): Promise<string> => {
  const canonical = JSON.stringify({
    actionType: approvalActionType,
    workItemId: plan.workItemId,
    intentSummary: plan.intentSummary,
    proposedNextStep: plan.proposedNextStep,
    riskLevel: plan.riskLevel,
    sideEffects: [...plan.sideEffects].sort(),
    artifact: {
      path: artifact.path,
      content: artifact.content,
    },
  });
  return toSha256Hex(canonical);
};

const appendAuditEvent = async (
  auditPort: AuditPort,
  event: AuditEvent,
): Promise<void> => {
  await auditPort.append(event);
};

const sendMessage = async (
  chatPort: ChatPort,
  outbound: { chatId: string; text: string },
  fields: LogFields,
): Promise<void> => {
  await chatPort.send(outbound);
  logInfo("chat.message.sent", {
    chatId: outbound.chatId,
    chars: outbound.text.length,
    ...fields,
  });
};

const loadPendingApproval = async (
  deps: WorkerDeps,
  state: ChatState,
): Promise<ApprovalRecord | null> => {
  if (!state.pendingApprovalId) {
    return null;
  }

  const approval = await deps.approvalStore.getApprovalById(
    state.pendingApprovalId,
  );
  if (!approval || approval.status !== "pending") {
    state.pendingApprovalId = null;
    return null;
  }
  return approval;
};

const publishApprovedAction = async (
  deps: WorkerDeps,
  message: InboundMessage,
  approval: ApprovalRecord,
): Promise<void> => {
  const now = nowIso();
  if (isExpired(approval.expiresAt, now)) {
    await deps.approvalStore.updateApprovalStatus(
      approval.id,
      "expired",
      now,
      "EXPIRED",
    );
    await sendMessage(
      deps.chatPort,
      {
        chatId: message.chatId,
        text: "That proposal expired. Ask me to propose it again.",
      },
      { command: "approve", reason: "EXPIRED" },
    );
    return;
  }

  const [plan, artifact] = await Promise.all([
    deps.planStore.getPlanByWorkItemId(approval.workItemId),
    deps.artifactStore.getArtifactByWorkItemId(approval.workItemId),
  ]);

  if (!plan || !artifact) {
    await sendMessage(
      deps.chatPort,
      {
        chatId: message.chatId,
        text: "Proposal state is missing. Ask me to re-propose this change.",
      },
      { command: "approve", reason: "MISMATCH" },
    );
    return;
  }

  const hash = await approvalPayloadHash(plan, artifact);
  if (hash !== approval.payloadHash) {
    await sendMessage(
      deps.chatPort,
      {
        chatId: message.chatId,
        text: "Proposal changed and can no longer be approved. Ask me to re-propose.",
      },
      { command: "approve", reason: "MISMATCH" },
    );
    return;
  }

  await deps.approvalStore.updateApprovalStatus(
    approval.id,
    "approved",
    now,
    "APPROVED",
  );
  await deps.workItemStore.updateStatus(approval.workItemId, "approved", now);

  const traceId =
    (await deps.workItemStore.getById(approval.workItemId))?.traceId ??
    "unknown";
  await appendAuditEvent(deps.auditPort, {
    eventId: crypto.randomUUID(),
    eventType: "approval.granted",
    workItemId: approval.workItemId,
    actor: "user",
    timestamp: now,
    traceId,
    payload: {
      approvalId: approval.id,
      actionType: approval.actionType,
    },
  });

  try {
    const published = await deps.vcsPort.publishPr({
      workItemId: approval.workItemId,
      summary: plan.intentSummary,
      artifact,
    });

    await appendAuditEvent(deps.auditPort, {
      eventId: crypto.randomUUID(),
      eventType: "vcs.pr_published",
      workItemId: approval.workItemId,
      actor: "assistant",
      timestamp: nowIso(),
      traceId,
      payload: {
        branchName: published.branchName,
        pullRequestUrl: published.pullRequestUrl,
      },
    });

    await sendMessage(
      deps.chatPort,
      {
        chatId: message.chatId,
        text: `Approved. PR published: ${published.pullRequestUrl}`,
      },
      { command: "approve", workItemId: approval.workItemId },
    );
  } catch (error) {
    await deps.workItemStore.updateStatus(
      approval.workItemId,
      "cancelled",
      nowIso(),
    );
    await sendMessage(
      deps.chatPort,
      {
        chatId: message.chatId,
        text: `Approval accepted, but publish failed: ${String(error)}`,
      },
      { command: "approve", error: String(error) },
    );
  }
};

const persistExecutionProposal = async (
  deps: WorkerDeps,
  chatId: string,
  requestText: string,
  proposal: Extract<ModelTurnResponse, { mode: "execution_proposal" }>,
  supersededApprovalId: string | null,
): Promise<{ workItemId: string; approvalId: string }> => {
  const timestamp = nowIso();
  const workItem: WorkItem = {
    id: crypto.randomUUID(),
    traceId: crypto.randomUUID(),
    status: "delegated",
    summary: requestText,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  await deps.workItemStore.create(workItem);

  const plan: ExecutionPlan = {
    id: crypto.randomUUID(),
    workItemId: workItem.id,
    createdAt: timestamp,
    ...proposal.plan,
  };

  await deps.planStore.createPlan(plan);
  await deps.artifactStore.saveArtifact(
    workItem.id,
    proposal.artifact,
    timestamp,
  );

  if (supersededApprovalId) {
    await deps.approvalStore.updateApprovalStatus(
      supersededApprovalId,
      "expired",
      timestamp,
      "SUPERSEDED_BY_REVISE",
    );
  }

  const approval: ApprovalRecord = {
    id: crypto.randomUUID(),
    workItemId: workItem.id,
    actionType: approvalActionType,
    payloadHash: await approvalPayloadHash(plan, proposal.artifact),
    status: "pending",
    requestedAt: timestamp,
    expiresAt: addHours(timestamp, 24),
    consumedAt: null,
    decisionReason: null,
  };

  await deps.approvalStore.createApproval(approval);
  await deps.workItemStore.updateStatus(
    workItem.id,
    "approval_pending",
    nowIso(),
  );

  await appendAuditEvent(deps.auditPort, {
    eventId: crypto.randomUUID(),
    eventType: "work_item.delegated",
    workItemId: workItem.id,
    actor: "user",
    timestamp,
    traceId: workItem.traceId,
    payload: {
      source: "telegram",
      text: requestText,
      chatId,
    },
  });

  await appendAuditEvent(deps.auditPort, {
    eventId: crypto.randomUUID(),
    eventType: "approval.requested",
    workItemId: workItem.id,
    actor: "assistant",
    timestamp: nowIso(),
    traceId: workItem.traceId,
    payload: {
      approvalId: approval.id,
      expiresAt: approval.expiresAt,
    },
  });

  return { workItemId: workItem.id, approvalId: approval.id };
};

const publishPreview = (
  workItemId: string,
  plan: ExecutionPlanDraft,
  artifact: GeneratedFileArtifact,
): string => {
  const branchName = `delegate/${workItemId}`;
  const title = plan.intentSummary;
  const body = [
    `- Work item: ${workItemId}`,
    `- Change: ${artifact.summary}`,
  ].join("\n");

  return [
    "I can publish this as a PR.",
    `Branch: ${branchName}`,
    `Title: ${title}`,
    "Body preview:",
    body,
    "Reply with: Approve / Revise / Deny",
  ].join("\n");
};

const applyLocalArtifact = async (
  repoPath: string,
  artifact: GeneratedFileArtifact,
): Promise<string> => {
  const relativePath = artifact.path.trim();
  if (
    relativePath.length === 0 ||
    relativePath.startsWith("/") ||
    relativePath.includes("\\") ||
    relativePath.split("/").some((segment) => segment === "..")
  ) {
    throw new Error("Artifact path must be repo-relative and safe");
  }

  const absolutePath = resolve(repoPath, relativePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await Bun.write(absolutePath, artifact.content);
  return relativePath;
};

export const handleChatMessage = async (
  deps: WorkerDeps,
  message: InboundMessage,
  options: WorkerOptions = {},
): Promise<void> => {
  const threshold = options.executionIntentConfidenceThreshold ?? 0.75;
  const assistantRepoPath = options.assistantRepoPath ?? process.cwd();
  const previewDiffFirst = options.previewDiffFirst ?? false;
  const priorMessageCount = chatMessageCountByChatId.get(message.chatId) ?? 0;
  chatMessageCountByChatId.set(message.chatId, priorMessageCount + 1);

  logInfo("chat.message.received", {
    chatId: message.chatId,
    sourceMessageId: message.sourceMessageId ?? null,
    chars: message.text.length,
  });

  const action = parseAction(message.text);
  logInfo("chat.action.parsed", {
    chatId: message.chatId,
    action: action.type,
  });

  if (action.type === "start") {
    if (priorMessageCount === 0) {
      await sendMessage(
        deps.chatPort,
        {
          chatId: message.chatId,
          text: "Hi - I am ready. Tell me what you want to work on.",
        },
        { action: "start", firstMessage: true },
      );
    }
    return;
  }

  const state = getChatState(message.chatId);
  const pendingApproval = await loadPendingApproval(deps, state);
  const pendingLocalAction =
    pendingLocalActionByChatId.get(message.chatId) ?? null;

  if (action.type === "approve") {
    if (pendingLocalAction) {
      try {
        const writtenPath = await applyLocalArtifact(
          assistantRepoPath,
          pendingLocalAction.artifact,
        );
        pendingLocalActionByChatId.delete(message.chatId);
        state.pendingApprovalId = null;
        const text = `Done. Applied local change to ${writtenPath}.`;
        await sendMessage(
          deps.chatPort,
          {
            chatId: message.chatId,
            text,
          },
          { action: "approve", mode: "local_apply" },
        );
        appendHistory(state, "user", message.text);
        appendHistory(state, "assistant", text);
      } catch (error) {
        await sendMessage(
          deps.chatPort,
          {
            chatId: message.chatId,
            text: `I could not apply that local change: ${String(error)}`,
          },
          { action: "approve", mode: "local_apply_error" },
        );
      }
      return;
    }

    if (!pendingApproval) {
      await sendMessage(
        deps.chatPort,
        {
          chatId: message.chatId,
          text: "There is nothing pending to approve right now.",
        },
        { action: "approve", reason: "NONE" },
      );
      return;
    }

    await publishApprovedAction(deps, message, pendingApproval);
    state.pendingApprovalId = null;
    appendHistory(state, "user", message.text);
    appendHistory(state, "assistant", "Approval accepted.");
    return;
  }

  if (action.type === "deny") {
    if (pendingLocalAction) {
      pendingLocalActionByChatId.delete(message.chatId);
      await sendMessage(
        deps.chatPort,
        {
          chatId: message.chatId,
          text: "Denied. I will not apply that local change.",
        },
        { action: "deny", mode: "local_apply" },
      );
      return;
    }

    if (!pendingApproval) {
      await sendMessage(
        deps.chatPort,
        {
          chatId: message.chatId,
          text: "There is nothing pending to deny.",
        },
        { action: "deny", reason: "NONE" },
      );
      return;
    }

    const now = nowIso();
    await deps.approvalStore.updateApprovalStatus(
      pendingApproval.id,
      "denied",
      now,
      "USER_DENIED",
    );
    await deps.workItemStore.updateStatus(
      pendingApproval.workItemId,
      "denied",
      now,
    );
    state.pendingApprovalId = null;
    await sendMessage(
      deps.chatPort,
      {
        chatId: message.chatId,
        text: "Denied. I will not execute that change.",
      },
      { action: "deny", workItemId: pendingApproval.workItemId },
    );
    appendHistory(state, "user", message.text);
    appendHistory(state, "assistant", "Denied.");
    return;
  }

  let modelInputText = action.type === "chat" ? action.text : action.text;
  if (action.type === "revise" && (pendingApproval || pendingLocalAction)) {
    const workItem = pendingApproval
      ? await deps.workItemStore.getById(pendingApproval.workItemId)
      : null;
    modelInputText = [
      `Revise the pending proposal for request: ${workItem?.summary ?? pendingLocalAction?.originalRequest ?? "unknown"}`,
      `Revision: ${action.text}`,
    ].join("\n");
  }

  appendHistory(state, "user", modelInputText);

  let response: ModelTurnResponse;
  try {
    response = await deps.modelPort.respond({
      chatId: message.chatId,
      text: modelInputText,
      context: [...state.history],
      pendingProposalWorkItemId: pendingApproval?.workItemId ?? null,
    });
  } catch (error) {
    await sendMessage(
      deps.chatPort,
      {
        chatId: message.chatId,
        text: `I hit an error while thinking about that: ${String(error)}`,
      },
      { action: "chat", stage: "model_error" },
    );
    return;
  }

  if (response.mode === "chat_reply") {
    await sendMessage(
      deps.chatPort,
      {
        chatId: message.chatId,
        text: response.replyText,
      },
      { action: "chat", mode: "chat_reply" },
    );
    appendHistory(state, "assistant", response.replyText);
    return;
  }

  if (response.confidence < threshold) {
    const text = `${response.replyText}\nCan you confirm if you want me to execute this as a concrete change?`;
    await sendMessage(
      deps.chatPort,
      {
        chatId: message.chatId,
        text,
      },
      {
        action: "chat",
        mode: "low_confidence",
        confidence: response.confidence,
      },
    );
    appendHistory(state, "assistant", text);
    return;
  }

  const publishIntent = isPublishIntent(message.text);
  const destructiveIntent = isDestructiveIntent(message.text);

  if (publishIntent) {
    const persisted = await persistExecutionProposal(
      deps,
      message.chatId,
      message.text,
      response,
      pendingApproval?.id ?? null,
    );

    state.pendingApprovalId = persisted.approvalId;
    pendingLocalActionByChatId.delete(message.chatId);

    const outbound = `${response.replyText}\n${publishPreview(
      persisted.workItemId,
      response.plan,
      response.artifact,
    )}`;
    await sendMessage(
      deps.chatPort,
      {
        chatId: message.chatId,
        text: outbound,
      },
      {
        action: action.type,
        mode: "execution_proposal",
        confidence: response.confidence,
        workItemId: persisted.workItemId,
        approvalId: persisted.approvalId,
      },
    );
    appendHistory(state, "assistant", response.replyText);
    return;
  }

  if (destructiveIntent || previewDiffFirst) {
    pendingLocalActionByChatId.set(message.chatId, {
      artifact: response.artifact,
      originalRequest: message.text,
    });
    state.pendingApprovalId = null;

    await sendMessage(
      deps.chatPort,
      {
        chatId: message.chatId,
        text: [
          response.replyText,
          `Proposed local change: ${response.artifact.path}`,
          "Reply with: Approve / Revise / Deny",
        ].join("\n"),
      },
      {
        action: action.type,
        mode: "local_preview",
        confidence: response.confidence,
      },
    );
    appendHistory(state, "assistant", response.replyText);
    return;
  }

  const writtenPath = await applyLocalArtifact(
    assistantRepoPath,
    response.artifact,
  );
  state.pendingApprovalId = null;
  pendingLocalActionByChatId.delete(message.chatId);
  const outbound = `${response.replyText}\nDone. Applied local change to ${writtenPath}.`;
  await sendMessage(
    deps.chatPort,
    {
      chatId: message.chatId,
      text: outbound,
    },
    {
      action: action.type,
      mode: "local_applied",
      confidence: response.confidence,
    },
  );
  appendHistory(state, "assistant", response.replyText);
};

export const recoverInFlightWorkItems = async (
  deps: Pick<WorkerDeps, "approvalStore" | "workItemStore" | "auditPort">,
): Promise<{ expiredApprovals: number; cancelledWorkItems: number }> => {
  const pendingApprovals = await deps.approvalStore.listPendingApprovals();
  let expiredApprovals = 0;
  let cancelledWorkItems = 0;
  const now = nowIso();

  for (const approval of pendingApprovals) {
    if (!isExpired(approval.expiresAt, now)) {
      continue;
    }

    expiredApprovals += 1;
    await deps.approvalStore.updateApprovalStatus(
      approval.id,
      "expired",
      now,
      "EXPIRED_ON_RECOVERY",
    );

    const workItem = await deps.workItemStore.getById(approval.workItemId);
    if (workItem && workItem.status === "approval_pending") {
      await deps.workItemStore.updateStatus(workItem.id, "cancelled", now);
      cancelledWorkItems += 1;
    }

    await appendAuditEvent(deps.auditPort, {
      eventId: crypto.randomUUID(),
      eventType: "approval.rejected",
      workItemId: approval.workItemId,
      actor: "system",
      timestamp: now,
      traceId: workItem?.traceId ?? "unknown",
      payload: {
        approvalId: approval.id,
        reason: "EXPIRED_ON_RECOVERY",
      },
    });
  }

  return {
    expiredApprovals,
    cancelledWorkItems,
  };
};

export const startTelegramWorker = (
  deps: WorkerDeps,
  pollIntervalMs: number,
  options: WorkerOptions = {},
): Promise<never> => {
  let cursor: number | null = null;

  const loop = async (): Promise<never> => {
    while (true) {
      try {
        const updates = await deps.chatPort.receiveUpdates(cursor);
        if (updates.length > 0) {
          logInfo("chat.updates.received", {
            count: updates.length,
            cursor,
          });
        }
        for (const update of updates) {
          cursor = update.updateId + 1;
          await handleChatMessage(deps, update.message, options);
        }
      } catch (error) {
        logError("worker.cycle.failed", {
          error: String(error),
        });
      }

      await sleep(pollIntervalMs);
    }
  };

  return loop();
};
