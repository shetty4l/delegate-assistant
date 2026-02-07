import type {
  AuditEvent,
  ExecutionPlan,
  InboundMessage,
  WorkItem,
} from "@delegate/domain";
import type {
  AuditPort,
  ChatPort,
  ModelPort,
  PlanStore,
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
  auditPort: AuditPort;
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
): string => {
  const lines = [
    `Work item ${workItem.id}`,
    `Intent: ${plan.intentSummary}`,
    `Assumptions: ${plan.assumptions.join("; ")}`,
    `Ambiguities: ${plan.ambiguities.join("; ")}`,
    `Next: ${plan.proposedNextStep}`,
  ];

  if (plan.requiresApproval) {
    lines.push(
      `Approval preview: risk ${plan.riskLevel}; side effects ${plan.sideEffects.join(", ")}; would expire in 24h (enforced in M3).`,
    );
  }

  lines.push(`Check progress: /status ${workItem.id}`);
  return lines.join("\n");
};

const appendAuditEvent = async (
  auditPort: AuditPort,
  event: AuditEvent,
): Promise<void> => {
  await auditPort.append(event);
};

export const handleChatMessage = async (
  deps: WorkerDeps,
  message: InboundMessage,
): Promise<void> => {
  const command = parseCommand(message.text);

  if (command.type === "status") {
    if (!command.workItemId) {
      await deps.chatPort.send({
        chatId: message.chatId,
        text: "Usage: /status <workItemId>",
      });
      return;
    }

    const workItem = await deps.workItemStore.getById(command.workItemId);
    if (!workItem) {
      await deps.chatPort.send({
        chatId: message.chatId,
        text: `No work item found for id ${command.workItemId}.`,
      });
      return;
    }

    const plan = await deps.planStore.getPlanByWorkItemId(command.workItemId);
    await deps.chatPort.send({
      chatId: message.chatId,
      text: `Work item ${workItem.id}: status=${workItem.status}; plan=${plan ? "ready" : "pending"}`,
    });
    return;
  }

  if (command.type === "approve") {
    await deps.chatPort.send({
      chatId: message.chatId,
      text: `Approval flow activates in M3. Received approval id: ${command.approvalId ?? "(missing)"}.`,
    });
    return;
  }

  if (command.type === "deny") {
    await deps.chatPort.send({
      chatId: message.chatId,
      text: `Denial flow activates in M3. Received approval id: ${command.approvalId ?? "(missing)"}.`,
    });
    return;
  }

  if (command.type === "explain") {
    await deps.chatPort.send({
      chatId: message.chatId,
      text: `Explain output activates in M5. For now use /status ${command.workItemId ?? "<workItemId>"}.`,
    });
    return;
  }

  if (!command.text) {
    await deps.chatPort.send({
      chatId: message.chatId,
      text: "Please send a request with some detail.",
    });
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

  const draft = await deps.modelPort.plan({
    workItemId: workItem.id,
    text: command.text,
  });

  const plan: ExecutionPlan = {
    id: crypto.randomUUID(),
    workItemId: workItem.id,
    createdAt: nowIso(),
    ...draft,
  };

  await deps.planStore.createPlan(plan);
  await deps.workItemStore.updateStatus(workItem.id, "triaged", nowIso());

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
      requiresApproval: plan.requiresApproval,
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

  await deps.chatPort.send({
    chatId: message.chatId,
    text: formatPlanResponse(
      { ...workItem, status: "triaged", updatedAt: nowIso() },
      plan,
    ),
  });
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
        for (const update of updates) {
          cursor = update.updateId + 1;
          await handleChatMessage(deps, update.message);
        }
      } catch (error) {
        console.error("telegram worker cycle failed", error);
      }

      await sleep(pollIntervalMs);
    }
  };

  return loop();
};
