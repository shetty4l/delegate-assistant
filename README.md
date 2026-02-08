# Delegate Assistant

Delegate Assistant is a lightweight Telegram-to-OpenCode bridge.

The runtime is intentionally thin:
- Telegram is chat interface.
- OpenCode handles execution behavior and safety controls.
- This wrapper handles message relay, topic-aware session continuity, and basic service health.

## Code Organization

Clean hexagonal architecture with workspace aliases:
- **6 active packages** (removed 4 empty packages)
- **Workspace aliases** for clean imports across modules
- **Test separation** with `src/` (production) and `tests/` directories
- **File size targets**: 200-250 LOC max (current refactoring in R7.A/R7.B)

**Current Runtime Entry Points:**
- `apps/assistant-core/src/main.ts` (443 LOC → target 200 LOC)
- `apps/assistant-core/src/worker.ts` (996 LOC → target 150 LOC)
- `apps/assistant-core/src/http.ts` (115 LOC)
- `apps/assistant-core/src/session-store.ts` (SQLite adapter, 570 LOC → target 40 LOC facade)
- `packages/adapters-telegram/src/index.ts`
- `packages/adapters-model-opencode-cli/src/index.ts`
- `packages/adapters-session-store-sqlite/src/index.ts` (repository pattern planned)

## Current Status

Design docs are in `docs/`:
- `docs/00-09_meta/00-index.md` (start here)
- `docs/10-19_product/10-v0-requirements.md`
- `docs/20-29_architecture/20-v0-architecture.md` (hexagonal patterns, workspace aliases)
- `docs/30-39_execution/30-v0-working-plan.md` (includes R7.A/R7.B refactoring roadmap)
- `docs/30-39_execution/31-v0-implementation-blueprint.md` (service composition patterns)

## Development Commands

```bash
# Development
bun run dev                # Start assistant with supervisor
bun run dev:web             # Start session manager UI

# Quality Gates
bun run validate             # Run all checks (test, build, lint, format)
bun run test                 # Run tests (42 tests passing)
bun run test:coverage        # Test coverage

# Configuration
bun run policy:version       # Validate version metadata
```

## Quality Status

✅ **All checks passing**
- 42 tests pass
- TypeScript compilation (strict mode)
- Bundle size: 60.72 KB
- Linting: 0 warnings
- Format checking: passes
- Documentation checking: passes

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

## Release Automation

Releases are automated via Release Please on `main`:

- Workflow: `.github/workflows/release.yml`
- Config: `release-please-config.json`
- Manifest: `.release-please-manifest.json`

Flow:
- Push/merge to `main` triggers release readiness checks (`policy:version` + `verify`).
- If releasable commits exist, Release Please opens or updates a release PR.
- Merging that PR updates `package.json` version, updates `CHANGELOG.md`, creates a `vX.Y.Z` tag, and publishes a GitHub release.

Guardrails:
- Do not create manual release tags.
- Protect `v*` tags in GitHub settings so only automation can create them.

## Session Manager Web UI (Astro)

`apps/session-manager-web` is a separate process that provides a read-only session
management dashboard for OpenCode session mappings.

Run locally:
- `bun run dev:web`

Endpoints:
- UI: `http://127.0.0.1:4321/sessions`
- API: `GET /api/sessions`, `GET /api/sessions/:id`

Database path resolution order:
- `SESSION_MANAGER_SQLITE_PATH`
- `sqlitePath` from `DELEGATE_CONFIG_PATH` (same config used by assistant-core)
- fallback: `~/.local/share/delegate-assistant/data/assistant.db`

Tailscale exposure example:
- `tailscale serve --bg --http=80 http://127.0.0.1:4321`

Security posture:
- Bind to localhost only.
- Publish access through Tailscale tailnet, not public internet.

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
