# Personal Assistant v0 Implementation Blueprint

Status: active

This document defines the concrete build plan, package layout, and implementation contracts for v0.

## Implementation Notes (Current)

- M1 is implemented as a lean tracer bullet first.
- HTTP in M1 uses Bun's native server (`Bun.serve`) with Effect orchestration, while preserving ports/adapters boundaries.
- M1 persistence uses startup schema initialization for core tables (`work_items`, `audit_events`) before introducing a full migration runner.
- Quality gates are centralized under `bun run verify` and enforced in CI.
- M2 is implemented with real Telegram long polling and a deterministic `ModelPort.plan` stub; real OpenAI integration is deferred.
- M2 command behavior: `/status` is active, while `/approve` and `/deny` are explicit placeholders until M3 approval integrity is wired.
- M3 implements policy decisions plus approval integrity checks (one-time consumption, expiry, payload-hash validation) with auditable approval events.
- M3 adds structured JSON lifecycle logs to stdout for live operator visibility with correlation IDs.
- M4 is implemented with `ModelPort.plan` + `ModelPort.generate`, generated artifact persistence, approval hash binding, and local GitHub publish (`git` + `gh`) behind approval.
- Next milestones split into M5 (explain/recovery/test matrix), M6 (conversation-first UX bootstrap), and M7 (adaptive memory via Engram).

## 1. Monorepo Layout

```text
.
├── apps/
│   └── assistant-core/
│       ├── src/
│       │   ├── api/
│       │   ├── orchestrator/
│       │   ├── workers/
│       │   └── main.ts
│       └── package.json
├── packages/
│   ├── domain/
│   ├── ports/
│   ├── policy/
│   ├── audit/
│   ├── adapters-telegram/
│   ├── adapters-github/
│   ├── adapters-model-opencode-cli/
│   ├── adapters-sqlite/
│   ├── adapters-memory-engram/
│   └── adapters-secrets-env/
├── docs/
└── bun-workspace.toml
```

## 2. Day 1-3 Build Plan

### Day 1: Foundation
- Initialize workspace (`bun`, `tsconfig`, lint/test baseline).
- Add EffectTS core dependencies.
- Implement domain schemas and state machine transitions.
- Add SQLite schema + migration runner.
- Add append-only audit writer.
- Expose `GET /health` and `GET /ready`.

Deliverable:
- App boots with wired layers and can persist a synthetic `WorkItem` + `AuditEvent`.

### Day 2: Telegram + Planning Flow
- Implement `ChatPort` Telegram adapter with long polling.
- Parse inbound messages into delegated requests.
- Call `ModelPort.plan` and persist `ExecutionPlan`.
- Return concise response with next-step proposal.
- Add approval prompt rendering (explicit command syntax).

Deliverable:
- User can send Telegram request and receive a structured plan + approval prompt.

### Day 3: PR Publish Flow
- Implement GitHub adapter (local `git` + `gh` CLI flow).
- Implement approval token creation/consumption.
- Wire `publishPr` execution path behind approval gate.
- Post PR URL back to Telegram.
- Add initial end-to-end test for `delegate -> approve -> PR URL` flow.

Deliverable:
- Approved coding request opens a GitHub PR under assistant identity.

## 3. Domain Schemas (Effect Schema)

Use `@effect/schema` for runtime validation + static type inference.

Core schema set:
- `WorkItem`
- `WorkItemStatus`
- `RiskLevel`
- `ProposedAction`
- `PolicyDecision`
- `ApprovalRequest`
- `ApprovalDecision`
- `AuditEvent`

State transition guard:
- Implement `transition(workItem, nextState)` returning typed error on invalid transitions.

## 4. Event Taxonomy (Audit)

Required event types:
- `work_item.delegated`
- `work_item.triaged`
- `plan.created`
- `artifact.generated`
- `approval.requested`
- `approval.granted`
- `approval.denied`
- `approval.rejected`
- `execution.started`
- `execution.completed`
- `execution.failed`
- `vcs.pr_published`

Event envelope fields:
- `eventId`
- `eventType`
- `workItemId`
- `actor` (`user|assistant|system`)
- `timestamp`
- `traceId`
- `payload`

## 5. Policy Engine Contract

Input:
- `ProposedAction` with `riskLevel`, `sideEffectType`, `payloadHash`, `target`.

Output:
- `allow`
- `deny` (with reason code)
- `requires_approval` (with required confirmation mode)

Reason code examples:
- `MISSING_APPROVAL`
- `GUARDRAIL_PROTECTED_PATH`
- `DENIED_PREVIOUSLY`
- `INSUFFICIENT_SCOPE`

## 6. Approval Mechanics

Token design:
- Signed opaque token or random id with DB lookup.
- Bound to immutable tuple:
  - `workItemId`
  - `actionType`
  - `payloadHash`
  - `expiresAt`

Rules:
- Single consumption.
- Expired token is invalid.
- Mismatched payload hash rejects execution.

## 7. ModelPort v0 Contract

`plan(input)` returns:
- intent summary
- assumptions
- ambiguities/questions
- concrete action candidates (with risk hints)

`generate(input)` returns:
- patch/proposed files/messages
- execution notes

`review(input)` returns:
- issues
- risk flags
- test checklist outcomes

Prompting constraints:
- Include policy summary in system/developer prompt sections.
- Do not include secrets.
- Keep response format strict JSON for parse safety.

## 8. Telegram Adapter Behavior

Inbound parsing:
- Plain text is primary interaction surface and should support collaborative planning + revision.
- Natural approvals/denials/revisions are context-bound to active approval prompts.
- Slash commands remain available as fallback (`/approve`, `/deny`, `/status`, `/explain`).

Outbound style:
- concise summary
- explicit next step
- if approval is needed, include action, risk, side effects, expiry, and `Approve / Revise / Deny`
- expose full details only on demand (`details`/`verbose` style responses)

## 9. GitHub Adapter Behavior

v0 capabilities:
- create branch
- commit file changes
- push branch
- create PR

Required metadata:
- link back to `workItemId` in PR body
- include checks/limitations summary in PR body where available

Failure handling:
- map API/git failures to typed `VcsError`.
- persist retry-eligible vs non-retry-eligible classification.
- reconcile idempotent outcomes (if PR already exists for branch and diff matches, report success rather than false failure).

## 10. SQLite Schema v0

Minimum table set:
- `work_items`
- `approvals`
- `plans`
- `executions`
- `audit_events`
- `messages`
- `generated_artifacts`

Recommended indexes:
- `work_items(status, updated_at)`
- `approvals(work_item_id, status)`
- `audit_events(work_item_id, timestamp)`

## 11. Reliability and Recovery

On startup:
- recover in-flight work items from SQLite.
- resume `approval_pending` and `executing` based on safe resume policy.

Retry policy:
- transient adapter errors retry with backoff.
- policy denials and approval denials never retry automatically.

Idempotency:
- external execution steps keyed with idempotency token.

## 12. Testing Matrix

Unit tests:
- state machine transition validity.
- policy decisions and guardrail classification.
- approval token integrity checks.

Contract tests:
- each adapter satisfies corresponding port semantics.

Integration tests:
- Telegram delegation to approval flow.
- approved PR publish path.
- denied action remains non-executed.

Security tests:
- redaction pipeline removes secret-like patterns.
- no secret-bearing fields enter audit payloads.

## 13. Initial Config Surface

Environment variables:
- `TELEGRAM_BOT_TOKEN`
- `SQLITE_PATH`
- `AUDIT_LOG_PATH`
- `MODEL_PROVIDER` (`stub` | `opencode_cli`)
- `OPENCODE_BIN`
- `MODEL_NAME`
- `ASSISTANT_REPO_PATH`
- `GITHUB_BASE_BRANCH`
- `MEMORY_PROVIDER` (planned for M7)
- `ENGRAM_BASE_URL` (planned for M7)
- `ENGRAM_TIMEOUT_MS` (planned for M7)

Guidelines:
- validate env at boot with typed schema.
- fail fast on missing required values.

## 14. M6 + M7 Interaction Contracts

M6 conversation bootstrap:
- language-first intent router with command fallback
- compact response composer by default
- freeform revise loop before execution
- context-bound natural approval phrases

M7 adaptive memory:
- recall context before plan/generate
- remember only high-confidence preference/pattern/fact/decision/insight candidates
- forget-by-phrase orchestration: `recall -> resolve id -> forget`
- memory outage handling is surfaced to users and rate-limited

## 15. Review Gates Before Coding

Before implementation starts, confirm:
- event schema naming and stability expectations.
- command syntax for approval/deny/status in Telegram.
- PR body template and required metadata.
- sensitive path list for `CRITICAL` classification.

After confirmation, implementation can proceed in incremental vertical slices.
