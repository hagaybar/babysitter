#!/bin/bash
# Babysitter Stop Hook - delegates to SDK CLI
# All logic is implemented in: babysitter hook:run --hook-type stop
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"

# Diagnostic marker: if BABYSITTER_LOG_DIR is set, ensure the directory exists
# and write a marker so we know the hook fired (even if the CLI fails).
if [ -n "$BABYSITTER_LOG_DIR" ]; then
  mkdir -p "$BABYSITTER_LOG_DIR" 2>/dev/null
  echo "[INFO] $(date -u +%Y-%m-%dT%H:%M:%SZ) Hook script invoked" >> "$BABYSITTER_LOG_DIR/babysitter-stop-hook.log" 2>/dev/null
fi

exec babysitter hook:run --hook-type stop --plugin-root "$PLUGIN_ROOT" --json < /dev/stdin
