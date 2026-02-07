# Personal Assistant v0 Working Plan

Status: active

## Purpose
Track execution of a lightweight Telegram-to-OpenCode bridge runtime with persistent topic sessions and minimal wrapper logic.

## Milestone Status
- Telegram <-> OpenCode relay runtime: complete
- Topic-aware session continuity (`chatId:threadId`): complete
- Persisted session/cursor store: complete
- OpenCode auto-start + attach flow: complete
- Docs/runtime simplification pass: complete

## Canonical Runtime (Current)
- Telegram is transport only.
- OpenCode owns execution and safety behavior.
- Wrapper owns routing, session continuity, retries, and readiness.
- `/start` is first-message-only; all other turns are plain relay.
- Historical milestone entries below remain as implementation history.

## Non-Goals (v0)
- Autonomous monitoring loops
- Automatic email sending
- Automatic merges
- Multi-user tenancy
- Reminder/scheduling UX design lock-in (deferred to emerge via conversation)

## Locked Decisions
- Package manager/runtime: `bun`
- Primary interface: Telegram long polling
- Runtime model: thin Telegram wrapper over OpenCode sessions
- Session key: `chatId:threadId` (`root` fallback)
- OpenCode lifecycle: auto-start local `opencode serve` if attach endpoint unavailable
- Readiness contract: fail `/ready` when OpenCode is unavailable
- Session defaults: idle timeout 45m, max sessions 5, retry attempts 1
- Memory namespace: global
- Engram integration mode: external local service (no auth) with surfaced, rate-limited outage notices

## Milestones

### M1 - Foundation Tracer Bullet
Scope:
- Bun workspace scaffold
- Core schemas + state machine transitions
- SQLite store baseline + migrations
- JSONL append-only audit writer
- API readiness endpoints

Exit criteria:
- `assistant-core` boots locally
- `GET /health` and `GET /ready` return success
- Synthetic `WorkItem` and `AuditEvent` persist successfully

### M2 - Telegram Delegation + Planning
Scope:
- Telegram adapter (long polling)
- Inbound delegation parsing
- `ModelPort.plan` call + persisted `ExecutionPlan`
- Concise response with explicit next step

Exit criteria:
- Telegram message creates a `WorkItem`
- Plan is persisted and returned to user
- Approval prompt metadata is rendered when needed

### M3 - Policy + Approval Integrity
Scope:
- Policy decisions (`allow|deny|requires_approval`)
- Approval token creation/consumption
- Payload-hash, expiry, one-time-use checks
- Denial handling and terminal behavior

Exit criteria:
- Expired/replayed/mismatched approvals are rejected
- Denied actions do not execute
- Approval lifecycle is fully audited

### M4 - Approval-Gated GitHub PR Publish
Scope:
- GitHub adapter (`create branch -> commit -> push -> PR`)
- Publish path requires prior valid approval
- Telegram response includes PR URL

Exit criteria:
- Flow works end-to-end: `delegate -> approve -> PR URL`
- PR metadata links back to `workItemId`
- Publish events are auditable and replayable

### M5 - Explainability, Recovery, and Test Matrix
Scope:
- `/explain <workItemId>` timeline/rationale output
- Startup recovery for in-flight work items
- Unit, contract, integration, and security tests
- Publish-path reconciliation to avoid false-negative "publish failed" status after successful PR creation

Exit criteria:
- Explain output answers why/what/alternatives
- Safe resume behavior validated
- Required checks pass (typecheck, test, lint)

### M6 - Conversation-First UX Bootstrap
Scope:
- Natural-language-first intent routing (`plan`, `execute`, `approve`, `deny`, `revise`, `status`, `details`) with slash commands as fallback
- Compact Telegram response composer (short default, expanded details on demand)
- Explicit approval prompt contract with `Approve / Revise / Deny`
- Freeform revise loop that regenerates both plan and artifact, then rebinds approval via a fresh payload hash
- Context-bound natural approval/denial handling using a strict phrase allow-list and improved status clarity
- One-shot `details` intent that returns expanded output only for that request
- Discussion-only intent path (`discuss`/`brainstorm`) that collaborates without generating plan/artifact until requested

Exit criteria:
- Typical delegation and approval flows work without requiring slash commands
- Telegram responses are concise by default and avoid boilerplate dumps
- `Revise` supports freeform text, regenerates plan + artifact, and invalidates superseded pending approvals
- Natural confirmations (for example, "go ahead") only succeed when tied to exactly one currently pending approval
- `details` expands output on demand without toggling persistent verbose mode
- Discussion-only requests avoid plan/artifact generation until the user asks to propose a plan
- Natural approval/denial phrases outside the strict allow-list are treated as non-authoritative and trigger clarification

### M7 - Adaptive Memory via Engram
Scope:
- External `MemoryPort` adapter to local Engram HTTP service (`/health`, `/recall`, `/remember`, `/forget`)
- Recall-before-plan context injection to personalize collaboration
- High-confidence-only remember writes
- Forget-by-phrase orchestration (`recall -> resolve memory id -> forget`)
- Surfaced but rate-limited memory outage messaging in Telegram

Exit criteria:
- Memory recall influences planning/generation context in normal conversation paths
- Forget intent works from natural language with disambiguation when needed
- Memory writes are gated by confidence thresholds and category allow-list
- Assistant continues operating when memory service is unavailable and reports degraded memory status without chat spam

## Risk Register
- External API drift (Telegram/GitHub): isolate in adapters and add contract tests
- Approval bypass risk: enforce policy at orchestrator boundary only
- Secret leakage risk: redact logs, prohibit secrets in prompts/audit payloads
- State inconsistency risk: write transition and audit in one unit of work where possible

## Definition of Done
- All milestone exit criteria met
- No externally visible side effects without approval
- Assistant identity separation preserved
- Full traceability for delegated workflows
- Feedback loops green via `bun run verify` (`typecheck`, `lint`, `format:check`, `build`, `test`, `docs:check`)

## CI Contract
- Single quality gate command: `bun run verify`
- CI workflow trigger policy:
  - `pull_request` on all branches
  - `push` on `main`
- CI execution policy: fail fast and strict (warnings or check failures fail the run)

## Progress Log

Template:
- Date:
- Completed:
- Decisions:
- Files changed:
- Blockers/notes:

2026-02-07
- Completed: Updated roadmap to separate original M5 scope from new M6 conversation-first bootstrap and M7 adaptive memory milestones.
- Decisions: Locked language-first UX, fixed approval CTA contract (`Approve / Revise / Deny`), selected global memory namespace, selected external local Engram integration with surfaced rate-limited outage notices, and deferred reminder design lock-in.
- Files changed: `docs/00-09_meta/00-index.md`, `docs/10-19_product/10-v0-requirements.md`, `docs/20-29_architecture/20-v0-architecture-effectts.md`, `docs/30-39_execution/30-v0-working-plan.md`, `docs/30-39_execution/31-v0-implementation-blueprint.md`.
- Blockers/notes: M7 depends on wiring `MemoryPort` + Engram adapter and forget-by-id orchestration in assistant runtime.

2026-02-07
- Completed: Locked M6 interaction defaults for revise regeneration, strict natural confirmation phrases, and one-shot details behavior.
- Decisions: `Revise` always regenerates plan + artifact with fresh approval hash; natural approval/denial remains strict allow-list for safety; `details` is one-shot rather than persistent mode.
- Files changed: `docs/30-39_execution/30-v0-working-plan.md`, `docs/30-39_execution/31-v0-implementation-blueprint.md`.
- Blockers/notes: Phrase allow-list expansion is intentionally deferred until telemetry indicates meaningful misses.

2026-02-07
- Completed: Expanded M6 acceptance criteria with discussion-only behavior and locked strict starter phrase set for natural approval/denial.
- Decisions: Added explicit discuss-first mode (`discuss`/`brainstorm`) that suppresses plan/artifact generation until requested; locked starter allow-list phrases; confirmed manual self-update application in early phases.
- Files changed: `docs/10-19_product/10-v0-requirements.md`, `docs/30-39_execution/30-v0-working-plan.md`, `docs/30-39_execution/31-v0-implementation-blueprint.md`.
- Blockers/notes: Automatic merge detection and apply/restart orchestration remain intentionally deferred.

2026-02-07
- Completed: Implemented M6 conversation-first slice for strict natural intents, discussion mode, one-shot details intent routing, compact default plan replies, and revise-triggered regeneration with approval supersession.
- Decisions: Natural approval/denial resolves only when exactly one pending approval exists; discussion mode remains in-memory per chat session for v0; revise regenerates with existing work item summary context.
- Files changed: `apps/assistant-core/src/worker.ts`, `apps/assistant-core/src/worker.test.ts`, `docs/30-39_execution/30-v0-working-plan.md`.
- Blockers/notes: Discussion mode is not persisted across process restarts in v0.

2026-02-07
- Completed: M4 approval-gated PR publish plus model generation integration with `ModelPort.plan` + `ModelPort.generate`, repo-relative single-file artifacts, fail-fast model behavior, GitHub publish adapter (`branch -> commit -> push -> PR`), and Telegram PR URL response on approval.
- Decisions: Kept implementation lean for personal use (no plugin ecosystem), used `opencode` CLI model adapter without API key, enforced repo-relative generated file paths, chose fail-fast behavior on model errors, and deferred timeouts/retries plus multi-file generation.
- Files changed: `apps/assistant-core/src/config.ts`, `apps/assistant-core/src/main.ts`, `apps/assistant-core/src/worker.ts`, `apps/assistant-core/src/worker.test.ts`, `apps/assistant-core/package.json`, `packages/domain/src/index.ts`, `packages/ports/src/index.ts`, `packages/adapters-model-stub/src/index.ts`, `packages/adapters-sqlite/src/index.ts`, `packages/adapters-sqlite/src/index.test.ts`, `packages/adapters-model-opencode-cli/package.json`, `packages/adapters-model-opencode-cli/src/index.ts`, `packages/adapters-github/package.json`, `packages/adapters-github/src/index.ts`, `bun.lock`.
- Blockers/notes: Publish path expects local `git` + `gh` availability and authenticated GitHub CLI session in the configured repository path.

2026-02-07
- Completed: M3 policy and approval integrity with approval requests, one-time approval consumption, expiry and payload-hash checks, denial terminal behavior, and structured lifecycle logs.
- Decisions: Added `@delegate/policy` as a default policy engine package; retained strict orchestrator gate for `/approve` and `/deny`; kept execution message explicit that publish remains gated until M4.
- Files changed: `apps/assistant-core/src/main.ts`, `apps/assistant-core/src/worker.ts`, `apps/assistant-core/src/worker.test.ts`, `apps/assistant-core/package.json`, `packages/domain/src/index.ts`, `packages/ports/src/index.ts`, `packages/policy/package.json`, `packages/policy/src/index.ts`, `packages/adapters-sqlite/src/index.ts`, `packages/adapters-sqlite/src/index.test.ts`, `docs/00-09_meta/00-index.md`, `docs/30-39_execution/30-v0-working-plan.md`, `bun.lock`.
- Blockers/notes: Live worker logs now stream JSON lines to stdout and include correlation ids (`workItemId`, `traceId`, `approvalId`).

2026-02-07
- Completed: M2 Telegram delegation + planning slice with real Telegram long polling adapter, deterministic planner stub, persisted plans, command router, and status responses.
- Decisions: Deferred real OpenAI integration; `/status` is functional in M2 while `/approve` and `/deny` return explicit M3 placeholders; approval preview includes fixed "would expire in 24h" copy.
- Files changed: `apps/assistant-core/src/main.ts`, `apps/assistant-core/src/config.ts`, `apps/assistant-core/src/worker.ts`, `apps/assistant-core/src/worker.test.ts`, `apps/assistant-core/package.json`, `packages/domain/src/index.ts`, `packages/ports/src/index.ts`, `packages/adapters-sqlite/src/index.ts`, `packages/adapters-sqlite/src/index.test.ts`, `packages/adapters-telegram/package.json`, `packages/adapters-telegram/src/index.ts`, `packages/adapters-model-stub/package.json`, `packages/adapters-model-stub/src/index.ts`.
- Blockers/notes: `TELEGRAM_BOT_TOKEN` is required to run live polling; worker remains disabled when token is unset.

2026-02-07
- Completed: Refactored docs to Johnny Decimal structure and created active v0 working plan.
- Decisions: Kept legacy path stubs for one transition cycle; docs index title set to "Delegate Assistant Docs Index".
- Files changed: `docs/00-09_meta/00-index.md`, `docs/00-09_meta/01-doc-conventions.md`, `docs/10-19_product/10-v0-requirements.md`, `docs/20-29_architecture/20-v0-architecture-effectts.md`, `docs/30-39_execution/30-v0-working-plan.md`, `docs/30-39_execution/31-v0-implementation-blueprint.md`.
- Blockers/notes: None.

2026-02-07
- Completed: M1 foundation tracer bullet with bun workspace, Effect-based tracer flow, SQLite work item storage, JSONL audit append, and HTTP endpoints (`/health`, `/ready`, `/internal/tracer`).
- Decisions: Kept HTTP lean with Bun server + Effect runtime orchestration; internal tracer route gated by dev mode or `ENABLE_INTERNAL_ROUTES=true`; readiness returns `503` with reason codes.
- Files changed: `package.json`, `tsconfig.base.json`, `apps/assistant-core/src/main.ts`, `apps/assistant-core/src/http.ts`, `apps/assistant-core/src/config.ts`, `apps/assistant-core/src/runtime.ts`, `packages/domain/src/index.ts`, `packages/ports/src/index.ts`, `packages/adapters-sqlite/src/index.ts`, `packages/audit/src/index.ts`, `packages/domain/src/transition.test.ts`.
- Blockers/notes: Defaults now expand `~` to user home for `SQLITE_PATH` and `AUDIT_LOG_PATH`.

2026-02-07
- Completed: Added CI and GitHub integration with a strict single-command validation pipeline (`bun run verify`).
- Decisions: Kept docs validation as one command (`docs:check`) with local link checks only; CI runs on pull requests and pushes to `main`; no local git hooks for now.
- Files changed: `.github/workflows/ci.yml`, `.github/pull_request_template.md`, `package.json`, `apps/assistant-core/package.json`, `biome.json`, `.remarkrc.json`, `.gitignore`.
- Blockers/notes: None.

2026-02-07
- Completed: Switched runtime configuration to JSON-file-first loading with strict fail-fast behavior and env override precedence.
- Decisions: Config source defaults to `~/.config/delegate-assistant/config.json`; optional override path is `DELEGATE_CONFIG_PATH`; boot now logs config source and override count; execution intent threshold is file/env configurable.
- Files changed: `apps/assistant-core/src/config.ts`, `apps/assistant-core/src/main.ts`, `config/config.example.json`, `docs/30-39_execution/31-v0-implementation-blueprint.md`, `docs/30-39_execution/30-v0-working-plan.md`.
- Blockers/notes: Local runtime now requires creating a config file before startup.

2026-02-07
- Completed: Switched Telegram runtime to conversation-first behavior and removed operational slash-command workflow except first-message `/start`.
- Decisions: Non-`/start` messages now flow through model `respond`; casual chat no longer creates work items; execution proposals are persisted only when confidence passes threshold; natural `Approve/Revise/Deny` remain context-bound to pending approvals.
- Files changed: `apps/assistant-core/src/worker.ts`, `apps/assistant-core/src/worker.test.ts`, `packages/domain/src/index.ts`, `packages/ports/src/index.ts`, `packages/adapters-model-opencode-cli/src/index.ts`, `packages/adapters-model-stub/src/index.ts`, `apps/assistant-core/src/main.ts`, `docs/30-39_execution/31-v0-implementation-blueprint.md`, `docs/30-39_execution/30-v0-working-plan.md`.
- Blockers/notes: Engram-backed persistence is still pending integration; current conversation context is in-memory only.

2026-02-07
- Completed: Relaxed execution UX so routine local file changes are applied directly while publish/destructive paths remain confirmation-gated.
- Decisions: PR publishing now requires explicit publish-intent plus preview (branch/title/body) and approval; routine local edits auto-apply unless `previewDiffFirst=true`; destructive local intents require confirmation.
- Files changed: `apps/assistant-core/src/worker.ts`, `apps/assistant-core/src/worker.test.ts`, `apps/assistant-core/src/main.ts`, `apps/assistant-core/src/config.ts`, `config/config.example.json`, `docs/30-39_execution/31-v0-implementation-blueprint.md`, `docs/30-39_execution/30-v0-working-plan.md`.
- Blockers/notes: Action classification currently relies on intent heuristics (`publish` and destructive keyword patterns) and should later be replaced with model-side structured action typing.

2026-02-08
- Completed: Added persistent session mapping and cursor persistence primitives for Telegram topic-aware OpenCode session continuity.
- Decisions: Session key now uses `chatId:threadId` (with `threadId=root` fallback), worker keeps in-memory LRU/idle session hints (`max=5`, `45m`) with SQLite persistence backing, and retries once with a fresh session when resumed session calls fail.
- Files changed: `apps/assistant-core/src/session-store.ts`, `apps/assistant-core/src/worker.ts`, `apps/assistant-core/src/main.ts`, `apps/assistant-core/src/http.ts`, `apps/assistant-core/src/config.ts`, `packages/adapters-telegram/src/index.ts`, `packages/adapters-model-opencode-cli/src/index.ts`, `packages/adapters-model-stub/src/index.ts`, `packages/domain/src/index.ts`, `packages/ports/src/index.ts`, `config/config.example.json`, `docs/30-39_execution/30-v0-working-plan.md`.
- Blockers/notes: Worker still retains legacy proposal/approval orchestration path; next slice should replace it with a pure Telegram-to-OpenCode relay.

2026-02-08
- Completed: Replaced runtime hot path with a thin Telegram-to-OpenCode session relay and added automatic `opencode serve` supervision.
- Decisions: Wrapper now relays all non-`/start` messages directly through OpenCode sessions, session mapping persists by `chatId:threadId`, readiness hard-fails when OpenCode is unavailable, and runtime auto-starts OpenCode server if attach endpoint is not reachable.
- Files changed: `apps/assistant-core/src/worker.ts`, `apps/assistant-core/src/worker.test.ts`, `apps/assistant-core/src/main.ts`, `apps/assistant-core/src/http.ts`, `apps/assistant-core/src/config.ts`, `apps/assistant-core/src/opencode-server.ts`, `apps/assistant-core/src/session-store.ts`, `packages/adapters-model-opencode-cli/src/index.ts`, `packages/adapters-telegram/src/index.ts`, `packages/domain/src/index.ts`, `packages/ports/src/index.ts`, `config/config.example.json`, `docs/30-39_execution/30-v0-working-plan.md`.
- Blockers/notes: Legacy workflow-oriented domain/schema docs remain and should be slimmed in a follow-up docs-focused pass.

2026-02-08
- Completed: Stripped runtime dependencies and docs to align with the lightweight relay architecture.
- Decisions: Removed workflow-only app dependencies and deleted obsolete tracer runtime module; execution blueprint now documents the Telegram-topic session bridge as the authoritative implementation.
- Files changed: `apps/assistant-core/package.json`, `apps/assistant-core/src/config.ts`, `apps/assistant-core/src/main.ts`, `apps/assistant-core/src/http.ts`, `apps/assistant-core/src/runtime.ts`, `docs/30-39_execution/31-v0-implementation-blueprint.md`, `docs/30-39_execution/30-v0-working-plan.md`.
- Blockers/notes: Repository still contains legacy workflow packages for history, but they are no longer wired into the assistant runtime path.

2026-02-08
- Completed: Reduced shared contracts to chat/session relay essentials and simplified stub behavior to match the thin bridge runtime.
- Decisions: `@delegate/domain` now exposes minimal message/session response types plus legacy transition helper only; `@delegate/ports` now defines only `ChatPort` and `ModelPort` contracts needed by runtime.
- Files changed: `packages/domain/src/index.ts`, `packages/ports/src/index.ts`, `packages/adapters-model-stub/src/index.ts`, `docs/30-39_execution/30-v0-working-plan.md`.
- Blockers/notes: Legacy adapters that referenced removed workflow typings are intentionally out of runtime path and can be archived or deleted in a later cleanup milestone.
