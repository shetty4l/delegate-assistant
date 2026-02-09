#!/usr/bin/env bash
set -euo pipefail

# delegate-assistant installer
# Usage: curl -fsSL https://github.com/shetty4l/delegate-assistant/releases/latest/download/install.sh | bash

REPO="shetty4l/delegate-assistant"
INSTALL_BASE="${HOME}/srv/delegate-assistant"
CONFIG_DIR="${HOME}/.config/delegate-assistant"
SECRETS_FILE="${CONFIG_DIR}/secrets.env"
CONFIG_FILE="${CONFIG_DIR}/config.json"
LAUNCH_AGENTS_DIR="${HOME}/Library/LaunchAgents"
LOG_DIR="${HOME}/Library/Logs"
MAX_VERSIONS=5

# --- helpers ---

info()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m==>\033[0m %s\n' "$*"; }
err()   { printf '\033[1;31m==>\033[0m %s\n' "$*" >&2; }
die()   { err "$@"; exit 1; }

check_prereqs() {
  local missing=()
  for cmd in bun curl tar jq; do
    if ! command -v "$cmd" &>/dev/null; then
      missing+=("$cmd")
    fi
  done
  if [ ${#missing[@]} -gt 0 ]; then
    die "Missing required tools: ${missing[*]}"
  fi
}

prompt_value() {
  local var_name="$1" prompt="$2" default="${3:-}"
  local value
  if [ -n "$default" ]; then
    printf '%s [%s]: ' "$prompt" "$default" >&2
  else
    printf '%s: ' "$prompt" >&2
  fi
  read -r value < /dev/tty
  value="${value:-$default}"
  if [ -z "$value" ]; then
    die "${var_name} is required"
  fi
  echo "$value"
}

# --- fetch latest release ---

fetch_latest_release() {
  info "Fetching latest release from GitHub..."
  local release_json
  release_json=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest")

  RELEASE_TAG=$(echo "$release_json" | jq -r '.tag_name')
  RELEASE_VERSION="${RELEASE_TAG#v}"
  TARBALL_URL=$(echo "$release_json" | jq -r '.assets[] | select(.name | startswith("delegate-assistant-")) | .browser_download_url')

  if [ -z "$RELEASE_TAG" ] || [ "$RELEASE_TAG" = "null" ]; then
    die "No releases found for ${REPO}"
  fi
  if [ -z "$TARBALL_URL" ] || [ "$TARBALL_URL" = "null" ]; then
    die "No tarball asset found in release ${RELEASE_TAG}"
  fi

  info "Latest release: ${RELEASE_TAG}"
}

# --- download and extract ---

download_and_extract() {
  local version_dir="${INSTALL_BASE}/${RELEASE_TAG}"

  if [ -d "$version_dir" ]; then
    warn "Version ${RELEASE_TAG} already exists at ${version_dir}, reinstalling..."
    rm -rf "$version_dir"
  fi

  mkdir -p "$version_dir"

  info "Downloading ${RELEASE_TAG}..."
  local tmpfile
  tmpfile=$(mktemp)
  curl -fsSL -o "$tmpfile" "$TARBALL_URL"

  info "Extracting to ${version_dir}..."
  tar xzf "$tmpfile" -C "$version_dir"
  rm -f "$tmpfile"

  info "Installing dependencies..."
  (cd "$version_dir" && bun install --frozen-lockfile)

  info "Building web dashboard..."
  (cd "$version_dir" && bun run build:web)

  ok "Installed ${RELEASE_TAG} to ${version_dir}"
}

# --- symlink management ---

update_symlink() {
  local version_dir="${INSTALL_BASE}/${RELEASE_TAG}"
  local latest_link="${INSTALL_BASE}/latest"

  rm -f "$latest_link"
  ln -s "$version_dir" "$latest_link"
  echo "$RELEASE_TAG" > "${INSTALL_BASE}/current-version"

  ok "Symlinked latest -> ${RELEASE_TAG}"
}

# --- prune old versions ---

prune_versions() {
  info "Pruning old versions (keeping ${MAX_VERSIONS})..."
  local versions=()
  for d in "${INSTALL_BASE}"/v*; do
    [ -d "$d" ] && versions+=("$(basename "$d")")
  done

  # sort by semver (strip v prefix, sort numerically)
  IFS=$'\n' sorted=($(printf '%s\n' "${versions[@]}" | sed 's/^v//' | sort -t. -k1,1n -k2,2n -k3,3n | sed 's/^/v/'))
  unset IFS

  local count=${#sorted[@]}
  if [ "$count" -gt "$MAX_VERSIONS" ]; then
    local remove_count=$((count - MAX_VERSIONS))
    for ((i = 0; i < remove_count; i++)); do
      local old_version="${sorted[$i]}"
      info "Removing old version: ${old_version}"
      rm -rf "${INSTALL_BASE}/${old_version}"
    done
  fi
}

# --- configuration ---

setup_config() {
  mkdir -p "$CONFIG_DIR"

  info "Configuring delegate-assistant..."
  echo ""

  # use env var if set, otherwise prompt interactively
  local bot_token="${TELEGRAM_BOT_TOKEN:-}"
  if [ -z "$bot_token" ]; then
    bot_token=$(prompt_value "TELEGRAM_BOT_TOKEN" "Telegram bot token (required)")
  else
    info "Using TELEGRAM_BOT_TOKEN from environment"
  fi

  # write secrets
  cat > "$SECRETS_FILE" << EOF
# delegate-assistant secrets -- do not commit
TELEGRAM_BOT_TOKEN=${bot_token}
EOF
  chmod 600 "$SECRETS_FILE"
  ok "Wrote secrets to ${SECRETS_FILE}"

  # write config with sensible defaults
  cat > "$CONFIG_FILE" << EOF
{
  "port": 3000,
  "sqlitePath": "~/.local/share/delegate-assistant/data/assistant.db",
  "telegramPollIntervalMs": 2000,
  "modelProvider": "opencode_cli",
  "opencodeBin": "opencode",
  "assistantRepoPath": "${HOME}/dev",
  "sessionIdleTimeoutMs": 2700000,
  "sessionMaxConcurrent": 5,
  "relayTimeoutMs": 300000,
  "progressFirstMs": 10000,
  "progressEveryMs": 30000,
  "progressMaxCount": 3
}
EOF
  ok "Wrote config to ${CONFIG_FILE}"

  # ensure data directory
  mkdir -p "${HOME}/.local/share/delegate-assistant/data"
}

# --- wrapper scripts ---

install_wrapper_scripts() {
  info "Installing wrapper scripts..."

  cp "${INSTALL_BASE}/latest/deploy/start-assistant.sh" "${INSTALL_BASE}/start-assistant.sh"
  cp "${INSTALL_BASE}/latest/deploy/start-web.sh" "${INSTALL_BASE}/start-web.sh"
  cp "${INSTALL_BASE}/latest/deploy/update-check.sh" "${INSTALL_BASE}/update-check.sh"
  chmod +x "${INSTALL_BASE}/start-assistant.sh"
  chmod +x "${INSTALL_BASE}/start-web.sh"
  chmod +x "${INSTALL_BASE}/update-check.sh"

  ok "Wrapper scripts installed"
}

# --- launchd management ---

unload_old_agents() {
  local uid
  uid=$(id -u)
  local old_agents=(
    "com.suyash.delegate-assistant.dev"
    "com.suyash.delegate-session-manager.dev"
  )

  for label in "${old_agents[@]}"; do
    local plist="${LAUNCH_AGENTS_DIR}/${label}.plist"
    if [ -f "$plist" ]; then
      info "Unloading old LaunchAgent: ${label}"
      launchctl bootout "gui/${uid}/${label}" 2>/dev/null || true
      rm -f "$plist"
      ok "Removed ${label}"
    fi
  done
}

install_launch_agents() {
  local uid
  uid=$(id -u)

  mkdir -p "$LAUNCH_AGENTS_DIR"
  mkdir -p "$LOG_DIR"

  # generate plists from templates, expanding ~ to actual home dir
  local deploy_dir="${INSTALL_BASE}/latest/deploy"
  for plist_template in "${deploy_dir}"/com.suyash.*.plist; do
    local filename
    filename=$(basename "$plist_template")
    local dest="${LAUNCH_AGENTS_DIR}/${filename}"
    sed "s|\${HOME}|${HOME}|g" "$plist_template" > "$dest"
  done

  # load agents
  local agents=(
    "com.suyash.delegate-assistant"
    "com.suyash.delegate-session-manager"
    "com.suyash.delegate-assistant-updater"
  )

  for label in "${agents[@]}"; do
    local plist="${LAUNCH_AGENTS_DIR}/${label}.plist"
    # unload if already loaded
    launchctl bootout "gui/${uid}/${label}" 2>/dev/null || true
    launchctl bootstrap "gui/${uid}" "$plist"
    launchctl enable "gui/${uid}/${label}"
    ok "Loaded LaunchAgent: ${label}"
  done
}

# --- status ---

print_status() {
  echo ""
  echo "=========================================="
  ok "delegate-assistant installed successfully!"
  echo "=========================================="
  echo ""
  echo "  Version:    ${RELEASE_TAG}"
  echo "  Install:    ${INSTALL_BASE}/latest"
  echo "  Config:     ${CONFIG_FILE}"
  echo "  Secrets:    ${SECRETS_FILE}"
  echo ""
  echo "  Services:"
  echo "    assistant:  http://localhost:3000"
  echo "    web:        http://localhost:4321"
  echo "    updater:    checks every 5 minutes"
  echo ""
  echo "  Logs:"
  echo "    tail -f ${LOG_DIR}/delegate-assistant.stdout.log"
  echo "    tail -f ${LOG_DIR}/delegate-assistant.stderr.log"
  echo "    tail -f ${LOG_DIR}/delegate-session-manager.stdout.log"
  echo "    tail -f ${LOG_DIR}/delegate-assistant-updater.log"
  echo ""
  echo "  Management:"
  echo "    launchctl kickstart -k gui/\$(id -u)/com.suyash.delegate-assistant"
  echo "    launchctl kickstart -k gui/\$(id -u)/com.suyash.delegate-session-manager"
  echo ""
}

# --- main ---

main() {
  info "delegate-assistant installer"
  echo ""

  check_prereqs
  fetch_latest_release
  download_and_extract
  update_symlink
  prune_versions
  setup_config
  install_wrapper_scripts
  unload_old_agents
  install_launch_agents
  print_status
}

main "$@"
