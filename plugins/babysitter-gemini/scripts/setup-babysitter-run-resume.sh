#!/bin/bash
# Babysitter Run Resume Setup — Gemini CLI Edition
#
# Resumes an existing babysitter run in a new Gemini CLI session.
# Creates a new session state file bound to the given run ID.
#
# Usage:
#   bash setup-babysitter-run-resume.sh --gemini-session-id <id> --run-id <runId> [OPTIONS]
#
# Options:
#   --gemini-session-id <id>   Gemini CLI session ID (required)
#   --run-id <id>              Run ID to resume (required)
#   --max-iterations <n>       Max iterations before auto-stop (default: 256)
#   --state-dir <dir>          State directory (default: .a5c/state)
#   --runs-dir <dir>           Runs directory (default: .a5c/runs)
#   -h, --help                 Show this help

set -euo pipefail

GEMINI_SESSION_ID_ARG=""
RUN_ID=""
MAX_ITERATIONS=256
STATE_DIR=".a5c/state"
RUNS_DIR=".a5c/runs"

while [[ $# -gt 0 ]]; do
  case $1 in
    -h|--help)
      cat << 'HELP_EOF'
Babysitter Run Resume — Gemini CLI Edition

USAGE:
  setup-babysitter-run-resume.sh --gemini-session-id <id> --run-id <runId>

OPTIONS:
  --gemini-session-id <id>   Gemini CLI session ID (required, or use GEMINI_SESSION_ID env)
  --run-id <id>              Run ID to resume (required)
  --max-iterations <n>       Max iterations before auto-stop (default: 256, 0=unlimited)
  --state-dir <dir>          State directory (default: .a5c/state)
  --runs-dir <dir>           Runs directory (default: .a5c/runs)
  -h, --help                 Show this help

EXAMPLES:
  setup-babysitter-run-resume.sh --gemini-session-id "${GEMINI_SESSION_ID}" --run-id my-run-123
HELP_EOF
      exit 0
      ;;
    --gemini-session-id)
      GEMINI_SESSION_ID_ARG="${2:-}"
      shift 2
      ;;
    --run-id)
      RUN_ID="${2:-}"
      shift 2
      ;;
    --max-iterations)
      if ! [[ "${2:-}" =~ ^[0-9]+$ ]]; then
        echo "❌ Error: --max-iterations must be a non-negative integer" >&2
        exit 1
      fi
      MAX_ITERATIONS="$2"
      shift 2
      ;;
    --state-dir)
      STATE_DIR="${2:-}"
      shift 2
      ;;
    --runs-dir)
      RUNS_DIR="${2:-}"
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
  echo "   Example: setup-babysitter-run-resume.sh --gemini-session-id ... --run-id my-run-123" >&2
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
babysitter session:resume \
  --session-id "$SESSION_ID" \
  --run-id "$RUN_ID" \
  --max-iterations "$MAX_ITERATIONS" \
  --state-dir "$STATE_DIR" \
  --runs-dir "$RUNS_DIR"

EXIT_CODE=$?

if [[ $EXIT_CODE -eq 0 ]]; then
  cat <<EOF

🔄 Babysitter resume activated for Gemini CLI session!

Session ID:     $SESSION_ID
Run ID:         $RUN_ID
State dir:      $STATE_DIR
Max iterations: $(if [[ $MAX_ITERATIONS -gt 0 ]]; then echo $MAX_ITERATIONS; else echo "unlimited"; fi)

The AfterAgent hook is now active. STOP — the hook will resume the loop
on the next turn and re-inject the prompt to continue orchestration.

🔄
EOF
fi

exit $EXIT_CODE
