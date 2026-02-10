# Delegate Assistant Docs Index

Knowledge Index (Johnny Decimal)

## Current v0 Status
- Telegram <-> OpenCode relay runtime: active
- Topic-aware session continuity (`chatId:threadId`): active
- Persistent session/cursor store: active
- Topic workspace switching with per-workspace session continuity: active
- Supervisor-managed graceful worker restart: active
- OpenCode auto-start (`opencode serve`) + attach flow: active
- Minimal ops surface (`/health`, `/ready`): active
- CI quality gate is active: `bun run verify`

## Planned Next Capability
- Email delegation via forwarded content: summary + draft replies in Telegram
- Approval-gated email sending as a follow-up slice
- Canonical feature sequencing is tracked in `docs/30-39_execution/30-v0-working-plan.md`

## Active Runtime Surface
- `apps/assistant-core/src/main.ts`
- `apps/assistant-core/src/worker.ts`
- `apps/assistant-core/src/http.ts`
- `apps/assistant-core/src/config.ts`
- `apps/assistant-core/src/concurrency.ts`
- `apps/assistant-core/src/relay.ts`
- `apps/assistant-core/src/session.ts`
- `apps/assistant-core/src/workspace.ts`
- `apps/assistant-core/src/slash-commands.ts`
- `apps/assistant-core/src/messaging.ts`
- `apps/assistant-core/src/opencode-server.ts`
- `apps/assistant-core/src/session-store.ts`
- `packages/adapters-telegram/src/index.ts`
- `packages/adapters-model-pi-agent/src/index.ts`
- `packages/adapters-model-opencode-cli/src/index.ts`
- `packages/domain/src/index.ts`
- `packages/ports/src/index.ts`

## Legacy Surface
- Workflow-era packages may remain in repository history but are not part of the active relay runtime path.
- Canonical execution scope and next milestones are tracked in `docs/30-39_execution/30-v0-working-plan.md`.

## 00-09 Meta
- `docs/00-09_meta/00-index.md` - master docs index (this file)
- `docs/00-09_meta/01-doc-conventions.md` - numbering, status, and update rules

## 10-19 Product
- `docs/10-19_product/10-v0-requirements.md` - v0 product requirements and scope boundaries

## 20-29 Architecture
- `docs/20-29_architecture/20-v0-architecture.md` - v0 Telegram-topic to OpenCode session bridge architecture (hexagonal patterns, workspace aliases)

## Package Structure Optimization
- Cleaned up package structure from 10 to 6 active packages
- Removed 4 empty packages: adapters-github, adapters-sqlite, audit, policy
- Implemented workspace aliases for clean imports across packages
- Separated source and test code into src/ and tests/ directories

## 30-39 Execution
- `docs/30-39_execution/30-v0-working-plan.md` - active implementation plan and progress log
- `docs/30-39_execution/31-v0-implementation-blueprint.md` - detailed implementation contracts and build blueprint

## Legacy Paths (Transition)
- `docs/personal_assistant_v_0_high_level_requirements.md` -> `docs/10-19_product/10-v0-requirements.md`
- `docs/v0_architecture_effectts.md` -> `docs/20-29_architecture/20-v0-architecture-effectts.md`
- `docs/v0_implementation_blueprint.md` -> `docs/30-39_execution/31-v0-implementation-blueprint.md`
