#!/usr/bin/env bash
set -euo pipefail

# delegate-assistant update checker
# Runs periodically via LaunchAgent to pull new releases.

REPO="shetty4l/delegate-assistant"
INSTALL_BASE="${HOME}/srv/delegate-assistant"
CURRENT_VERSION_FILE="${INSTALL_BASE}/current-version"
LOG_FILE="${HOME}/Library/Logs/delegate-assistant-updater.log"
MAX_VERSIONS=5

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*" >> "$LOG_FILE"; }

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

TARBALL_URL=$(echo "$RELEASE_JSON" | jq -r '.assets[] | select(.name | startswith("delegate-assistant-")) | .browser_download_url')
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

# --- install deps and build ---

(cd "$VERSION_DIR" && bun install --frozen-lockfile 2>&1) >> "$LOG_FILE" || {
  log "ERROR: bun install failed"
  rm -rf "$VERSION_DIR"
  exit 1
}

(cd "$VERSION_DIR" && bun run build:web 2>&1) >> "$LOG_FILE" || {
  log "ERROR: build:web failed"
  rm -rf "$VERSION_DIR"
  exit 1
}

# --- update symlink ---

rm -f "${INSTALL_BASE}/latest"
ln -s "$VERSION_DIR" "${INSTALL_BASE}/latest"
echo "$RELEASE_TAG" > "$CURRENT_VERSION_FILE"
log "Updated symlink: latest -> ${RELEASE_TAG}"

# --- update wrapper scripts ---

cp "${INSTALL_BASE}/latest/deploy/start-assistant.sh" "${INSTALL_BASE}/start-assistant.sh"
cp "${INSTALL_BASE}/latest/deploy/start-web.sh" "${INSTALL_BASE}/start-web.sh"
cp "${INSTALL_BASE}/latest/deploy/update-check.sh" "${INSTALL_BASE}/update-check.sh"
chmod +x "${INSTALL_BASE}/start-assistant.sh"
chmod +x "${INSTALL_BASE}/start-web.sh"
chmod +x "${INSTALL_BASE}/update-check.sh"

# --- update LaunchAgent plists ---

DEPLOY_DIR="${INSTALL_BASE}/latest/deploy"
LAUNCH_AGENTS_DIR="${HOME}/Library/LaunchAgents"
for plist_template in "${DEPLOY_DIR}"/com.suyash.*.plist; do
  filename=$(basename "$plist_template")
  sed "s|\${HOME}|${HOME}|g" "$plist_template" > "${LAUNCH_AGENTS_DIR}/${filename}"
done
log "Updated LaunchAgent plists"

# --- prune old versions ---

VERSIONS=()
for d in "${INSTALL_BASE}"/v*; do
  [ -d "$d" ] && VERSIONS+=("$(basename "$d")")
done

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

# --- restart services ---

UID_VAL=$(id -u)
launchctl kickstart -k "gui/${UID_VAL}/com.suyash.delegate-assistant" 2>/dev/null || log "WARN: Failed to restart assistant"
launchctl kickstart -k "gui/${UID_VAL}/com.suyash.delegate-session-manager" 2>/dev/null || log "WARN: Failed to restart session-manager"

log "Update complete: ${RELEASE_TAG}"
