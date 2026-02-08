# Delegate Assistant

Delegate Assistant is a lightweight Telegram-to-OpenCode bridge.

The runtime is intentionally thin:
- Telegram is the chat interface.
- OpenCode handles execution behavior and safety controls.
- This wrapper handles message relay, topic-aware session continuity, and basic service health.

## Current Status

Design docs are in `docs/`:
- `docs/00-09_meta/00-index.md` (start here)
- `docs/10-19_product/10-v0-requirements.md`
- `docs/20-29_architecture/20-v0-architecture-effectts.md`
- `docs/30-39_execution/30-v0-working-plan.md`
- `docs/30-39_execution/31-v0-implementation-blueprint.md`

Current runtime entrypoints:
- `apps/assistant-core/src/main.ts`
- `apps/assistant-core/src/worker.ts`
- `apps/assistant-core/src/session-store.ts`
- `packages/adapters-telegram/src/index.ts`
- `packages/adapters-model-opencode-cli/src/index.ts`

## Version Policy

CI enforces strict version metadata before running the full verify pipeline.

- Root `package.json` must contain a valid SemVer `version`.
- On tag builds (`refs/tags/vX.Y.Z`), the tag version must exactly match `package.json`.
- In CI, runtime metadata must be present and non-ambiguous:
  - `GIT_SHA` (40-char lowercase sha)
  - `GIT_BRANCH` (not `unknown`)
  - `GIT_COMMIT_TITLE` (not `unknown`)

Run locally:
- `bun run policy:version`

## Manage macOS user service (launchd)

Use these commands to manage the local `bun run dev` LaunchAgent on macOS.

Service file:
- `~/Library/LaunchAgents/com.suyash.delegate-assistant.dev.plist`

Commands:
- Load/start: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.suyash.delegate-assistant.dev.plist`
- Enable at login: `launchctl enable gui/$(id -u)/com.suyash.delegate-assistant.dev`
- Restart now: `launchctl kickstart -k gui/$(id -u)/com.suyash.delegate-assistant.dev`
- Stop/unload: `launchctl bootout gui/$(id -u)/com.suyash.delegate-assistant.dev`
- Status: `launchctl print gui/$(id -u)/com.suyash.delegate-assistant.dev`
- Tail stderr log: `tail -f ~/Library/Logs/delegate-assistant.stderr.log`
- Tail stdout log: `tail -f ~/Library/Logs/delegate-assistant.stdout.log`

Power settings (Mac mini server baseline):
- Apply: `sudo pmset -c sleep 0 standby 0 autorestart 1 powernap 0`
- Verify: `pmset -g`
