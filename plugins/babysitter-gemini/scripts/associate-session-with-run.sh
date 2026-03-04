#!/bin/bash
# Associate Session with Run — Gemini CLI Edition
#
# Associates an existing babysitter session state file with a run ID.
# Call this after run:create to link the session to the new run.
#
# Usage:
#   bash associate-session-with-run.sh --run-id <runId> --gemini-session-id <id> [OPTIONS]
#
# Options:
#   --run-id <id>              Run ID to associate (required)
#   --gemini-session-id <id>   Gemini CLI session ID (required)
#   --state-dir <dir>          State directory (default: .a5c/state)
#   -h, --help                 Show this help

set -euo pipefail

RUN_ID=""
GEMINI_SESSION_ID_ARG=""
STATE_DIR=".a5c/state"

while [[ $# -gt 0 ]]; do
  case $1 in
    -h|--help)
      cat << 'HELP_EOF'
Associate Session with Run — Gemini CLI Edition

USAGE:
  associate-session-with-run.sh --run-id <runId> --gemini-session-id <id>

OPTIONS:
  --run-id <id>              Run ID to associate (required)
  --gemini-session-id <id>   Gemini CLI session ID (required, or use GEMINI_SESSION_ID env)
  --state-dir <dir>          State directory (default: .a5c/state)
  -h, --help                 Show this help

EXAMPLES:
  associate-session-with-run.sh --run-id my-run-123 --gemini-session-id "${GEMINI_SESSION_ID}"
HELP_EOF
      exit 0
      ;;
    --run-id)
      RUN_ID="${2:-}"
      shift 2
      ;;
    --gemini-session-id)
      GEMINI_SESSION_ID_ARG="${2:-}"
      shift 2
      ;;
    --state-dir)
      STATE_DIR="${2:-}"
      shift 2
      ;;
    *)
      echo "❌ Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

# Resolve session ID
SESSION_ID="${GEMINI_SESSION_ID_ARG:-${GEMINI_SESSION_ID:-}}"
if [[ -z "$SESSION_ID" ]]; then
  echo "❌ Error: Session ID not available." >&2
  echo "   Provide --gemini-session-id <id> or set GEMINI_SESSION_ID env var." >&2
  exit 1
fi

if [[ -z "$RUN_ID" ]]; then
  echo "❌ Error: --run-id is required." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Resolve babysitter CLI
# ---------------------------------------------------------------------------
EXTENSION_PATH="$(cd "$(dirname "$0")/.." && pwd)"

if ! command -v babysitter &>/dev/null; then
  if [ -x "$HOME/.local/bin/babysitter" ]; then
    export PATH="$HOME/.local/bin:$PATH"
  else
    SDK_VERSION=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('${EXTENSION_PATH}/versions.json','utf8')).sdkVersion||'latest')}catch{console.log('latest')}" 2>/dev/null || echo "latest")
    babysitter() { npx -y "@a5c-ai/babysitter-sdk@${SDK_VERSION:-latest}" "$@"; }
    export -f babysitter
  fi
fi

# ---------------------------------------------------------------------------
# Delegate to SDK CLI
# ---------------------------------------------------------------------------
babysitter session:associate \
  --session-id "$SESSION_ID" \
  --run-id "$RUN_ID" \
  --state-dir "$STATE_DIR"

EXIT_CODE=$?

if [[ $EXIT_CODE -eq 0 ]]; then
  cat <<EOF

✅ Session associated with run!

Session ID: $SESSION_ID
Run ID:     $RUN_ID
State dir:  $STATE_DIR

The AfterAgent hook will now track this run. STOP — the hook will call you
back to continue the loop after each turn.

EOF
fi

exit $EXIT_CODE
