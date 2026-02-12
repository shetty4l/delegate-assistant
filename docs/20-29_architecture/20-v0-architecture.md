# Personal Assistant v0 Architecture (Telegram <-> pi-agent Bridge)

Status: active

## 1. Product Frame

The assistant runtime is intentionally thin:
- Telegram is the transport surface.
- pi-agent (via OpenRouter) is the execution and safety engine.
- The wrapper owns routing, session continuity, and service health only.

## 2. Runtime Topology

- Supervisor Bun process (`apps/assistant-core`) with one managed worker child
- In-worker Telegram long poll loop
- Local SQLite for session mapping and Telegram cursor persistence
- pi-agent model adapter for LLM execution via OpenRouter
- Minimal HTTP endpoints for ops (`/health`, `/ready`)

## 3. Core Flow

1. Telegram message arrives.
2. Runtime computes `sessionKey = chatId + ":" + (threadId || "root")`.
3. Runtime resolves active workspace for topic (default `assistantRepoPath`).
4. Runtime loads persisted `sessionId` for `(topicKey, workspacePath)`.
5. Runtime relays message to pi-agent model adapter.
6. Runtime captures returned `sessionId`, persists mapping.
7. Runtime sends response back to the same chat/topic.

## 4. Session Continuity

Persistence contract:
- `topicKey` (`chatId:threadId`)
- `workspacePath`
- `sessionKey` (`[topicKey, workspacePath]`)
- `sessionId`
- `lastUsedAt`
- `status` (`active|stale`)
- Telegram polling cursor

Workspace contract:
- topic-to-active-workspace binding is persisted
- per-topic workspace history is persisted
- switching workspaces does not destroy prior workspace session continuity

Runtime behavior:
- In-memory session hints with LRU/idle eviction.
- Defaults:
  - idle timeout: 45 minutes
  - max in-memory sessions: 5
  - retry attempts on stale session: 1
  - relay timeout: 5 minutes
  - progress updates: first at 10 seconds, then every 30 seconds (max 3)
- If resumed session fails with `session_invalid`:
  - mark mapping stale
  - retry once with no session id
  - persist new returned session id if retry succeeds
- If resumed session fails with timeout/transport errors:
  - keep existing mapping
  - return a user-visible failure response

## 5. Model Adapter Lifecycle

- Runtime probes model adapter reachability via `modelPort.ping()`.
- pi-agent adapter connects to OpenRouter; no local server management needed.

This keeps local ops lightweight.

## 6. Telegram Semantics

- `/start` is honored only as first message in a chat.
- Later `/start` messages are ignored.
- All other messages are relayed as plain conversation text.
- Topics are first-class via `message_thread_id` routing.

Deterministic wrapper intents (control plane):
- `use repo <path>`: switch active workspace for this topic
- `where am i` / `pwd`: report active workspace path
- `list repos` / `repos`: list known workspaces for this topic
- `restart assistant` / `restart`: request graceful worker restart

All other messages remain normal relay turns to the model adapter.

Restart behavior:
- worker acknowledges restart intent to chat
- worker enters drain mode (stop polling new updates, finish in-flight turn)
- worker exits with restart code
- supervisor starts fresh worker process automatically

## 7. Safety Ownership

- The model adapter (pi-agent) owns tool-execution safety, approvals, and operational guardrails.
- Wrapper does not implement a parallel policy/approval workflow in hot path.
- Wrapper guardrails are transport-level only (timeouts, retries, routing integrity).

## 8. Ops Endpoints

`GET /health`
- Process alive.

`GET /ready`
- Session store reachable.
- Model adapter reachable.
- Fails with `503` when model adapter is unavailable.

## 9. Ports and Adapters (Active)

Active contracts:
- `ChatPort`
- `ModelPort`

Active adapters:
- `packages/adapters-telegram`
- `packages/adapters-model-pi-agent` (default)
- `apps/assistant-core/src/session-store.ts`

Legacy workflow-oriented modules may remain in repo history but are not part of runtime path.

## 10. Workspace Aliases and Module Organization

The codebase uses workspace aliases for clean, resilient imports:

**tsconfig.base.json paths:**
```json
{
  "baseUrl": ".",
  "paths": {
    "@assistant-core/src/*": ["apps/assistant-core/src/*"],
    "@delegate/domain/*": ["packages/domain/src/*"],
    "@delegate/ports/*": ["packages/ports/src/*"],
    "@delegate/adapters-telegram/*": ["packages/adapters-telegram/src/*"],
    "@delegate/adapters-model-stub/*": ["packages/adapters-model-stub/src/*"],
    "@delegate/adapters-session-store-sqlite/*": ["packages/adapters-session-store-sqlite/src/*"]
  }
}
```

**Test Separation:**
- Production code: `src/` directories
- Test code: `tests/` directories  
- Package test scripts: `bun test tests/`

**Package Structure (Post-Cleanup):**
- 6 active packages (removed 4 empty packages)
- Clean hexagonal architecture: domain → ports → adapters

## 11. Configuration

Primary source:
- `~/.config/delegate-assistant/config.json`
- override path: `DELEGATE_CONFIG_PATH`

Key settings:
- Telegram: token, poll interval
- Model: provider (`stub|pi_agent`), pi-agent provider/model/max steps
- Sessions: idle timeout, max concurrent, retry attempts
- Relay behavior: timeout, progress first interval, progress repeat interval, progress max count
- Concurrency: max concurrent topics

API keys are stored in `~/.config/delegate-assistant/secrets.env` (not in config.json).
Provider-specific env vars (e.g., `OPENROUTER_API_KEY`, `GROQ_API_KEY`, `GEMINI_API_KEY`)
are resolved by pi-ai at runtime. `PI_AGENT_API_KEY` is accepted as a universal override.
