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
- `apps/assistant-core/src/main.ts` (443 LOC)
- `apps/assistant-core/src/worker.ts` (996 LOC)
- `apps/assistant-core/src/http.ts` (115 LOC)
- `apps/assistant-core/src/session-store.ts` (SQLite adapter)
- `packages/adapters-telegram/src/index.ts`
- `packages/adapters-model-opencode-cli/src/index.ts`
- `packages/adapters-session-store-sqlite/src/index.ts`

## Current Status

Design docs are in `docs/`:
- `docs/00-09_meta/00-index.md` (start here)
- `docs/10-19_product/10-v0-requirements.md`
- `docs/20-29_architecture/20-v0-architecture.md` (hexagonal patterns, workspace aliases)
- `docs/30-39_execution/30-v0-working-plan.md`
- `docs/30-39_execution/31-v0-implementation-blueprint.md` (service composition patterns)

## Development Commands

```bash
# Development
bun run dev                # Start assistant with supervisor
bun run dev:web            # Start session manager UI

# Quality Gates
bun run validate           # Run all checks (test, build, lint, format)
bun run test               # Run tests
```

## Quality Status

- TypeScript compilation (strict mode)
- Linting: 0 warnings
- Format checking: passes
- Documentation checking: passes

## Releases

Releases are automated via GitHub Actions on merge to `main`:

- Workflow: `.github/workflows/release.yml`
- Versioning: auto-incrementing patch from the latest git tag
- Artifacts: source tarball attached to each GitHub Release

Flow:
1. Push/merge to `main` triggers the release workflow.
2. CI runs the full `verify` pipeline.
3. The next patch version is computed from the latest git tag.
4. A source tarball is created and published as a GitHub Release.
5. The server auto-updater picks up the new release within 5 minutes.

## Deployment

### Install (first time)

```bash
curl -fsSL https://github.com/shetty4l/delegate-assistant/releases/latest/download/install.sh | bash
```

The installer will:
- Download the latest release
- Install to `~/srv/delegate-assistant/<version>/`
- Run `bun install` and build the web dashboard
- Prompt for the Telegram bot token
- Write config to `~/.config/delegate-assistant/`
- Set up macOS LaunchAgents for auto-start and auto-update

### Architecture

```
~/srv/delegate-assistant/
  v0.1.1/                    # Release versions
  v0.1.2/
  latest -> v0.1.2/          # Symlink to active version
  current-version             # "v0.1.2"
  start-assistant.sh          # Wrapper: sources secrets, runs assistant
  start-web.sh                # Wrapper: sources secrets, runs web dashboard
  update-check.sh             # Checks GitHub for new releases every 5 min

~/.config/delegate-assistant/
  config.json                 # Application config (non-sensitive)
  secrets.env                 # TELEGRAM_BOT_TOKEN (chmod 600)
```

### LaunchAgents

Three macOS LaunchAgents manage the services:

| Service | Label | Description |
|---------|-------|-------------|
| Assistant | `com.suyash.delegate-assistant` | Telegram bot + OpenCode relay |
| Web Dashboard | `com.suyash.delegate-session-manager` | Astro SSR session viewer on :4321 |
| Auto-Updater | `com.suyash.delegate-assistant-updater` | Checks for new releases every 5 min |

Management commands:
```bash
# Restart assistant
launchctl kickstart -k gui/$(id -u)/com.suyash.delegate-assistant

# Restart web dashboard
launchctl kickstart -k gui/$(id -u)/com.suyash.delegate-session-manager

# Check status
launchctl list | grep delegate

# View logs
tail -f ~/Library/Logs/delegate-assistant.stderr.log
tail -f ~/Library/Logs/delegate-session-manager.stderr.log
tail -f ~/Library/Logs/delegate-assistant-updater.log
```

### Auto-Updates

The updater LaunchAgent runs every 5 minutes and:
1. Checks the GitHub API for the latest release
2. Downloads and extracts the new version
3. Runs `bun install` and `bun run build:web`
4. Updates the `latest` symlink
5. Restarts services
6. Prunes old versions (keeps the last 5)

## Session Manager Web UI (Astro)

`apps/session-manager-web` provides a read-only session management dashboard.

Endpoints:
- UI: `http://127.0.0.1:4321/sessions`
- API: `GET /api/sessions`, `GET /api/sessions/:id`

Database path resolution order:
- `SESSION_MANAGER_SQLITE_PATH`
- `sqlitePath` from `DELEGATE_CONFIG_PATH` (same config used by assistant-core)
- fallback: `~/.local/share/delegate-assistant/data/assistant.db`

Security posture:
- Bind to localhost only.
- Publish access through Tailscale tailnet, not public internet.

Power settings (Mac mini server baseline):
- Apply: `sudo pmset -c sleep 0 standby 0 autorestart 1 powernap 0`
- Verify: `pmset -g`
