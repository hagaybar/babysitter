#!/bin/bash
# Babysitter Run Setup Script — Gemini CLI Edition
#
# Creates an in-session state file for a new babysitter run.
# Must be called before run:create so the AfterAgent hook can track state.
#
# Usage:
#   bash setup-babysitter-run.sh --gemini-session-id <id> [PROMPT...] [OPTIONS]
#
# Options:
#   --gemini-session-id <id>   Gemini CLI session ID (required)
#   --max-iterations <n>       Max iterations before auto-stop (default: 256)
#   --run-id <id>              Optional run ID (filled after run:create if omitted)
#   --state-dir <dir>          State directory (default: .a5c/state)
#   -h, --help                 Show this help

set -euo pipefail

PROMPT_PARTS=()
MAX_ITERATIONS=256
RUN_ID=""
GEMINI_SESSION_ID_ARG=""
STATE_DIR=".a5c/state"

while [[ $# -gt 0 ]]; do
  case $1 in
    -h|--help)
      cat << 'HELP_EOF'
Babysitter Run Setup — Gemini CLI Edition

USAGE:
  setup-babysitter-run.sh --gemini-session-id <id> [PROMPT...] [OPTIONS]

ARGUMENTS:
  PROMPT...                  Initial task description (positional words)

OPTIONS:
  --gemini-session-id <id>   Gemini CLI session ID (required, or use GEMINI_SESSION_ID env)
  --max-iterations <n>       Max iterations before auto-stop (default: 256, 0=unlimited)
  --run-id <id>              Run ID to store (can be set after run:create via associate script)
  --state-dir <dir>          State directory (default: .a5c/state)
  -h, --help                 Show this help

EXAMPLES:
  setup-babysitter-run.sh --gemini-session-id "${GEMINI_SESSION_ID}" Build a todo API
  setup-babysitter-run.sh --gemini-session-id "${GEMINI_SESSION_ID}" Fix auth bug --max-iterations 20
HELP_EOF
      exit 0
      ;;
    --gemini-session-id)
      GEMINI_SESSION_ID_ARG="$2"
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
    --run-id)
      RUN_ID="${2:-}"
      shift 2
      ;;
    --state-dir)
      STATE_DIR="${2:-}"
      shift 2
      ;;
    *)
      PROMPT_PARTS+=("$1")
      shift
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

# Join prompt parts
if ((${#PROMPT_PARTS[@]})); then
  PROMPT="${PROMPT_PARTS[*]}"
else
  PROMPT=""
fi

if [[ -z "$PROMPT" ]]; then
  echo "❌ Error: No prompt provided. Babysitter needs a task description." >&2
  echo "   Example: setup-babysitter-run.sh --gemini-session-id ... Build a REST API" >&2
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
# Delegate to SDK CLI (session:init)
# ---------------------------------------------------------------------------
babysitter session:init \
  --session-id "$SESSION_ID" \
  --state-dir "$STATE_DIR" \
  --max-iterations "$MAX_ITERATIONS" \
  ${RUN_ID:+--run-id "$RUN_ID"} \
  --prompt "$PROMPT"

EXIT_CODE=$?

if [[ $EXIT_CODE -eq 0 ]]; then
  cat <<EOF

🔄 Babysitter loop activated for Gemini CLI session!

Session ID:     $SESSION_ID
State dir:      $STATE_DIR
Iteration:      1
Max iterations: $(if [[ $MAX_ITERATIONS -gt 0 ]]; then echo $MAX_ITERATIONS; else echo "unlimited"; fi)
Run ID:         $(if [[ -n "$RUN_ID" ]]; then echo "$RUN_ID"; else echo "(unset — will be filled after run:create)"; fi)

The AfterAgent hook is now active. After each turn, the hook will check
whether the run is complete. If not, it re-injects the prompt to continue.

Next steps:
  1. Create the process JS file
  2. Run: babysitter run:create --process-id <id> --entry <path>#<export> \\
          --inputs <file> --prompt "..." \\
          --harness gemini-cli --session-id "${SESSION_ID}" \\
          --state-dir ".a5c/state" --json
  3. The run:create command binds the session automatically.
     Or manually: bash associate-session-with-run.sh --run-id <runId> \\
                       --gemini-session-id "${SESSION_ID}"
  4. STOP — the hook will call you back to continue the loop

🔄

$PROMPT
EOF
fi

exit $EXIT_CODE
