# Personal Assistant v0 Working Plan

Status: active

## Purpose
Track execution for the thin Telegram-to-pi-agent relay runtime and keep roadmap, code, and quality gates aligned.

## Canonical Runtime (Current)
- Telegram is transport only.
- pi-agent (via OpenRouter) owns execution behavior and safety controls.
- Wrapper owns routing, topic-aware session continuity, retries/timeouts, and readiness.
- `/start` is first-message-only; all other turns are plain relay.

## Active Runtime Surface
- `apps/assistant-core/src/main.ts`
- `apps/assistant-core/src/worker.ts`
- `apps/assistant-core/src/http.ts`
- `apps/assistant-core/src/session-store.ts`
- `packages/adapters-telegram/src/index.ts`
- `packages/adapters-model-pi-agent/src/index.ts`
- `packages/ports/src/index.ts`
- `packages/domain/src/index.ts`

## Legacy/Out-of-Path Surface
- Historical workflow-era packages remain in repository history but are not part of the runtime hot path.
- Any reactivation of those modules requires explicit scope update in this file and corresponding CI coverage updates.

## Locked Decisions
- Runtime/package manager: `bun`
- Interface: Telegram long polling
- Session key: `chatId:threadId` with `root` fallback
- Session defaults: idle timeout 45m, max in-memory sessions 5, retry attempts 1
- Model adapter: pi-agent via OpenRouter (no local server management)
- Readiness contract: fail `GET /ready` when model adapter is unavailable

## Next Milestones

Feature planning note:
- Reliability/ops milestones (R3+) remain active for runtime hardening.
- Email capability milestones (R5/R6) are the next product-facing feature track and should proceed as thin wrapper slices.

### R1 - Docs and Scope Convergence
Scope:
- Remove stale workflow-era milestones from active plan
- Keep docs index and working plan aligned with thin relay runtime
- Make active vs legacy module boundaries explicit

Exit criteria:
- `docs/00-09_meta/00-index.md` and this file describe the same active runtime surface
- No active milestone depends on workflow-era approval/plan orchestration

### R2 - Relay Reliability Hardening
Scope:
- Harden transport-level retry/timeout behavior under transient failures
- Keep stale-session recovery deterministic and observable
- Add focused tests for timeout/retry/fallback branches

Exit criteria:
- Hung/failed relay turns consistently fail fast and recover or return clear user fallback
- Reliability logs include stable event names for timeout/error/retry outcomes

### R3 - Ops Visibility and Readiness Signals
Scope:
- Keep `/health` and `/ready` minimal but diagnostically useful
- Ensure readiness failures expose stable reason codes for operator debugging
- Document expected degraded states and operator actions

Exit criteria:
- Operators can determine if failure is session store, transport reachability, or model path
- Docs include practical runbook notes for local service recovery

### R4 - Repository Boundary Cleanup
Scope:
- Archive or remove legacy out-of-path packages that no longer compile against active contracts
- Keep only actively used modules in primary code path
- Update docs and scripts to reflect the resulting boundary

Exit criteria:
- Active repository surface matches documented runtime surface
- No ambiguous ownership of legacy workflow modules remains

### R5 - Email Delegation (Read + Draft, No Send)
Scope:
- Accept delegated email content (forwarded by user) as conversational work input
- Produce concise email summaries, draft reply options, and proposed action items in Telegram
- Keep wrapper responsibilities transport-level and avoid mailbox automation in hot path

Exit criteria:
- Delegated email content can be processed end-to-end through Telegram relay turns
- Assistant returns useful summary + draft replies without sending external messages
- No outbound email side effects are introduced

### R6 - Email Send (Approval-Gated)
Scope:
- Add send preview contract for outbound email drafts
- Require explicit `Approve` decision before any send action
- Keep approval and safety ownership primarily in the model adapter; wrapper only handles transport/state handoff

Exit criteria:
- Outbound email send requires explicit approval and is rejected otherwise
- Deny/revise flows keep conversation continuity and do not send
- Operator-visible logs clearly show preview, decision, and final send outcome

### R7.A - Core Primitives Extraction
Scope:
- Extract atomic operations from oversized files into `primitives/` directory
- Break down `worker.ts` (996 LOC → ~150 LOC)
- Create `services/` layer for business logic separation
- Target 200-250 LOC per file across codebase

Exit criteria:
- `worker.ts` reduced to ~150 LOC orchestration only
- `primitives/` directory with 5-6 atomic operation files
- All functions under 200 LOC, target 150 LOC average
- Workspace aliases resolve correctly in IDE

### R7.B - Service Composition & Configuration
Scope:
- Implement dependency injection layer with service composition
- Split monolithic config into feature-specific modules
- Refactor SQLite adapter (570 LOC → repository pattern)
- Create composition layer for clean service wiring

Exit criteria:
- Configuration split into 5-6 focused modules (~40-80 LOC each)
- SQLite adapter follows repository pattern with clear separation
- All tests pass with new structure
- Bundle size unchanged (no added dependencies)

## Risks
- API drift in Telegram/model provider transport behavior can cause relay instability
- Legacy modules drifting unnoticed can confuse roadmap and quality signals
- Over-expanding wrapper responsibilities can duplicate model adapter safety ownership
- Email provider integration and identity setup can create operational complexity if introduced too early

## Definition of Done (Per Milestone)
- Changes keep wrapper responsibilities transport-level and minimal
- `bun run verify` passes
- Docs for runtime surface and behavior are updated with the code

## CI Contract
- Single quality gate command: `bun run verify`
- Trigger policy:
  - `pull_request` on all branches
  - `push` on `main`
- Checks fail fast on any warning/error/failing validation

## Progress Log

Template:
- Date:
- Completed:
- Decisions:
- Files changed:
- Blockers/notes:

2026-02-08
- Completed: Stopped supervisor restart loop by classifying worker exit code `0` as clean stop instead of unexpected crash.
- Decisions: Added explicit worker-exit classification to keep requested restarts (`75`) unchanged while preventing ping-pong respawn between duplicate supervisors.
- Files changed: `apps/assistant-core/src/main.ts`, `apps/assistant-core/src/main.test.ts`, `docs/30-39_execution/30-v0-working-plan.md`.
- Blockers/notes: Loop still requires eliminating duplicate top-level runtimes (launchd + manual) in local process manager.

2026-02-08
- Completed: Hardened worker startup to reclaim ops port on `EADDRINUSE` by terminating prior listener process and retrying bind once.
- Decisions: Kept restart model simple (no backoff scheduler); implement one-shot port takeover (`SIGTERM` then `SIGKILL`) so self-restart can recover from overlapping instances.
- Files changed: `apps/assistant-core/src/main.ts`, `apps/assistant-core/src/main.test.ts`, `docs/30-39_execution/30-v0-working-plan.md`.
- Blockers/notes: Relies on `lsof` availability in runtime environment to discover listener PID.

2026-02-08
- Completed: Added supervisor-managed rolling restart flow so chat-triggered restarts drain gracefully and auto-recover.
- Decisions: Introduced deterministic runtime restart intent (`restart assistant`/`restart`) in wrapper control plane and delegated process relaunch to supervisor to avoid manual restart loops.
- Files changed: `apps/assistant-core/src/main.ts`, `apps/assistant-core/src/worker.ts`, `apps/assistant-core/src/worker.test.ts`, `apps/assistant-core/src/http.ts`, `docs/20-29_architecture/20-v0-architecture-effectts.md`, `docs/30-39_execution/31-v0-implementation-blueprint.md`, `docs/30-39_execution/30-v0-working-plan.md`.
- Blockers/notes: Overlapping zero-downtime handoff is not implemented because worker and replacement bind the same ops port; current flow is graceful stop/start with fast restart.

2026-02-08
- Completed: Added per-topic workspace switching with deterministic workspace intents and per-workspace session continuity.
- Decisions: Kept wrapper intent handling deterministic for control-plane actions (`use repo`, `where am i`, `list repos`) and delegated all non-control conversation to the model adapter.
- Files changed: `apps/assistant-core/src/worker.ts`, `apps/assistant-core/src/worker.test.ts`, `apps/assistant-core/src/session-store.ts`, `apps/assistant-core/src/main.ts`, `packages/ports/src/index.ts`, `packages/adapters-model-pi-agent/src/index.ts`, `docs/20-29_architecture/20-v0-architecture-effectts.md`, `docs/30-39_execution/31-v0-implementation-blueprint.md`, `docs/30-39_execution/30-v0-working-plan.md`.
- Blockers/notes: None.

2026-02-08
- Completed: Executed R4 boundary cleanup by removing legacy workflow-era packages that were out of the active relay runtime path.
- Decisions: Archived-by-removal for unused modules to keep active repository surface aligned with documented runtime scope and CI/lint signals.
- Files changed: `packages/adapters-github/package.json`, `packages/adapters-github/src/index.ts`, `packages/adapters-sqlite/package.json`, `packages/adapters-sqlite/src/index.ts`, `packages/adapters-sqlite/src/index.test.ts`, `packages/policy/package.json`, `packages/policy/src/index.ts`, `packages/audit/package.json`, `packages/audit/src/index.ts`, `docs/30-39_execution/30-v0-working-plan.md`.
- Blockers/notes: None.

2026-02-08
- Completed: Added the next feature track for email delegation and approval-gated sending as R5/R6.
- Decisions: Sequence email delivery in two slices (`read+draft` first, `send` second) to preserve thin runtime scope and explicit approval guarantees.
- Files changed: `docs/30-39_execution/30-v0-working-plan.md`, `docs/10-19_product/10-v0-requirements.md`, `docs/20-29_architecture/20-v0-architecture-effectts.md`, `docs/00-09_meta/00-index.md`.
- Blockers/notes: Provider choice and assistant mailbox identity setup remain deferred prerequisites for implementation.

2026-02-08
- Completed: Aligned active working plan to the thin relay runtime and replaced stale workflow-era milestones with relay-native milestones (R1-R4).
- Decisions: Declared explicit active runtime surface and legacy/out-of-path boundary; made docs-to-runtime alignment an explicit milestone gate.
- Files changed: `docs/30-39_execution/30-v0-working-plan.md`.
- Blockers/notes: Repository still contains legacy workflow-era packages pending explicit archive/remove decision in R4.

2026-02-08
- Completed: Hardened relay behavior for long-running requests with progress updates and safer timeout handling.
- Decisions: Timeout no longer implies stale session; only `session_invalid` errors trigger stale-mark + fresh-session retry; relay sends periodic progress updates (10s then every 30s, max 3) and keeps a 5-minute default timeout.
- Files changed: `apps/assistant-core/src/worker.ts`, `apps/assistant-core/src/worker.test.ts`, `packages/adapters-model-pi-agent/src/index.ts`, `apps/assistant-core/src/config.ts`, `apps/assistant-core/src/main.ts`, `apps/assistant-core/src/http.test.ts`, `config/config.example.json`, `docs/30-39_execution/31-v0-implementation-blueprint.md`, `docs/30-39_execution/30-v0-working-plan.md`.
- Blockers/notes: Long-running model turns still serialize per chat update in a single worker loop; queue parallelism by chat/thread can be considered in a future optimization pass.

2026-02-08 - Architecture and Code Organization Improvements
- Completed: Comprehensive codebase cleanup and organization improvements. Removed 4 empty packages (adapters-github, adapters-sqlite, audit, policy), implemented workspace aliases for clean imports, separated source and test code into src/ and tests/ directories.
- Decisions: Adopted hexagonal architecture documentation (ports & adapters), chose not to adopt EffectTS (+25KB bundle cost, existing patterns already robust), established 200-250 LOC file size targets with R7.A/R7.B refactoring milestones.
- Current File Size Metrics:
  * worker.ts: 996 LOC (target: 150 LOC, -85%)
  * session-store/index.ts: 570 LOC (target: 40 LOC facade, -93%)  
  * main.ts: 443 LOC (target: 200 LOC, -55%)
- Validation Results: 42 tests pass, TypeScript compiles, bundle size 60.72 KB, linting passes.
- Files changed: All package.json files updated, tsconfig.base.json with workspace aliases, 7 test files moved to tests/ directories, docs/20-29_architecture/20-v0-architecture.md renamed and updated, docs/00-09_meta/00-index.md updated, docs/30-39_execution/30-v0-working-plan.md updated with R7.A/R7.B milestones.
- Blockers/notes: None - codebase optimization complete and ready for next phase of service extraction.
