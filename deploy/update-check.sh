#!/usr/bin/env bash
set -uo pipefail

# Update orchestrator
# Runs periodically via LaunchAgent to pull new releases.
# Calls individual update scripts — failure in one does not block the other.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_FILE="${HOME}/Library/Logs/delegate-assistant-updater.log"

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*" >> "$LOG_FILE"; }

# Update engram first (dependency of delegate-assistant)
"$SCRIPT_DIR/update-check-engram.sh" || log "WARN: engram update check failed"

# Update delegate-assistant
"$SCRIPT_DIR/update-check-delegate.sh" || log "WARN: delegate-assistant update check failed"
