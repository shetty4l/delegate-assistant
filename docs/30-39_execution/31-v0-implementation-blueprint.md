# 31-v0-implementation-blueprint.md

Status: active

This blueprint defines the current lightweight runtime: Telegram as transport, OpenCode as the execution and safety engine.

## 1. Runtime Shape

- Telegram receives user messages.
- Assistant runtime maps each message to topic key and active workspace.
- Runtime relays text to OpenCode (`run --attach`, with `--session` when known) using `cwd=activeWorkspacePath`.
- OpenCode response is relayed back to the same Telegram chat/topic.

No wrapper-side planning, approval workflow, or PR orchestration is in the hot path.

## 2. Session Continuity Contract

Session key:
- `topicKey = chatId + ":" + (threadId || "root")`
- `sessionKey = JSON.stringify([topicKey, workspacePath])`

Persistence:
- Store `(topicKey, workspacePath) -> opencodeSessionId`
- Store `lastUsedAt`
- Store status (`active|stale`)
- Persist Telegram polling cursor
- Store `topicKey -> activeWorkspacePath`
- Store per-topic workspace history

Behavior:
- Resolve active workspace per topic before each relay turn
- On message: try persisted/memory session id first
- If `session_invalid` occurs: mark stale, retry once without session id
- If `timeout` or transport errors occur: keep mapping and return a user-visible failure
- Persist returned `sessionID` from OpenCode JSON events
- Send progress updates for long-running turns while waiting

Deterministic workspace intents:
- `use repo <path>`: validates path and switches active workspace for current topic
- `where am i` / `pwd`: reports current active workspace
- `list repos` / `repos`: reports known workspaces for current topic
- Non-matching text continues through normal OpenCode relay path

Defaults:
- idle timeout: 45m
- max concurrent in-memory session hints: 5
- retry attempts on failed resumed session: 1
- relay timeout: 5m
- progress: first at 10s, then every 30s (max 3)

## 3. OpenCode Server Lifecycle

- Runtime uses a fixed attach URL (`opencodeAttachUrl`)
- If provider is `opencode_cli` and `opencodeAutoStart=true`, runtime ensures server:
  - probe with `modelPort.ping()`
  - if unavailable, spawn `opencode serve --hostname <host> --port <port>`
  - wait until probe succeeds or timeout

This mirrors the local auto-start pattern used for supporting services.

## 4. Telegram Behavior

Inbound:
- `/start` is handled only for the first message in a chat.
- Later `/start` messages are ignored.
- All other text is relayed to OpenCode.
- Workspace-intent commands are handled wrapper-side before relay.

Topics:
- `message_thread_id` is captured as `threadId`.
- Replies include `message_thread_id` so responses stay in the same topic.

## 5. HTTP Ops Surface

`GET /health`
- process alive only

`GET /ready`
- session store reachable
- OpenCode reachable (`modelPort.ping`)

If OpenCode is unavailable, readiness must fail (503).

## 6. Config Surface

Primary source:
- JSON file at `DELEGATE_CONFIG_PATH` or default `~/.config/delegate-assistant/config.json`
- missing/invalid config file fails startup

Required keys:
- `port`
- `sqlitePath`
- `telegramBotToken`
- `telegramPollIntervalMs`
- `modelProvider` (`stub|opencode_cli`)
- `opencodeBin`
- `modelName`
- `assistantRepoPath`
- `opencodeAttachUrl`
- `opencodeAutoStart`
- `opencodeServeHost`
- `opencodeServePort`
- `sessionIdleTimeoutMs`
- `sessionMaxConcurrent`
- `sessionRetryAttempts`
- `relayTimeoutMs`
- `progressFirstMs`
- `progressEveryMs`
- `progressMaxCount`

Optional env overrides:
- `PORT`, `SQLITE_PATH`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_POLL_INTERVAL_MS`
- `MODEL_PROVIDER`, `OPENCODE_BIN`, `MODEL_NAME`, `ASSISTANT_REPO_PATH`
- `OPENCODE_ATTACH_URL`, `OPENCODE_AUTO_START`, `OPENCODE_SERVE_HOST`, `OPENCODE_SERVE_PORT`
- `SESSION_IDLE_TIMEOUT_MS`, `SESSION_MAX_CONCURRENT`, `SESSION_RETRY_ATTEMPTS`
- `RELAY_TIMEOUT_MS`, `PROGRESS_FIRST_MS`, `PROGRESS_EVERY_MS`, `PROGRESS_MAX_COUNT`

## 7. In-Scope Packages

Hot path:
- `apps/assistant-core/src/main.ts`
- `apps/assistant-core/src/worker.ts`
- `apps/assistant-core/src/http.ts`
- `apps/assistant-core/src/opencode-server.ts`
- `apps/assistant-core/src/session-store.ts`
- `packages/adapters-telegram/src/index.ts`
- `packages/adapters-model-opencode-cli/src/index.ts`

Legacy workflow-oriented modules may remain in the repository but are not part of the relay runtime path.

## 8. Acceptance Checks

- DM and topic messages create/continue independent OpenCode sessions.
- One topic can switch between multiple workspaces while preserving per-workspace session continuity.
- Workspace intents (`use repo`, `where am i`, `list repos`) are deterministic and never delegated to model interpretation.
- Restarting assistant runtime preserves session continuity via persisted mapping.
- If OpenCode server is down, runtime auto-starts it and resumes service.
- If a resumed session is stale, one retry with fresh session succeeds or user gets immediate outage message.
- `bun run verify` passes.
