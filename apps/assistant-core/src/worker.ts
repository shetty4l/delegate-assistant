import type {
  ApprovalRecord,
  AuditEvent,
  ExecutionPlan,
  ExecutionPlanDraft,
  GeneratedFileArtifact,
  GenerateResult,
  InboundMessage,
  PolicyDecision,
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

type Command =
  | { type: "approve"; approvalId: string | null }
  | { type: "deny"; approvalId: string | null }
  | { type: "status"; workItemId: string | null }
  | { type: "explain"; workItemId: string | null }
  | { type: "delegate"; text: string };

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

type LogFields = Record<string, string | number | boolean | null>;

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

const toSha256Hex = async (input: string): Promise<string> => {
  const encoded = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

const approvalActionType = "publish_pr" as const;

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

export const parseCommand = (text: string): Command => {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return { type: "delegate", text: trimmed };
  }

  const [command, rawArg] = trimmed.split(/\s+/, 2);
  const arg = rawArg?.trim() || null;

  switch (command.toLowerCase()) {
    case "/approve":
      return { type: "approve", approvalId: arg };
    case "/deny":
      return { type: "deny", approvalId: arg };
    case "/status":
      return { type: "status", workItemId: arg };
    case "/explain":
      return { type: "explain", workItemId: arg };
    default:
      return { type: "delegate", text: trimmed };
  }
};

const summarize = (text: string): string => {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= 140) {
    return collapsed;
  }
  return `${collapsed.slice(0, 137)}...`;
};

const formatPlanResponse = (
  workItem: WorkItem,
  plan: ExecutionPlan,
  artifact: GeneratedFileArtifact,
  approval: ApprovalRecord | null,
): string => {
  const lines = [
    `Work item ${workItem.id}`,
    `Intent: ${plan.intentSummary}`,
    `Assumptions: ${plan.assumptions.join("; ")}`,
    `Ambiguities: ${plan.ambiguities.join("; ")}`,
    `Next: ${plan.proposedNextStep}`,
    `Generated file: ${artifact.path}`,
  ];

  if (approval) {
    lines.push(
      `Approval required: /approve ${approval.id} (risk ${plan.riskLevel}; side effects ${plan.sideEffects.join(", ")}; expires ${approval.expiresAt}).`,
    );
    lines.push(`To deny: /deny ${approval.id}`);
  }

  lines.push(`Check progress: /status ${workItem.id}`);
  return lines.join("\n");
};

const formatExplainResponse = (input: {
  workItem: WorkItem;
  plan: ExecutionPlan | null;
  approval: ApprovalRecord | null;
  artifact: GeneratedFileArtifact | null;
}): string => {
  const { workItem, plan, approval, artifact } = input;
  const alternatives = plan?.ambiguities.length
    ? plan.ambiguities.join("; ")
    : "No unresolved alternatives recorded.";
  const assumptions = plan?.assumptions.length
    ? plan.assumptions.join("; ")
    : "No assumptions recorded.";

  const lines = [
    `Work item ${workItem.id}`,
    `Status: ${workItem.status}`,
    `Why: ${plan?.intentSummary ?? workItem.summary}`,
    `What I used: summary='${workItem.summary}'; assumptions=${assumptions}`,
    `Alternatives: ${alternatives}`,
    `Current step: ${plan?.proposedNextStep ?? "No plan recorded."}`,
  ];

  if (artifact) {
    lines.push(`Artifact: ${artifact.path}`);
  }

  if (approval) {
    lines.push(
      `Approval: ${approval.status} (${approval.id}, expires ${approval.expiresAt})`,
    );
  }

  return lines.join("\n");
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

const appendApprovalRejectedAudit = async (
  deps: WorkerDeps,
  approval: ApprovalRecord,
  reason: string,
): Promise<void> => {
  const traceId =
    (await deps.workItemStore.getById(approval.workItemId))?.traceId ??
    "unknown";
  await appendAuditEvent(deps.auditPort, {
    eventId: crypto.randomUUID(),
    eventType: "approval.rejected",
    workItemId: approval.workItemId,
    actor: "system",
    timestamp: nowIso(),
    traceId,
    payload: {
      approvalId: approval.id,
      reason,
    },
  });
};

const handleStatusCommand = async (
  deps: WorkerDeps,
  message: InboundMessage,
  workItemId: string | null,
): Promise<void> => {
  if (!workItemId) {
    await sendMessage(
      deps.chatPort,
      {
        chatId: message.chatId,
        text: "Usage: /status <workItemId>",
      },
      { command: "status" },
    );
    return;
  }

  const workItem = await deps.workItemStore.getById(workItemId);
  if (!workItem) {
    await sendMessage(
      deps.chatPort,
      {
        chatId: message.chatId,
        text: `No work item found for id ${workItemId}.`,
      },
      { command: "status", workItemId },
    );
    return;
  }

  const plan = await deps.planStore.getPlanByWorkItemId(workItemId);
  const approval =
    await deps.approvalStore.getLatestApprovalByWorkItemId(workItemId);
  const approvalText = approval
    ? `; approval=${approval.status}${approval.status === "pending" ? `(${approval.id})` : ""}`
    : "";

  await sendMessage(
    deps.chatPort,
    {
      chatId: message.chatId,
      text: `Work item ${workItem.id}: status=${workItem.status}; plan=${plan ? "ready" : "pending"}${approvalText}`,
    },
    { command: "status", workItemId },
  );
};

const handleExplainCommand = async (
  deps: WorkerDeps,
  message: InboundMessage,
  workItemId: string | null,
): Promise<void> => {
  if (!workItemId) {
    await sendMessage(
      deps.chatPort,
      {
        chatId: message.chatId,
        text: "Usage: /explain <workItemId>",
      },
      { command: "explain" },
    );
    return;
  }

  const workItem = await deps.workItemStore.getById(workItemId);
  if (!workItem) {
    await sendMessage(
      deps.chatPort,
      {
        chatId: message.chatId,
        text: `No work item found for id ${workItemId}.`,
      },
      { command: "explain", workItemId },
    );
    return;
  }

  const [plan, approval, artifact] = await Promise.all([
    deps.planStore.getPlanByWorkItemId(workItemId),
    deps.approvalStore.getLatestApprovalByWorkItemId(workItemId),
    deps.artifactStore.getArtifactByWorkItemId(workItemId),
  ]);

  await sendMessage(
    deps.chatPort,
    {
      chatId: message.chatId,
      text: formatExplainResponse({
        workItem,
        plan,
        approval,
        artifact,
      }),
    },
    { command: "explain", workItemId },
  );
};

const resolvePlanByApproval = async (
  deps: WorkerDeps,
  approval: ApprovalRecord,
): Promise<ExecutionPlan | null> =>
  deps.planStore.getPlanByWorkItemId(approval.workItemId);

const resolveArtifactByApproval = async (
  deps: WorkerDeps,
  approval: ApprovalRecord,
): Promise<GeneratedFileArtifact | null> =>
  deps.artifactStore.getArtifactByWorkItemId(approval.workItemId);

const handleApproveCommand = async (
  deps: WorkerDeps,
  message: InboundMessage,
  approvalId: string | null,
): Promise<void> => {
  if (!approvalId) {
    await sendMessage(
      deps.chatPort,
      {
        chatId: message.chatId,
        text: "Usage: /approve <approvalId>",
      },
      { command: "approve" },
    );
    return;
  }

  const approval = await deps.approvalStore.getApprovalById(approvalId);
  if (!approval) {
    await sendMessage(
      deps.chatPort,
      {
        chatId: message.chatId,
        text: `Approval rejected: NOT_FOUND for ${approvalId}.`,
      },
      { command: "approve", approvalId, reason: "NOT_FOUND" },
    );
    return;
  }

  if (approval.status === "denied") {
    await appendApprovalRejectedAudit(deps, approval, "ALREADY_DENIED");
    await sendMessage(
      deps.chatPort,
      {
        chatId: message.chatId,
        text: `Approval rejected: ALREADY_DENIED for ${approvalId}.`,
      },
      { command: "approve", approvalId, reason: "ALREADY_DENIED" },
    );
    return;
  }

  if (approval.status !== "pending") {
    await appendApprovalRejectedAudit(deps, approval, "REPLAYED");
    await sendMessage(
      deps.chatPort,
      {
        chatId: message.chatId,
        text: `Approval rejected: REPLAYED for ${approvalId}.`,
      },
      { command: "approve", approvalId, reason: "REPLAYED" },
    );
    return;
  }

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
        text: `Approval rejected: EXPIRED for ${approvalId}.`,
      },
      { command: "approve", approvalId, reason: "EXPIRED" },
    );
    await appendApprovalRejectedAudit(deps, approval, "EXPIRED");
    return;
  }

  const plan = await resolvePlanByApproval(deps, approval);
  const artifact = await resolveArtifactByApproval(deps, approval);
  if (!plan || !artifact) {
    await appendApprovalRejectedAudit(deps, approval, "MISMATCH");
    await sendMessage(
      deps.chatPort,
      {
        chatId: message.chatId,
        text: `Approval rejected: MISMATCH for ${approvalId}.`,
      },
      { command: "approve", approvalId, reason: "MISMATCH" },
    );
    return;
  }

  const hash = await approvalPayloadHash(plan, artifact);
  if (hash !== approval.payloadHash) {
    await appendApprovalRejectedAudit(deps, approval, "MISMATCH");
    await sendMessage(
      deps.chatPort,
      {
        chatId: message.chatId,
        text: `Approval rejected: MISMATCH for ${approvalId}.`,
      },
      {
        command: "approve",
        approvalId,
        reason: "MISMATCH",
        workItemId: approval.workItemId,
      },
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

  await appendAuditEvent(deps.auditPort, {
    eventId: crypto.randomUUID(),
    eventType: "execution.started",
    workItemId: approval.workItemId,
    actor: "assistant",
    timestamp: now,
    traceId,
    payload: {
      approvalId: approval.id,
      actionType: approval.actionType,
      artifactPath: artifact.path,
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
        artifactPath: artifact.path,
      },
    });

    await appendAuditEvent(deps.auditPort, {
      eventId: crypto.randomUUID(),
      eventType: "execution.completed",
      workItemId: approval.workItemId,
      actor: "assistant",
      timestamp: nowIso(),
      traceId,
      payload: {
        approvalId: approval.id,
        actionType: approval.actionType,
      },
    });

    await sendMessage(
      deps.chatPort,
      {
        chatId: message.chatId,
        text: `Approval accepted for work item ${approval.workItemId}. PR published: ${published.pullRequestUrl}`,
      },
      { command: "approve", approvalId, workItemId: approval.workItemId },
    );
  } catch (error) {
    const failureAt = nowIso();
    await deps.workItemStore.updateStatus(
      approval.workItemId,
      "cancelled",
      failureAt,
    );
    await appendAuditEvent(deps.auditPort, {
      eventId: crypto.randomUUID(),
      eventType: "execution.failed",
      workItemId: approval.workItemId,
      actor: "system",
      timestamp: failureAt,
      traceId,
      payload: {
        approvalId: approval.id,
        actionType: approval.actionType,
        error: String(error),
      },
    });

    await sendMessage(
      deps.chatPort,
      {
        chatId: message.chatId,
        text: `Approval accepted, but publish failed for work item ${approval.workItemId}: ${String(error)}`,
      },
      {
        command: "approve",
        approvalId,
        workItemId: approval.workItemId,
        error: String(error),
      },
    );
  }
};

const handleDenyCommand = async (
  deps: WorkerDeps,
  message: InboundMessage,
  approvalId: string | null,
): Promise<void> => {
  if (!approvalId) {
    await sendMessage(
      deps.chatPort,
      {
        chatId: message.chatId,
        text: "Usage: /deny <approvalId>",
      },
      { command: "deny" },
    );
    return;
  }

  const approval = await deps.approvalStore.getApprovalById(approvalId);
  if (!approval) {
    await sendMessage(
      deps.chatPort,
      {
        chatId: message.chatId,
        text: `Denial rejected: NOT_FOUND for ${approvalId}.`,
      },
      { command: "deny", approvalId, reason: "NOT_FOUND" },
    );
    return;
  }

  if (approval.status !== "pending") {
    await appendApprovalRejectedAudit(deps, approval, "REPLAYED");
    await sendMessage(
      deps.chatPort,
      {
        chatId: message.chatId,
        text: `Denial rejected: REPLAYED for ${approvalId}.`,
      },
      { command: "deny", approvalId, reason: "REPLAYED" },
    );
    return;
  }

  const now = nowIso();
  await deps.approvalStore.updateApprovalStatus(
    approval.id,
    "denied",
    now,
    "USER_DENIED",
  );
  await deps.workItemStore.updateStatus(approval.workItemId, "denied", now);
  const traceId =
    (await deps.workItemStore.getById(approval.workItemId))?.traceId ??
    "unknown";

  await appendAuditEvent(deps.auditPort, {
    eventId: crypto.randomUUID(),
    eventType: "approval.denied",
    workItemId: approval.workItemId,
    actor: "user",
    timestamp: now,
    traceId,
    payload: {
      approvalId: approval.id,
      actionType: approval.actionType,
    },
  });

  await sendMessage(
    deps.chatPort,
    {
      chatId: message.chatId,
      text: `Approval denied for work item ${approval.workItemId}. No external action will be executed.`,
    },
    { command: "deny", approvalId, workItemId: approval.workItemId },
  );
};

export const handleChatMessage = async (
  deps: WorkerDeps,
  message: InboundMessage,
): Promise<void> => {
  logInfo("chat.message.received", {
    chatId: message.chatId,
    sourceMessageId: message.sourceMessageId ?? null,
    chars: message.text.length,
  });

  const command = parseCommand(message.text);
  logInfo("chat.command.parsed", {
    chatId: message.chatId,
    command: command.type,
  });

  if (command.type === "status") {
    await handleStatusCommand(deps, message, command.workItemId);
    return;
  }

  if (command.type === "approve") {
    await handleApproveCommand(deps, message, command.approvalId);
    return;
  }

  if (command.type === "deny") {
    await handleDenyCommand(deps, message, command.approvalId);
    return;
  }

  if (command.type === "explain") {
    await handleExplainCommand(deps, message, command.workItemId);
    return;
  }

  if (!command.text) {
    await sendMessage(
      deps.chatPort,
      {
        chatId: message.chatId,
        text: "Please send a request with some detail.",
      },
      { command: "delegate", validation: "empty_text" },
    );
    return;
  }

  const timestamp = nowIso();
  const workItem: WorkItem = {
    id: crypto.randomUUID(),
    traceId: crypto.randomUUID(),
    status: "delegated",
    summary: summarize(command.text),
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  await deps.workItemStore.create(workItem);
  logInfo("work_item.created", {
    workItemId: workItem.id,
    traceId: workItem.traceId,
    status: workItem.status,
  });

  await appendAuditEvent(deps.auditPort, {
    eventId: crypto.randomUUID(),
    eventType: "work_item.delegated",
    workItemId: workItem.id,
    actor: "user",
    timestamp,
    traceId: workItem.traceId,
    payload: {
      source: "telegram",
      text: command.text,
      chatId: message.chatId,
    },
  });

  let draft: ExecutionPlanDraft;
  try {
    draft = await deps.modelPort.plan({
      workItemId: workItem.id,
      text: command.text,
    });
  } catch (error) {
    const failureAt = nowIso();
    await deps.workItemStore.updateStatus(workItem.id, "cancelled", failureAt);
    await appendAuditEvent(deps.auditPort, {
      eventId: crypto.randomUUID(),
      eventType: "execution.failed",
      workItemId: workItem.id,
      actor: "system",
      timestamp: failureAt,
      traceId: workItem.traceId,
      payload: {
        stage: "plan",
        error: String(error),
      },
    });
    await sendMessage(
      deps.chatPort,
      {
        chatId: message.chatId,
        text: `Unable to plan work item ${workItem.id}: ${String(error)}`,
      },
      { command: "delegate", workItemId: workItem.id, stage: "plan_failed" },
    );
    return;
  }
  logInfo("plan.drafted", {
    workItemId: workItem.id,
    traceId: workItem.traceId,
    riskLevel: draft.riskLevel,
    requiresApproval: draft.requiresApproval,
  });

  const policy: PolicyDecision = await deps.policyEngine.evaluate(draft);
  logInfo("policy.evaluated", {
    workItemId: workItem.id,
    traceId: workItem.traceId,
    decision: policy.decision,
    reasonCode: policy.reasonCode,
  });

  const plan: ExecutionPlan = {
    id: crypto.randomUUID(),
    workItemId: workItem.id,
    createdAt: nowIso(),
    ...draft,
  };

  let generated: GenerateResult;
  try {
    generated = await deps.modelPort.generate({
      workItemId: workItem.id,
      text: command.text,
      plan: draft,
    });
  } catch (error) {
    const failureAt = nowIso();
    await deps.workItemStore.updateStatus(workItem.id, "cancelled", failureAt);
    await appendAuditEvent(deps.auditPort, {
      eventId: crypto.randomUUID(),
      eventType: "execution.failed",
      workItemId: workItem.id,
      actor: "system",
      timestamp: failureAt,
      traceId: workItem.traceId,
      payload: {
        stage: "generate",
        error: String(error),
      },
    });
    await sendMessage(
      deps.chatPort,
      {
        chatId: message.chatId,
        text: `Unable to generate changes for work item ${workItem.id}: ${String(error)}`,
      },
      {
        command: "delegate",
        workItemId: workItem.id,
        stage: "generate_failed",
      },
    );
    return;
  }

  await deps.artifactStore.saveArtifact(
    workItem.id,
    generated.artifact,
    nowIso(),
  );
  await appendAuditEvent(deps.auditPort, {
    eventId: crypto.randomUUID(),
    eventType: "artifact.generated",
    workItemId: workItem.id,
    actor: "assistant",
    timestamp: nowIso(),
    traceId: workItem.traceId,
    payload: {
      path: generated.artifact.path,
      summary: generated.artifact.summary,
    },
  });

  await deps.planStore.createPlan(plan);
  logInfo("plan.persisted", {
    workItemId: workItem.id,
    traceId: workItem.traceId,
    planId: plan.id,
  });

  let nextStatus: WorkItem["status"] = "triaged";
  let approvalRecord: ApprovalRecord | null = null;

  if (policy.decision === "requires_approval") {
    const requestedAt = nowIso();
    approvalRecord = {
      id: crypto.randomUUID(),
      workItemId: workItem.id,
      actionType: approvalActionType,
      payloadHash: await approvalPayloadHash(plan, generated.artifact),
      status: "pending",
      requestedAt,
      expiresAt: addHours(requestedAt, 24),
      consumedAt: null,
      decisionReason: null,
    };
    await deps.approvalStore.createApproval(approvalRecord);
    nextStatus = "approval_pending";
    await appendAuditEvent(deps.auditPort, {
      eventId: crypto.randomUUID(),
      eventType: "approval.requested",
      workItemId: workItem.id,
      actor: "assistant",
      timestamp: nowIso(),
      traceId: workItem.traceId,
      payload: {
        approvalId: approvalRecord.id,
        actionType: approvalRecord.actionType,
        expiresAt: approvalRecord.expiresAt,
        reasonCode: policy.reasonCode,
      },
    });
    logInfo("approval.requested", {
      workItemId: workItem.id,
      traceId: workItem.traceId,
      approvalId: approvalRecord.id,
      expiresAt: approvalRecord.expiresAt,
    });
  }

  await deps.workItemStore.updateStatus(workItem.id, nextStatus, nowIso());
  logInfo("work_item.status_updated", {
    workItemId: workItem.id,
    traceId: workItem.traceId,
    status: nextStatus,
  });

  await appendAuditEvent(deps.auditPort, {
    eventId: crypto.randomUUID(),
    eventType: "plan.created",
    workItemId: workItem.id,
    actor: "assistant",
    timestamp: nowIso(),
    traceId: workItem.traceId,
    payload: {
      planId: plan.id,
      riskLevel: plan.riskLevel,
      requiresApproval: policy.decision === "requires_approval",
    },
  });

  await appendAuditEvent(deps.auditPort, {
    eventId: crypto.randomUUID(),
    eventType: "work_item.triaged",
    workItemId: workItem.id,
    actor: "assistant",
    timestamp: nowIso(),
    traceId: workItem.traceId,
    payload: {
      status: "triaged",
      planId: plan.id,
    },
  });

  await sendMessage(
    deps.chatPort,
    {
      chatId: message.chatId,
      text: formatPlanResponse(
        { ...workItem, status: nextStatus, updatedAt: nowIso() },
        plan,
        generated.artifact,
        approvalRecord,
      ),
    },
    {
      workItemId: workItem.id,
      traceId: workItem.traceId,
      approvalId: approvalRecord?.id ?? null,
      command: "delegate",
    },
  );
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
          await handleChatMessage(deps, update.message);
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
