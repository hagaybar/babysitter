#!/bin/bash

# Babysitter Stop Hook
# Prevents session exit when a babysitter run is active
# Feeds Claude's output back as input to continue the loop

set -euo pipefail

# Source error codes helper for standardized error reporting
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
# shellcheck source=../scripts/error-codes.sh
source "$PLUGIN_ROOT/scripts/error-codes.sh"

# Determine log directory for structured logging
LOG_DIR="${BABYSITTER_LOG_DIR:-${PLUGIN_ROOT}/logs}"
mkdir -p "$LOG_DIR" 2>/dev/null || LOG_DIR="/tmp"
LOG_FILE="$LOG_DIR/babysitter-stop-hook.log"

# Helper function for structured logging to stderr and log file
_log_info() {
  local msg="$1"
  local session_id="${2:-}"
  local run_id="${3:-}"
  local context=""
  [[ -n "$session_id" ]] && context="session=$session_id"
  [[ -n "$run_id" ]] && context="${context:+$context }run=$run_id"
  echo "[INFO] $(date -u +%Y-%m-%dT%H:%M:%SZ) ${context:+[$context] }$msg" >> "$LOG_FILE"
}

_log_warn() {
  local code="$1"
  local session_id="${2:-}"
  local run_id="${3:-}"
  shift 3 2>/dev/null || shift $#
  local context_args=("$@")
  [[ -n "$session_id" ]] && context_args+=("session=$session_id")
  [[ -n "$run_id" ]] && context_args+=("run=$run_id")
  bsit_warn "$code" "${context_args[@]}"
  echo "[WARN] $(date -u +%Y-%m-%dT%H:%M:%SZ) [BSIT-$code] ${context_args[*]}" >> "$LOG_FILE"
}

_log_error() {
  local code="$1"
  local session_id="${2:-}"
  local run_id="${3:-}"
  shift 3 2>/dev/null || shift $#
  local context_args=("$@")
  [[ -n "$session_id" ]] && context_args+=("session=$session_id")
  [[ -n "$run_id" ]] && context_args+=("run=$run_id")
  bsit_error "$code" "${context_args[@]}"
  echo "[ERROR] $(date -u +%Y-%m-%dT%H:%M:%SZ) [BSIT-$code] ${context_args[*]}" >> "$LOG_FILE"
}

# Read hook input from stdin (advanced stop hook API)
HOOK_INPUT=$(cat)
_log_info "Hook input received" "" ""
# Extract session_id from hook input
SESSION_ID=$(echo "$HOOK_INPUT" | jq -r '.session_id // empty')
if [[ -z "$SESSION_ID" ]]; then
  # No session ID available - allow exit
  _log_warn "5004" "" "" "No session ID in hook input"
  exit 0
fi

# Export session ID for use in this script and any called scripts
export CLAUDE_SESSION_ID="$SESSION_ID"

# Also try to source environment file if available
# (SessionEnd hooks may have CLAUDE_ENV_FILE available)
if [[ -n "${CLAUDE_ENV_FILE:-}" ]] && [[ -f "$CLAUDE_ENV_FILE" ]]; then
  # Source environment variables set during SessionStart
  # shellcheck disable=SC1090
  source "$CLAUDE_ENV_FILE" 2>/dev/null || true
fi

# Determine state directory (plugin-relative for session isolation)
STATE_DIR="$PLUGIN_ROOT/skills/babysit/state"

# CLI for session management
CLI="${CLI:-npx -y @a5c-ai/babysitter-sdk@latest}"
BABYSITTER_STATE_FILE="$STATE_DIR/${SESSION_ID}.md"

# Single CLI call replaces both session:state and session:check-iteration
CHECK_RESULT=$($CLI session:check-iteration --session-id "$SESSION_ID" --state-dir "$STATE_DIR" --json 2>&1) || {
  _log_warn "4002" "$SESSION_ID" "" "Failed to check iteration: $CHECK_RESULT"
  exit 0
}

# Check if session exists
FOUND=$(echo "$CHECK_RESULT" | jq -r '.found // false')
if [[ "$FOUND" != "true" ]]; then
  # No active loop - allow exit
  _log_info "No active loop found" "$SESSION_ID" ""
  exit 0
fi

# Extract all fields from the single CHECK_RESULT
SHOULD_CONTINUE=$(echo "$CHECK_RESULT" | jq -r 'if .shouldContinue == false then "false" else "true" end')
ITERATION=$(echo "$CHECK_RESULT" | jq -r '.iteration // 1')
MAX_ITERATIONS=$(echo "$CHECK_RESULT" | jq -r '.maxIterations // 256')
RUN_ID=$(echo "$CHECK_RESULT" | jq -r '.runId // empty')
PROMPT_TEXT=$(echo "$CHECK_RESULT" | jq -r '.prompt // empty')

if [[ "$SHOULD_CONTINUE" != "true" ]]; then
  STOP_MSG=$(echo "$CHECK_RESULT" | jq -r '.stopMessage // empty')
  STOP_REASON=$(echo "$CHECK_RESULT" | jq -r '.reason // empty')
  _log_warn "3002" "$SESSION_ID" "$RUN_ID" "$STOP_MSG"
  # Delete session state file
  $CLI session:update --session-id "$SESSION_ID" --state-dir "$STATE_DIR" --delete --json >/dev/null 2>&1 || true
  _log_info "Session stopped ($STOP_REASON)" "$SESSION_ID" "$RUN_ID"
  exit 0
fi

# Get transcript path from hook input and parse last assistant message via CLI
TRANSCRIPT_PATH=$(echo "$HOOK_INPUT" | jq -r '.transcript_path')

TRANSCRIPT_RESULT=$($CLI session:last-message --transcript-path "$TRANSCRIPT_PATH" --json 2>/dev/null) || {
  _log_error "5004" "$SESSION_ID" "$RUN_ID" "session:last-message CLI failed"
  $CLI session:update --session-id "$SESSION_ID" --state-dir "$STATE_DIR" --delete --json >/dev/null 2>&1 || true
  exit 0
}

TRANSCRIPT_FOUND=$(echo "$TRANSCRIPT_RESULT" | jq -r '.found // false')
TRANSCRIPT_ERROR=$(echo "$TRANSCRIPT_RESULT" | jq -r '.error // empty')
LAST_OUTPUT=$(echo "$TRANSCRIPT_RESULT" | jq -r '.text // empty')
HAS_PROMISE=$(echo "$TRANSCRIPT_RESULT" | jq -r '.hasPromise // false')
PROMISE_TEXT=$(echo "$TRANSCRIPT_RESULT" | jq -r '.promiseValue // empty')

if [[ -n "$TRANSCRIPT_ERROR" ]]; then
  _log_error "4002" "$SESSION_ID" "$RUN_ID" "Transcript error: $TRANSCRIPT_ERROR path=$TRANSCRIPT_PATH"
  $CLI session:update --session-id "$SESSION_ID" --state-dir "$STATE_DIR" --delete --json >/dev/null 2>&1 || true
  exit 0
fi

if [[ "$TRANSCRIPT_FOUND" != "true" ]] || [[ -z "$LAST_OUTPUT" ]]; then
  _log_error "5004" "$SESSION_ID" "$RUN_ID" "No assistant text content found in transcript: $TRANSCRIPT_PATH"
  $CLI session:update --session-id "$SESSION_ID" --state-dir "$STATE_DIR" --delete --json >/dev/null 2>&1 || true
  exit 0
fi

# If we have a run_id, check run state from the SDK.
COMPLETION_PROOF=""
RUN_STATE=""
PENDING_KINDS=""
if [[ -n "${RUN_ID:-}" ]]; then
  RUN_STATUS=$($CLI run:status "$RUN_ID" --json 2>/dev/null || echo '{}')
  RUN_STATE=$(echo "$RUN_STATUS" | jq -r '.state // empty')
  PENDING_KINDS=$(echo "$RUN_STATUS" | jq -r '.pendingByKind | keys | join(", ") // empty' 2>/dev/null || echo "")
  _log_info "Run state: $RUN_STATE" "$SESSION_ID" "$RUN_ID"
  if [[ -z "$RUN_STATE" ]]; then
    _log_warn "4003" "$SESSION_ID" "$RUN_ID" "Run state is empty; run may be misconfigured"
    $CLI session:update --session-id "$SESSION_ID" --state-dir "$STATE_DIR" --delete --json >/dev/null 2>&1 || true
    exit 0
  fi
  if [[ "$RUN_STATE" == "completed" ]]; then
    COMPLETION_PROOF=$(echo "$RUN_STATUS" | jq -r '.completionProof // empty')
    _log_info "Completion proof available" "$SESSION_ID" "$RUN_ID"
  fi
  _log_info "Pending kinds: $PENDING_KINDS" "$SESSION_ID" "$RUN_ID"
fi

# If a completion proof is available, require the matching <promise> tag to exit.
if [[ -n "$COMPLETION_PROOF" ]]; then
  # Promise text already extracted by session:last-message CLI above
  if [[ "$HAS_PROMISE" == "true" ]] && [[ -n "$PROMISE_TEXT" ]] && [[ "$PROMISE_TEXT" = "$COMPLETION_PROOF" ]]; then
    _log_info "Detected valid promise tag - run complete" "$SESSION_ID" "$RUN_ID"
    $CLI session:update --session-id "$SESSION_ID" --state-dir "$STATE_DIR" --delete --json >/dev/null 2>&1 || true
    exit 0
  fi
fi

# Not complete - continue loop with SAME PROMPT
NEXT_ITERATION=$((ITERATION + 1))

# Extract updated iteration times from check result
UPDATED_TIMES=$(echo "$CHECK_RESULT" | jq -r '.updatedIterationTimes | join(",") // empty' 2>/dev/null || echo "")
CURRENT_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Check prompt text (already extracted from session:state)
if [[ -z "$PROMPT_TEXT" ]]; then
  _log_error "4003" "$SESSION_ID" "$RUN_ID" "State file corrupted - no prompt text found in $BABYSITTER_STATE_FILE"
  $CLI session:update --session-id "$SESSION_ID" --state-dir "$STATE_DIR" --delete --json >/dev/null 2>&1 || true
  exit 0
fi

# Update iteration in state file using CLI (replaces sed-based update)
UPDATE_ARGS=("session:update" "--session-id" "$SESSION_ID" "--state-dir" "$STATE_DIR" "--iteration" "$NEXT_ITERATION" "--last-iteration-at" "$CURRENT_TIME")
if [[ -n "$UPDATED_TIMES" ]]; then
  UPDATE_ARGS+=("--iteration-times" "$UPDATED_TIMES")
fi
UPDATE_ARGS+=("--json")

UPDATE_RESULT=$($CLI "${UPDATE_ARGS[@]}" 2>&1) || {
  _log_warn "4005" "$SESSION_ID" "$RUN_ID" "Failed to update iteration: $UPDATE_RESULT"
  # Continue anyway - state might be stale but loop should work
}
_log_info "Updated iteration to $NEXT_ITERATION" "$SESSION_ID" "$RUN_ID"

# Build system message via CLI (replaces bash branching + skill-context-resolver)
ITER_MSG_ARGS=("session:iteration-message" "--iteration" "$NEXT_ITERATION")
if [[ -n "${RUN_ID:-}" ]]; then
  ITER_MSG_ARGS+=("--run-id" "$RUN_ID")
fi
if [[ -n "${PLUGIN_ROOT:-}" ]]; then
  ITER_MSG_ARGS+=("--plugin-root" "$PLUGIN_ROOT")
fi
ITER_MSG_ARGS+=("--json")
ITER_MSG_RESULT=$($CLI "${ITER_MSG_ARGS[@]}" 2>/dev/null) || ITER_MSG_RESULT=''
if [[ -n "$ITER_MSG_RESULT" ]]; then
  SYSTEM_MSG=$(echo "$ITER_MSG_RESULT" | jq -r '.systemMessage // empty')
fi
if [[ -z "${SYSTEM_MSG:-}" ]]; then
  SYSTEM_MSG="🔄 Babysitter iteration $NEXT_ITERATION | Agent should continue orchestration (run:iterate)"
fi
# Inject available skill context into system message (until M8 moves this into CLI)
SKILL_CONTEXT=""
SKILL_RESOLVER="$PLUGIN_ROOT/hooks/skill-context-resolver.sh"
if [[ -x "$SKILL_RESOLVER" ]]; then
  SKILL_CONTEXT=$(bash "$SKILL_RESOLVER" "${RUN_ID:-}" "$PLUGIN_ROOT" 2>/dev/null || echo "")
  if [[ -n "$SKILL_CONTEXT" ]]; then
    SYSTEM_MSG="$SYSTEM_MSG | Available skills for this task: $SKILL_CONTEXT. Use the Skill tool or skill-discovery to load any of these."
    _log_info "Injected skill context ($SKILL_CONTEXT)" "$SESSION_ID" "$RUN_ID"
  fi
fi

_log_info "Outputting JSON to block stop and continue loop" "$SESSION_ID" "$RUN_ID"
# Output JSON to block the stop and feed prompt back
# The "reason" field contains the prompt that will be sent back to Claude
JSON_OUTPUT=$(jq -n \
  --arg prompt "$PROMPT_TEXT" \
  --arg msg "$SYSTEM_MSG" \
  '{
    "decision": "block",
    "instructions": "use the babysitter skill to advance the orchestration to the next state (run:iterate) or perform the pending effects (task:list --pending --json), or fix the run if it failed.",
    "reason": $prompt,
    "systemMessage": $msg
  }')
echo "$JSON_OUTPUT"
_log_info "Hook execution successful" "$SESSION_ID" "$RUN_ID"
# Exit 0 for successful hook execution
exit 0