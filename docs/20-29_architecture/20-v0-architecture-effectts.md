# Personal Assistant v0 Architecture (Telegram <-> OpenCode Bridge)

Status: active

## 1. Product Frame

The assistant runtime is intentionally thin:
- Telegram is the transport surface.
- OpenCode is the execution and safety engine.
- The wrapper owns routing, session continuity, and service health only.

## 2. Runtime Topology

- Single Bun process (`apps/assistant-core`)
- In-process Telegram long poll worker
- Local SQLite for session mapping and Telegram cursor persistence
- Local OpenCode server (`opencode serve`) attached via HTTP
- Minimal HTTP endpoints for ops (`/health`, `/ready`)

## 3. Core Flow

1. Telegram message arrives.
2. Runtime computes `sessionKey = chatId + ":" + (threadId || "root")`.
3. Runtime loads persisted `opencodeSessionId` for session key (if any).
4. Runtime relays message to OpenCode using:
   - `opencode run --attach <url> --format json`
   - plus `--session <id>` when a prior session exists.
5. Runtime parses OpenCode JSON events, captures returned `sessionID`, persists mapping.
6. Runtime sends response back to the same chat/topic.

## 4. Session Continuity

Persistence contract:
- `sessionKey`
- `opencodeSessionId`
- `lastUsedAt`
- `status` (`active|stale`)
- Telegram polling cursor

Runtime behavior:
- In-memory session hints with LRU/idle eviction.
- Defaults:
  - idle timeout: 45 minutes
  - max in-memory sessions: 5
  - retry attempts on stale session: 1
- If resumed session fails:
  - mark mapping stale
  - retry once with no session id
  - persist new returned session id if retry succeeds

## 5. OpenCode Lifecycle

- Runtime probes OpenCode reachability via `modelPort.ping()`.
- If `opencodeAutoStart=true` and probe fails:
  - spawn `opencode serve --hostname <host> --port <port>`
  - wait until probe succeeds or timeout

This keeps local ops lightweight and self-healing.

## 6. Telegram Semantics

- `/start` is honored only as first message in a chat.
- Later `/start` messages are ignored.
- All other messages are relayed as plain conversation text.
- Topics are first-class via `message_thread_id` routing.

## 7. Safety Ownership

- OpenCode owns tool-execution safety, approvals, and operational guardrails.
- Wrapper does not implement a parallel policy/approval workflow in hot path.
- Wrapper guardrails are transport-level only (timeouts, retries, routing integrity).

## 8. Ops Endpoints

`GET /health`
- Process alive.

`GET /ready`
- Session store reachable.
- OpenCode reachable.
- Fails with `503` when OpenCode is unavailable.

## 9. Ports and Adapters (Active)

Active contracts:
- `ChatPort`
- `ModelPort`

Active adapters:
- `packages/adapters-telegram`
- `packages/adapters-model-opencode-cli`
- `apps/assistant-core/src/session-store.ts`

Legacy workflow-oriented modules may remain in repo history but are not part of runtime path.

## 10. Configuration

Primary source:
- `~/.config/delegate-assistant/config.json`
- override path: `DELEGATE_CONFIG_PATH`

Key settings:
- Telegram: token, poll interval
- OpenCode: binary, model, attach URL, auto-start host/port
- Sessions: idle timeout, max concurrent, retry attempts
