#!/bin/bash
# Babysitter Gemini CLI Extension — E2E Smoke Test
#
# Tests the full hook pipeline end-to-end using the actual CLI.
#
# Usage:
#   bash test/e2e-smoke.sh
#
# Requirements:
#   - babysitter CLI available (or npx fallback)

set -uo pipefail

PASS=0
FAIL=0
ERRORS=()

EXTENSION_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORK_DIR="$(mktemp -d)"
STATE_DIR="$WORK_DIR/state"
RUNS_DIR="$WORK_DIR/runs"
mkdir -p "$STATE_DIR" "$RUNS_DIR"

trap 'rm -rf "$WORK_DIR"' EXIT

# ---------------------------------------------------------------------------
# Resolve babysitter CLI
# ---------------------------------------------------------------------------
if command -v babysitter &>/dev/null; then
  CLI="babysitter"
elif [ -x "$HOME/.local/bin/babysitter" ]; then
  CLI="$HOME/.local/bin/babysitter"
else
  SDK_VERSION=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('${EXTENSION_DIR}/versions.json','utf8')).sdkVersion||'latest')}catch{console.log('latest')}" 2>/dev/null || echo "latest")
  CLI="npx -y @a5c-ai/babysitter-sdk@${SDK_VERSION:-latest}"
fi

echo "Using CLI: $CLI"
echo "Working dir: $WORK_DIR"
echo ""

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

pass() { PASS=$((PASS + 1)); echo "  ✅ PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); ERRORS+=("$1"); echo "  ❌ FAIL: $1"; }

assert_file_exists() {
  local label="$1" path="$2"
  [[ -f "$path" ]] && pass "$label" || fail "$label: file not found: $path"
}

assert_contains() {
  local label="$1" haystack="$2" needle="$3"
  echo "$haystack" | grep -qF "$needle" && pass "$label" || fail "$label: missing '${needle}'"
}

assert_no_decision() {
  local label="$1" json="$2"
  local decision
  decision=$(echo "$json" | node -e "try{const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(d.decision||'NONE')}catch{console.log('PARSE_ERR')}" 2>/dev/null)
  [[ "$decision" == "NONE" ]] && pass "$label (approve — no decision)" || fail "$label: expected approve (no decision), got decision=$decision"
}

assert_decision_block() {
  local label="$1" json="$2"
  local decision
  decision=$(echo "$json" | node -e "try{const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(d.decision||'NONE')}catch{console.log('PARSE_ERR')}" 2>/dev/null)
  [[ "$decision" == "block" ]] && pass "$label (decision=block)" || fail "$label: expected block, got decision=$decision"
}

# Run a hook:run command with a JSON payload from a temp file (avoids stdin issues)
run_hook() {
  local hook_type="$1" payload="$2"
  shift 2
  local tmp_input
  tmp_input=$(mktemp)
  echo "$payload" > "$tmp_input"
  local result
  result=$($CLI hook:run \
    --hook-type "$hook_type" \
    --harness gemini-cli \
    --state-dir "$STATE_DIR" \
    --runs-dir "$RUNS_DIR" \
    --json < "$tmp_input" 2>/dev/null) || result="{}"
  rm -f "$tmp_input"
  echo "$result"
}

# ---------------------------------------------------------------------------
# Test 1: session:init — creates state file
# ---------------------------------------------------------------------------
echo "=== Test 1: session:init ==="
SESSION_ID="smoke-test-$$"
$CLI session:init \
  --session-id "$SESSION_ID" \
  --state-dir "$STATE_DIR" \
  --max-iterations 10 \
  --prompt "Build a test app" \
  --json >/dev/null 2>&1 || true

STATE_FILE="$STATE_DIR/${SESSION_ID}.md"
assert_file_exists "session:init creates state file" "$STATE_FILE"
assert_contains "state file has active:true" "$(cat "$STATE_FILE" 2>/dev/null)" "active: true"
assert_contains "state file has iteration:1" "$(cat "$STATE_FILE" 2>/dev/null)" "iteration: 1"
assert_contains "state file has prompt" "$(cat "$STATE_FILE" 2>/dev/null)" "Build a test app"

# ---------------------------------------------------------------------------
# Test 2: hook:run stop — no session_id, outputs approve
# ---------------------------------------------------------------------------
echo ""
echo "=== Test 2: hook:run stop (no session) ==="
OUTPUT=$(run_hook "stop" '{}')
assert_no_decision "hook:run stop (empty payload)" "$OUTPUT"

# ---------------------------------------------------------------------------
# Test 3: hook:run stop — unknown session, outputs approve
# ---------------------------------------------------------------------------
echo ""
echo "=== Test 3: hook:run stop (unknown session) ==="
OUTPUT=$(run_hook "stop" '{"session_id":"nonexistent-999"}')
assert_no_decision "hook:run stop (unknown session)" "$OUTPUT"

# ---------------------------------------------------------------------------
# Test 4: hook:run stop — session with no run, outputs approve
# ---------------------------------------------------------------------------
echo ""
echo "=== Test 4: hook:run stop (session, no run) ==="
# Use a dedicated session so cleanup doesn't affect SESSION_ID used in later tests
NO_RUN_SESSION="smoke-norun-$$"
$CLI session:init \
  --session-id "$NO_RUN_SESSION" \
  --state-dir "$STATE_DIR" \
  --prompt "No-run test" \
  --json >/dev/null 2>&1 || true
OUTPUT=$(run_hook "stop" "{\"session_id\":\"${NO_RUN_SESSION}\"}")
assert_no_decision "hook:run stop (session, no run) → approve" "$OUTPUT"

# ---------------------------------------------------------------------------
# Test 5: hook:run session-start — creates baseline state file
# ---------------------------------------------------------------------------
echo ""
echo "=== Test 5: hook:run session-start ==="
NEW_SESSION="smoke-start-$$"
OUTPUT=$(run_hook "session-start" "{\"session_id\":\"${NEW_SESSION}\"}")
NEW_STATE="$STATE_DIR/${NEW_SESSION}.md"
assert_file_exists "hook:run session-start creates state file" "$NEW_STATE"
[[ "$OUTPUT" == "{}" ]] && pass "session-start outputs {}" || fail "session-start: expected {}, got: $OUTPUT"

# ---------------------------------------------------------------------------
# Test 6: hook:run session-start — does not overwrite existing
# ---------------------------------------------------------------------------
echo ""
echo "=== Test 6: hook:run session-start (idempotent) ==="
OUTPUT2=$(run_hook "session-start" "{\"session_id\":\"${NEW_SESSION}\"}")
assert_contains "session-start does not reset existing session" "$(cat "$NEW_STATE" 2>/dev/null)" "active: true"

# ---------------------------------------------------------------------------
# Test 7: session:init re-entrant guard
# ---------------------------------------------------------------------------
echo ""
echo "=== Test 7: session:init (re-entrant guard) ==="
# Use a fresh session so Test 4's stop-hook cleanup doesn't interfere
GUARD_SESSION="smoke-guard-$$"
$CLI session:init \
  --session-id "$GUARD_SESSION" \
  --state-dir "$STATE_DIR" \
  --prompt "First attempt" \
  --json >/dev/null 2>&1 || true
REINIT_OUT=$($CLI session:init \
  --session-id "$GUARD_SESSION" \
  --state-dir "$STATE_DIR" \
  --prompt "Second attempt" \
  --json 2>&1) || true
assert_contains "session:init blocks re-entrant init" "$REINIT_OUT" "SESSION_EXISTS"

# ---------------------------------------------------------------------------
# Test 8: session:associate — links run to session
# ---------------------------------------------------------------------------
echo ""
echo "=== Test 8: session:associate ==="
ASSOC_OUT=$($CLI session:associate \
  --session-id "$SESSION_ID" \
  --state-dir "$STATE_DIR" \
  --run-id "smoke-run-$$" \
  --json 2>&1) || true
assert_contains "session:associate outputs run-id" "$ASSOC_OUT" "smoke-run-"
assert_contains "state file has run_id" "$(cat "$STATE_FILE" 2>/dev/null)" "smoke-run-"

# ---------------------------------------------------------------------------
# Test 9: hook:run stop — max iterations guard
# ---------------------------------------------------------------------------
echo ""
echo "=== Test 9: hook:run stop (max iterations guard) ==="
MAX_SESSION="smoke-max-$$"
MAX_STATE="$STATE_DIR/${MAX_SESSION}.md"
cat > "$MAX_STATE" <<EOF
---
active: true
iteration: 5
max_iterations: 5
run_id: ""
started_at: "2024-01-01T00:00:00Z"
last_iteration_at: "2024-01-01T00:00:00Z"
iteration_times:
---

Max iteration test
EOF

OUTPUT=$(run_hook "stop" "{\"session_id\":\"${MAX_SESSION}\"}")
assert_no_decision "hook:run stop (max iterations → approve)" "$OUTPUT"
[[ ! -f "$MAX_STATE" ]] && pass "state file cleaned up after max iterations" || fail "state file should be cleaned up"

# ---------------------------------------------------------------------------
# Test 10: session:resume — creates state for an existing run
# ---------------------------------------------------------------------------
echo ""
echo "=== Test 10: session:resume ==="
FAKE_RUN="smoke-resume-run-$$"
FAKE_RUN_DIR="$RUNS_DIR/$FAKE_RUN"
mkdir -p "$FAKE_RUN_DIR/journal"

cat > "$FAKE_RUN_DIR/run.json" <<EOF
{
  "schemaVersion": "2026.01.run-metadata",
  "runId": "${FAKE_RUN}",
  "processId": "test-process",
  "entrypoint": { "importPath": "/tmp/test.js", "exportName": "process" },
  "layoutVersion": 1,
  "createdAt": "2024-01-01T00:00:00Z"
}
EOF

cat > "$FAKE_RUN_DIR/journal/000001.01ARZ3NDEKTSV4RRFFQ69G5FAV.json" <<'EOF'
{"type":"RUN_CREATED","recordedAt":"2024-01-01T00:00:00Z","data":{},"checksum":"abc"}
EOF

RESUME_SESSION="smoke-resume-$$"
$CLI session:resume \
  --session-id "$RESUME_SESSION" \
  --run-id "$FAKE_RUN" \
  --state-dir "$STATE_DIR" \
  --runs-dir "$RUNS_DIR" \
  --json >/dev/null 2>&1 || true

RESUME_STATE="$STATE_DIR/${RESUME_SESSION}.md"
assert_file_exists "session:resume creates state file" "$RESUME_STATE"
assert_contains "resume state has run_id" "$(cat "$RESUME_STATE" 2>/dev/null)" "$FAKE_RUN"

# ---------------------------------------------------------------------------
# Test 11: setup-babysitter-run.sh script
# ---------------------------------------------------------------------------
echo ""
echo "=== Test 11: setup-babysitter-run.sh ==="
SCRIPT_SESSION="smoke-script-$$"
SCRIPT_OUT=$(bash "$EXTENSION_DIR/scripts/setup-babysitter-run.sh" \
  --gemini-session-id "$SCRIPT_SESSION" \
  --state-dir "$STATE_DIR" \
  --max-iterations 5 \
  "Test task from script" 2>&1) || true

SCRIPT_STATE="$STATE_DIR/${SCRIPT_SESSION}.md"
assert_file_exists "setup-babysitter-run.sh creates state file" "$SCRIPT_STATE"
assert_contains "setup script success message" "$SCRIPT_OUT" "Babysitter loop activated"
assert_contains "setup script prints session ID" "$SCRIPT_OUT" "$SCRIPT_SESSION"

# ---------------------------------------------------------------------------
# Test 12: associate-session-with-run.sh script
# ---------------------------------------------------------------------------
echo ""
echo "=== Test 12: associate-session-with-run.sh ==="
ASSOC_OUT2=$(bash "$EXTENSION_DIR/scripts/associate-session-with-run.sh" \
  --gemini-session-id "$SCRIPT_SESSION" \
  --run-id "script-run-$$" \
  --state-dir "$STATE_DIR" 2>&1) || true

assert_contains "associate script success message" "$ASSOC_OUT2" "Associated session"
assert_contains "script state has run_id" "$(cat "$SCRIPT_STATE" 2>/dev/null)" "script-run-"

# ---------------------------------------------------------------------------
# Test 13: setup-babysitter-run-resume.sh script
# ---------------------------------------------------------------------------
echo ""
echo "=== Test 13: setup-babysitter-run-resume.sh ==="
RESUME_SCRIPT_SESSION="smoke-resume-script-$$"
RESUME_SCRIPT_OUT=$(bash "$EXTENSION_DIR/scripts/setup-babysitter-run-resume.sh" \
  --gemini-session-id "$RESUME_SCRIPT_SESSION" \
  --run-id "$FAKE_RUN" \
  --state-dir "$STATE_DIR" \
  --runs-dir "$RUNS_DIR" 2>&1) || true

RESUME_SCRIPT_STATE="$STATE_DIR/${RESUME_SCRIPT_SESSION}.md"
assert_file_exists "setup-babysitter-run-resume.sh creates state file" "$RESUME_SCRIPT_STATE"
assert_contains "resume script success message" "$RESUME_SCRIPT_OUT" "resume activated"

# ---------------------------------------------------------------------------
# Test 14: hook:run stop — active run triggers block
# ---------------------------------------------------------------------------
echo ""
echo "=== Test 14: hook:run stop (active run → block) ==="
ACTIVE_SESSION="smoke-active-$$"
ACTIVE_RUN="smoke-active-run-$$"
ACTIVE_RUN_DIR="$RUNS_DIR/$ACTIVE_RUN"
mkdir -p "$ACTIVE_RUN_DIR/journal"

cat > "$ACTIVE_RUN_DIR/run.json" <<EOF
{
  "schemaVersion": "2026.01.run-metadata",
  "runId": "${ACTIVE_RUN}",
  "processId": "test",
  "entrypoint": { "importPath": "/tmp/t.js", "exportName": "process" },
  "layoutVersion": 1,
  "createdAt": "2024-01-01T00:00:00Z"
}
EOF
cat > "$ACTIVE_RUN_DIR/journal/000001.01ARZ3NDEKTSV4RRFFQ69G5FAV.json" <<EOF
{"type":"RUN_CREATED","recordedAt":"2024-01-01T00:00:00Z","data":{},"checksum":"abc"}
EOF

# Create active session via session:init + associate
$CLI session:init \
  --session-id "$ACTIVE_SESSION" \
  --state-dir "$STATE_DIR" \
  --prompt "Active run test" \
  --json >/dev/null 2>&1 || true
$CLI session:associate \
  --session-id "$ACTIVE_SESSION" \
  --state-dir "$STATE_DIR" \
  --run-id "$ACTIVE_RUN" \
  --json >/dev/null 2>&1 || true

OUTPUT=$(run_hook "stop" "{\"session_id\":\"${ACTIVE_SESSION}\",\"prompt_response\":\"I ran the iteration.\"}")
assert_decision_block "hook:run stop (active run → block)" "$OUTPUT"
assert_contains "block response has systemMessage" "$OUTPUT" "systemMessage"
assert_contains "block response has reason with prompt" "$OUTPUT" "Active run test"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "============================================"
echo "  SMOKE TEST RESULTS"
echo "============================================"
echo "  PASS: $PASS"
echo "  FAIL: $FAIL"

if [[ $FAIL -gt 0 ]]; then
  echo ""
  echo "  FAILURES:"
  for err in "${ERRORS[@]}"; do
    echo "    ❌ $err"
  done
  echo ""
  exit 1
fi

echo ""
echo "  All smoke tests passed! ✅"
echo ""
exit 0
