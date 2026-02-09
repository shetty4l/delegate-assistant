#!/usr/bin/env bash
set -euo pipefail

# Source secrets (TELEGRAM_BOT_TOKEN, etc.)
SECRETS_FILE="${HOME}/.config/delegate-assistant/secrets.env"
if [ -f "$SECRETS_FILE" ]; then
  set -a
  # shellcheck source=/dev/null
  source "$SECRETS_FILE"
  set +a
fi

exec bun apps/session-manager-web/dist/server/entry.mjs
