#!/bin/bash
# Babysitter Stop Hook - delegates to SDK CLI
# All logic is implemented in: babysitter hook:run --hook-type stop
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
LOG_DIR="${BABYSITTER_LOG_DIR:-}"
LOG_FILE="${LOG_DIR:+$LOG_DIR/babysitter-stop-hook.log}"

# Diagnostic marker: if BABYSITTER_LOG_DIR is set, ensure the directory exists
# and write markers so we know the hook fired (even if the CLI fails).
if [ -n "$LOG_FILE" ]; then
  mkdir -p "$LOG_DIR" 2>/dev/null
  {
    echo "[INFO] $(date -u +%Y-%m-%dT%H:%M:%SZ) Hook script invoked"
    echo "[INFO] $(date -u +%Y-%m-%dT%H:%M:%SZ) PLUGIN_ROOT=$PLUGIN_ROOT"
    echo "[INFO] $(date -u +%Y-%m-%dT%H:%M:%SZ) babysitter=$(which babysitter 2>/dev/null || echo 'not found')"
  } >> "$LOG_FILE" 2>/dev/null
fi

# Capture stdin into a temp file so we can both log it and pass to the CLI
INPUT_FILE=$(mktemp 2>/dev/null || echo "/tmp/hook-input-$$.json")
cat > "$INPUT_FILE"

if [ -n "$LOG_FILE" ]; then
  echo "[INFO] $(date -u +%Y-%m-%dT%H:%M:%SZ) Hook input received ($(wc -c < "$INPUT_FILE") bytes)" >> "$LOG_FILE" 2>/dev/null
fi

# Run the CLI, capturing stdout; redirect stderr to log if available
if [ -n "$LOG_DIR" ]; then
  RESULT=$(babysitter hook:run --hook-type stop --plugin-root "$PLUGIN_ROOT" --json < "$INPUT_FILE" 2>"$LOG_DIR/babysitter-stop-hook-stderr.log")
else
  RESULT=$(babysitter hook:run --hook-type stop --plugin-root "$PLUGIN_ROOT" --json < "$INPUT_FILE" 2>/dev/null)
fi
EXIT_CODE=$?

if [ -n "$LOG_FILE" ]; then
  echo "[INFO] $(date -u +%Y-%m-%dT%H:%M:%SZ) CLI exit code=$EXIT_CODE" >> "$LOG_FILE" 2>/dev/null
fi

rm -f "$INPUT_FILE" 2>/dev/null
printf '%s\n' "$RESULT"
exit $EXIT_CODE
