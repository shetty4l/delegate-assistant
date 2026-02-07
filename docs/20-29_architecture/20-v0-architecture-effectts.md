# Personal Assistant v0 Architecture (EffectTS)

Status: active

This document turns the high-level requirements into an implementation-ready architecture for a delegated, approval-gated assistant.

## 1. Product Frame

The system is a coding agent in capability, but not in autonomy. It operates as a delegated operator with strict approval gates.

Core behaviors:
- Accept delegated requests from chat.
- Plan and draft freely.
- Block externally visible side effects until explicit approval.
- Execute approved actions and report outcomes.
- Keep immutable auditability across the full lifecycle.
- Keep chat language-first with concise responses and minimal required slash commands.

## 2. System Goals for v0

Must-have goals:
- Telegram as first chat interface.
- GitHub PR publishing behind approval.
- Assistant identity separation (assistant account/tokens, never user impersonation).
- Full audit log for replay and explanation.
- Self-improvement tasks go through the exact same workflow.

Out of scope for v0:
- Autonomous monitoring loops.
- Automatic merges.
- Multi-user tenancy.
- Fixed reminder/scheduling UX design (behavior should emerge through collaboration, not hardcoded flows).

## 3. Architectural Style

Pattern: Hexagonal architecture (Ports + Adapters) with EffectTS services.

Rules:
- Domain and policy layers do not import vendor SDKs.
- Adapters implement port interfaces and can be replaced without rewriting orchestration logic.
- Side effects only happen through Effect services so policy gates and auditing cannot be bypassed accidentally.

## 4. Runtime Topology (Local Mac Mini)

Deployment:
- Single Node.js process for v0.
- Fastify API for health/admin endpoints.
- Telegram long polling worker in-process (no public webhook requirement).
- SQLite for workflow state.
- JSONL append-only audit file for replay/debug.
- Exposed over Tailscale for local control-plane access.

Why this topology:
- Minimal ops overhead.
- Survives process restart via SQLite state.
- Easy migration path to queue/workflow engine later.

## 5. Core Domain Model

Primary entities:
- `WorkItem`: delegated request and current state.
- `ExecutionPlan`: structured interpretation and proposed actions.
- `ApprovalRequest`: one action requiring user approval.
- `ExecutionRun`: concrete execution of approved steps.
- `AuditEvent`: immutable record of significant transitions.

Shared identifiers:
- `workItemId`, `runId`, `approvalId`, `traceId`.

## 6. Workflow State Machine

States:
1. `delegated`
2. `triaged`
3. `draft_ready`
4. `approval_pending`
5. `approved` or `denied`
6. `executing`
7. `completed` | `failed` | `cancelled`

Transition constraints:
- Any high-risk action must pass through `approval_pending`.
- `denied` is terminal unless explicitly reopened by user intent.
- Every transition emits an `AuditEvent` before returning success.

## 7. Risk and Policy Model

Risk levels:
- `LOW`: read, summarize, classify, draft.
- `MEDIUM`: local non-publishing code edits.
- `HIGH`: publish PR, send external message, create/delete remote resource.
- `CRITICAL`: modify guardrails, identity controls, secret handling policy.

Policy outcomes:
- `allow`
- `deny`
- `requires_approval`

Approval integrity:
- Approval token is bound to `workItemId + actionType + payloadHash + expiry`.
- One-time use only.
- Any payload drift invalidates prior approval.

## 8. EffectTS Service Contracts (Ports)

Define services in `packages/ports` as `Effect.Service` or `Context.Tag` interfaces.

Required services:
- `ChatPort`
  - `receive(): Stream<InboundMessage>`
  - `send(message: OutboundMessage): Effect<void, ChatError>`
  - `requestApproval(req: ApprovalPrompt): Effect<void, ChatError>`
- `ModelPort`
  - `plan(input: PlanInput): Effect<PlanOutput, ModelError>`
  - `generate(input: GenerateInput): Effect<Artifacts, ModelError>`
  - `review(input: ReviewInput): Effect<ReviewOutput, ModelError>`
- `VcsPort`
  - `prepareBranch(ctx): Effect<BranchRef, VcsError>`
  - `applyPatch(ctx): Effect<PatchResult, VcsError>`
  - `runChecks(ctx): Effect<CheckReport, VcsError>`
  - `publishPr(ctx): Effect<PullRequestRef, VcsError>`
- `PolicyEngine`
  - `evaluate(action: ProposedAction): Effect<PolicyDecision, never>`
- `ApprovalStore`
  - `create(req): Effect<ApprovalRequest, StoreError>`
  - `consume(token): Effect<ApprovalDecision, StoreError>`
- `AuditPort`
  - `append(event: AuditEvent): Effect<void, AuditError>`
  - `timeline(workItemId): Stream<AuditEvent>`
- `WorkItemStore`
  - CRUD + transition primitives guarded by state machine checks.
- `SecretPort`
  - `get(name: SecretName): Effect<SecretValue, SecretError>`
- `MemoryPort`
  - `health(): Effect<MemoryHealth, MemoryError>`
  - `recall(input): Effect<MemoryRecallResult, MemoryError>`
  - `remember(input): Effect<MemoryRememberResult, MemoryError>`
  - `forget(input): Effect<MemoryForgetResult, MemoryError>`

Implementation note:
- Keep adapter errors strongly typed and map them to domain-level errors at orchestration boundary.

## 9. Adapter Strategy (v0)

Initial adapters:
- `TelegramChatAdapter` (long polling).
- `GitHubAdapter` (local `git` + `gh` CLI in assistant repo path).
- `OpencodeCliModelAdapter` (default model provider for v0 runtime).
- `SQLiteStoreAdapter`.
- `JsonlAuditAdapter`.
- `EnvSecretAdapter`.
- `EngramMemoryAdapter` (local HTTP service).

Future adapters should only require wiring a new `Layer`, not domain rewrites.

## 10. LLM Orchestration Pattern

Three-pass model flow:
1. Planner: produce structured plan with assumptions and ambiguities.
2. Builder: produce implementation artifacts/tool intents.
3. Reviewer: evaluate against policy/test checklist and flag risks.

Safety constraints:
- Models do not execute tools directly.
- Orchestrator executes allowed tools only after policy decision.
- Secret values are never included in prompts unless strictly required by a capability and explicitly permitted.

## 11. GitHub PR Capability Flow

Flow:
1. Work item delegated from chat.
2. Planner produces executable plan.
3. Builder generates changes.
4. Local checks run.
5. User receives concise approval request with risk, side effects, and `Approve / Revise / Deny` actions.
6. On approval, publish branch and PR.
7. Return PR URL to chat.
8. Persist full audit chain.

Non-goals:
- No auto-merge in v0.
- No force-push behavior.

## 12. Self-Improvement Capability

Self-update is treated as a normal work item targeting assistant repo(s).

Additional constraints:
- If changes touch guardrail-sensitive files (`policy`, `approval`, `identity`, `secrets`), classify as `CRITICAL`.
- Require explicit high-signal confirmation message in addition to normal approval action.

## 13. Data and Storage (SQLite + JSONL)

SQLite tables:
- `work_items`
- `plans`
- `approvals`
- `executions`
- `artifacts`
- `messages`
- `state_transitions`

JSONL log:
- Append-only `audit/events.jsonl` with serialized `AuditEvent`.
- Used for replay and post-mortem.

Consistency rule:
- Write transition + audit event in a single unit of work where possible.

## 14. Security Baseline

Required controls:
- GitHub CLI authentication scoped to assistant account and explicit repos.
- Telegram bot token scoped to bot only.
- Local model execution via `opencode` binary (or provider-specific key only when explicitly configured later).
- Redaction of secrets/tokens before logging.
- No secrets in git, chat memory, or persistent prompt artifacts.
- Memory outages are surfaced to the user with rate limiting to avoid chat spam.

## 15. Observability and Explainability

Minimum v0 telemetry:
- Structured logs with `traceId`, `workItemId`, `approvalId`.
- Event replay per `workItemId`.
- `explain` endpoint/command reconstructing rationale from stored artifacts/events.

User-facing explain output should answer:
- Why action was proposed.
- What information was used.
- What alternatives were considered.

## 16. Evolution Path

Planned increments after v0:
- Add new chat interfaces (Slack/web) by implementing `ChatPort`.
- Add email capability under the same policy/approval contract.
- Replace in-process worker with queue/workflow runtime when needed.
- Move from PAT to GitHub App for improved auth posture.
- Add model routing and provider failover behind `ModelPort`.
- Add richer reminder/scheduling capabilities after conversation-first UX and adaptive memory are stable.
