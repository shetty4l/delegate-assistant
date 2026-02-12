#!/usr/bin/env bash
set -euo pipefail

# Engram update checker
# Called by update-check.sh orchestrator.
# Skips silently if engram is not installed.

REPO="shetty4l/engram"
INSTALL_BASE="${HOME}/srv/engram"
BIN_DIR="${HOME}/.local/bin"
DATA_DIR="${XDG_DATA_HOME:-${HOME}/.local/share}/engram"
CURRENT_VERSION_FILE="${INSTALL_BASE}/current-version"
LOG_FILE="${HOME}/Library/Logs/engram-updater.log"
MAX_VERSIONS=5

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*" >> "$LOG_FILE"; }

# --- skip if not installed ---

if [ ! -d "$INSTALL_BASE" ]; then
  exit 0
fi

# --- fetch latest release ---

RELEASE_JSON=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null) || {
  log "ERROR: Failed to fetch latest release"
  exit 1
}

RELEASE_TAG=$(echo "$RELEASE_JSON" | jq -r '.tag_name')
if [ -z "$RELEASE_TAG" ] || [ "$RELEASE_TAG" = "null" ]; then
  log "ERROR: No release tag found"
  exit 1
fi

# --- compare versions ---

CURRENT_VERSION=""
if [ -f "$CURRENT_VERSION_FILE" ]; then
  CURRENT_VERSION=$(cat "$CURRENT_VERSION_FILE")
fi

if [ "$RELEASE_TAG" = "$CURRENT_VERSION" ]; then
  exit 0
fi

log "New release detected: ${RELEASE_TAG} (current: ${CURRENT_VERSION:-none})"

# --- download and install ---

TARBALL_URL=$(echo "$RELEASE_JSON" | jq -r '.assets[] | select(.name | startswith("engram-")) | .browser_download_url')
if [ -z "$TARBALL_URL" ] || [ "$TARBALL_URL" = "null" ]; then
  log "ERROR: No tarball asset in release ${RELEASE_TAG}"
  exit 1
fi

VERSION_DIR="${INSTALL_BASE}/${RELEASE_TAG}"
if [ -d "$VERSION_DIR" ]; then
  rm -rf "$VERSION_DIR"
fi
mkdir -p "$VERSION_DIR"

TMPFILE=$(mktemp)
curl -fsSL -o "$TMPFILE" "$TARBALL_URL" 2>/dev/null || {
  log "ERROR: Failed to download tarball"
  rm -f "$TMPFILE"
  exit 1
}

tar xzf "$TMPFILE" -C "$VERSION_DIR"
rm -f "$TMPFILE"
log "Extracted ${RELEASE_TAG} to ${VERSION_DIR}"

# --- install deps ---

(cd "$VERSION_DIR" && bun install --frozen-lockfile 2>&1) >> "$LOG_FILE" || {
  log "ERROR: bun install failed"
  rm -rf "$VERSION_DIR"
  exit 1
}

# --- create CLI wrapper ---

cat > "$VERSION_DIR/engram" <<'WRAPPER'
#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "$(readlink "$0" || echo "$0")")" && pwd)"
exec bun run "$SCRIPT_DIR/src/cli.ts" "$@"
WRAPPER
chmod +x "$VERSION_DIR/engram"

# --- update symlink ---

rm -f "${INSTALL_BASE}/latest"
ln -s "$VERSION_DIR" "${INSTALL_BASE}/latest"
echo "$RELEASE_TAG" > "$CURRENT_VERSION_FILE"
log "Updated symlink: latest -> ${RELEASE_TAG}"

# --- update CLI symlink ---

mkdir -p "$BIN_DIR"
ln -sf "${INSTALL_BASE}/latest/engram" "${BIN_DIR}/engram"

# --- prune old versions ---

VERSIONS=()
for d in "${INSTALL_BASE}"/v*; do
  [ -d "$d" ] && VERSIONS+=("$(basename "$d")")
done

if [ ${#VERSIONS[@]} -gt 0 ]; then
  IFS=$'\n' SORTED=($(printf '%s\n' "${VERSIONS[@]}" | sed 's/^v//' | sort -t. -k1,1n -k2,2n -k3,3n | sed 's/^/v/'))
  unset IFS

  COUNT=${#SORTED[@]}
  if [ "$COUNT" -gt "$MAX_VERSIONS" ]; then
    REMOVE_COUNT=$((COUNT - MAX_VERSIONS))
    for ((i = 0; i < REMOVE_COUNT; i++)); do
      OLD="${SORTED[$i]}"
      log "Pruning old version: ${OLD}"
      rm -rf "${INSTALL_BASE}/${OLD}"
    done
  fi
fi

# --- restart daemon if running ---

PID_FILE="${DATA_DIR}/engram.pid"
if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE" 2>/dev/null)
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    log "Stopping engram daemon (PID: ${PID})..."
    kill "$PID" 2>/dev/null || true
    # Wait up to 5 seconds for graceful shutdown
    for ((i = 0; i < 50; i++)); do
      kill -0 "$PID" 2>/dev/null || break
      sleep 0.1
    done
    # Force kill if still running
    if kill -0 "$PID" 2>/dev/null; then
      kill -9 "$PID" 2>/dev/null || true
    fi
    log "Engram daemon stopped"
  fi
  rm -f "$PID_FILE"
fi

log "Update complete: ${RELEASE_TAG}"
