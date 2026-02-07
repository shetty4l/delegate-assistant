# Delegate Assistant Docs Index

Knowledge Index (Johnny Decimal)

## Current v0 Status
- Telegram <-> OpenCode relay runtime: active
- Topic-aware session continuity (`chatId:threadId`): active
- Persistent session/cursor store: active
- OpenCode auto-start (`opencode serve`) + attach flow: active
- Minimal ops surface (`/health`, `/ready`): active
- CI quality gate is active: `bun run verify`

## 00-09 Meta
- `docs/00-09_meta/00-index.md` - master docs index (this file)
- `docs/00-09_meta/01-doc-conventions.md` - numbering, status, and update rules

## 10-19 Product
- `docs/10-19_product/10-v0-requirements.md` - v0 product requirements and scope boundaries

## 20-29 Architecture
- `docs/20-29_architecture/20-v0-architecture-effectts.md` - v0 Telegram-topic to OpenCode session bridge architecture

## 30-39 Execution
- `docs/30-39_execution/30-v0-working-plan.md` - active implementation plan and progress log
- `docs/30-39_execution/31-v0-implementation-blueprint.md` - detailed implementation contracts and build blueprint

## Legacy Paths (Transition)
- `docs/personal_assistant_v_0_high_level_requirements.md` -> `docs/10-19_product/10-v0-requirements.md`
- `docs/v0_architecture_effectts.md` -> `docs/20-29_architecture/20-v0-architecture-effectts.md`
- `docs/v0_implementation_blueprint.md` -> `docs/30-39_execution/31-v0-implementation-blueprint.md`
