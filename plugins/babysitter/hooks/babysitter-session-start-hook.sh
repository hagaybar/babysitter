#!/bin/bash
# Babysitter Session Start Hook - delegates to SDK CLI
# Ensures the babysitter CLI is installed (from plugin.json sdkVersion),
# then delegates to the TypeScript handler.

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
MARKER_FILE="${PLUGIN_ROOT}/.babysitter-install-attempted"

# Install babysitter CLI if not available (only attempt once per plugin install)
if ! command -v babysitter &>/dev/null; then
  if [ ! -f "$MARKER_FILE" ]; then
    SDK_VERSION=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('${PLUGIN_ROOT}/plugin.json','utf8')).sdkVersion||'latest')}catch{console.log('latest')}" 2>/dev/null || echo "latest")
    npm i -g "@a5c-ai/babysitter-sdk@${SDK_VERSION}" --loglevel=error 2>/dev/null
    echo "$SDK_VERSION" > "$MARKER_FILE" 2>/dev/null
  fi
  # If still not available after install attempt, succeed silently
  if ! command -v babysitter &>/dev/null; then
    echo "{}"
    exit 0
  fi
fi

exec babysitter hook:run --hook-type session-start --harness claude-code --json < /dev/stdin
