# Gemini CLI Harness Integration for Babysitter SDK

Technical reference for integrating the babysitter SDK orchestration loop with
[Gemini CLI](https://github.com/google-gemini/gemini-cli). Covers the full
lifecycle from extension registration, session management, the AfterAgent hook
orchestration loop, effect execution, and completion proof validation.

For the harness-agnostic guide, see [Generic Harness Guide](../generic-harness-guide.md).
For the canonical reference implementation, see [Claude Code Integration](../claude-code-integration.md).

---

## Glossary

| Term | Definition |
|------|-----------|
| **Effect** | A unit of work requested by a process function during orchestration. Effects have a `kind` (node, breakpoint, sleep, orchestrator_task), an `effectId`, and a lifecycle: requested, pending, resolved. The process function calls `ctx.task()` to request an effect; the harness executes it externally and posts the result back. |
| **Completion Proof** | A SHA-256 hash (`sha256("{runId}:babysitter-completion-secret-v1")`) that the SDK emits only when a run genuinely completes. The agent must echo this value inside `<promise>` tags so the AfterAgent hook can verify the run finished before allowing the session to exit. |
| **Hook** | A script or function that fires at a specific point in the Gemini CLI or babysitter lifecycle. Gemini CLI hooks (SessionStart, AfterAgent, SessionEnd) communicate via stdin/stdout JSON. Babysitter hooks (on-run-start, on-task-complete, etc.) are dispatched internally by the SDK via `callHook()`. |
| **Harness** | The host environment that drives the babysitter orchestration loop. Each harness (Claude Code, Gemini CLI, etc.) implements session management, the stop-check loop, and effect execution using its own extension/plugin system. The babysitter SDK is harness-agnostic; the harness adapter translates between SDK conventions and the host's hook protocol. |

---

## Table of Contents

1. [Extension Manifest and Registration](#1-extension-manifest-and-registration)
2. [SessionStart Hook -- Initialization](#2-sessionstart-hook----initialization)
3. [Run Creation and Session Binding](#3-run-creation-and-session-binding)
4. [The AfterAgent Hook -- Core Orchestration Loop](#4-the-afteragent-hook----core-orchestration-loop)
5. [Effect Execution and Result Posting](#5-effect-execution-and-result-posting)
6. [Completion Proof and Clean Exit](#6-completion-proof-and-clean-exit)
7. [Testing the Integration](#7-testing-the-integration)
8. [MCP Server Deployment](#8-mcp-server-deployment)
9. [Troubleshooting](#9-troubleshooting)

---

## State File Format

Session state is stored as a Markdown file with YAML frontmatter at
`{extensionDir}/state/{sessionId}.md`. The file is created by `session:init`
and updated by `session:associate` and `hook:run`.

### Schema

```yaml
---
active: true                          # Boolean. Whether the session is actively orchestrating.
iteration: 1                          # Integer >= 1. Current iteration number, incremented by hook:run.
max_iterations: 256                   # Integer. Upper bound before forced exit (BABYSITTER_MAX_ITERATIONS).
run_id: ""                            # String. Empty until session:associate binds a run. ULID format when set.
started_at: "2026-03-02T10:00:00Z"   # ISO-8601. When session:init created this file.
last_iteration_at: "2026-03-02T10:00:00Z"  # ISO-8601. Timestamp of the most recent iteration.
iteration_times:                      # Array of numbers (seconds). Duration of each iteration for runaway detection.
---
```

### Field Constraints

| Field | Type | Created By | Updated By |
|-------|------|-----------|-----------|
| `active` | boolean | `session:init` | `hook:run` (set to `false` on cleanup) |
| `iteration` | integer | `session:init` (value: 1) | `hook:run` (incremented each cycle) |
| `max_iterations` | integer | `session:init` (default: 256) | Not updated after creation |
| `run_id` | string | `session:init` (value: `""`) | `session:associate` (set to ULID) |
| `started_at` | ISO-8601 | `session:init` | Not updated after creation |
| `last_iteration_at` | ISO-8601 | `session:init` | `hook:run` (each iteration) |
| `iteration_times` | number[] | `session:init` (value: `[]`) | `hook:run` (appended each iteration) |

---

## Architecture Overview

```
+-------------------------------------------------------------------+
|                        Gemini CLI Host                             |
|                                                                   |
|  +---------------------+    +-------------------------------+     |
|  | Extension Manifest   |    | Hook System                   |     |
|  | gemini-extension.json|    |  SessionStart -> session-init  |     |
|  | - hooks              |    |  AfterAgent  -> stop-check     |     |
|  | - mcpServers         |    |  SessionEnd  -> cleanup        |     |
|  | - commands            |    +-------------------------------+     |
|  +---------------------+                                         |
+-------------------------------------------------------------------+
         |                              |
         v                              v
+-------------------+    +------------------------------------+
| babysitter CLI    |    | Session State Files                |
| (SDK npm package) |    | {extensionDir}/state/              |
|                   |    |   {sessionId}.md                   |
| session:init      |    +------------------------------------+
| run:create        |                   |
| run:iterate       |                   v
| task:list         |    +------------------------------------+
| task:post         |    | Run Directory                      |
| session:*         |    | .a5c/runs/{runId}/                 |
+-------------------+    |   run.json, journal/, tasks/,      |
                         |   state/, blobs/                   |
                         +------------------------------------+
```

### Gemini CLI Architecture Context

Gemini CLI is an open-source TypeScript monorepo using React + Ink for its TUI.
Key architectural properties relevant to this integration:

| Property | Detail |
|----------|--------|
| Runtime | Node.js (TypeScript) |
| Agent pattern | ReAct loop (reason-act cycle) |
| Extension manifest | `gemini-extension.json` |
| Hook protocol | stdin/stdout JSON, exit codes 0/2 |
| Session storage | `~/.gemini/tmp/<project_hash>/chats/` |
| Session resume | `gemini --resume latest` or by index/UUID |
| Config files | `.gemini/settings.json` (project), `~/.gemini/settings.json` (user) |
| Context files | `GEMINI.md` (equivalent to `CLAUDE.md`) |
| MCP support | Full (tools, resources, prompts, OAuth, tool filtering) |
| Tool system | ToolRegistry with file/shell/web + MCP tools |
| Environment vars | `GEMINI_SESSION_ID`, `GEMINI_PROJECT_DIR`, `GEMINI_CWD` |

### Gemini CLI Hook Protocol

Gemini CLI hooks communicate via a stdin/stdout JSON protocol. All hook scripts
in this document follow this protocol. It is defined once here and referenced
by each hook section.

| Aspect | Detail |
|--------|--------|
| Input | JSON payload on stdin |
| Output | JSON on stdout |
| Debug | stderr only (stdout must be clean JSON or empty) |
| Exit 0 | Success; stdout parsed as JSON |
| Exit 2 | Critical block; stderr used as rejection reason |
| Other codes | Non-fatal warning; interaction proceeds |

**AfterAgent decision mapping (babysitter to Gemini CLI):**

| Babysitter Decision | Gemini CLI stdout | Exit Code |
|---------------------|-------------------|-----------|
| BLOCK (continue loop) | `{"decision":"deny","systemMessage":"..."}` | 0 |
| APPROVE (allow exit) | `{}` | 0 |
| Error (fail-safe) | `{}` (allow exit on error) | 0 |

> **Note:** Claude Code uses `"decision": "block"` while Gemini CLI uses
> `"decision": "deny"`. See [Appendix B](#appendix-b-gemini-cli-vs-claude-code-hook-mapping)
> for the full mapping.

### Gemini CLI Hook Types

Gemini CLI exposes 7 lifecycle hook events:

| Hook Event | When It Fires | Babysitter Use |
|------------|---------------|----------------|
| `SessionStart` | Session begins (startup, resume, clear) | Initialize session state file |
| `BeforeAgent` | Before the agent loop starts a turn | (Optional) Pre-iteration setup |
| `BeforeToolSelection` | Before tool selection/planning | (Not used) |
| `BeforeTool` | Before a specific tool executes | (Optional) Validate tool calls |
| `AfterModel` | After LLM response received | (Not used) |
| `AfterAgent` | After agent completes a turn | **Core: orchestration loop driver** |
| `SessionEnd` | Session ends (exit, logout) | Cleanup session state file |

### End-to-End Data Flow

```
Gemini CLI starts session
        |
        v
[SessionStart Hook] --> hooks/session-start.sh
        |                    |
        v                    v
  GEMINI_SESSION_ID      babysitter session:init
  available via env      creates baseline state file
        |
        v
  [User invokes /babysit command or agent receives task]
        |
        v
  [Command creates process, calls run:create]
        |
        v
  babysitter run:create --harness gemini-cli --session-id ...
        |
        v
  Session state file updated with runId binding
        |
        v
  [Agent calls run:iterate, executes effects, posts results]
        |
        v
  Agent turn completes --> [AfterAgent Hook]
        |
        v
  hooks/after-agent.sh -> babysitter hook:run --hook-type stop
        |
        v
  Decision: block (continue) or approve (exit)
        |
        +--[block]--> JSON output with systemMessage
        |                  |
        |                  v
        |             Gemini CLI injects context, starts new turn
        |             (agent calls run:iterate, executes effects)
        |                  |
        |                  +---> [AfterAgent Hook] again (loop)
        |
        +--[approve]--> Session ends, state file cleaned up
```

---

## 1. Extension Manifest and Registration

### Directory Structure

```
~/.gemini/extensions/babysitter/
  gemini-extension.json       # Extension manifest
  hooks/
    hooks.json                # Hook definitions (if supported by extension hooks feature)
    session-start.sh          # SessionStart hook script
    after-agent.sh            # AfterAgent hook script (core loop driver)
    session-end.sh            # SessionEnd cleanup script
    install-sdk.sh            # SDK installation helper
  commands/
    babysit.toml              # /babysit custom command
  mcp-server/
    babysitter-tools.js       # MCP server for native tool access (see Section 8)
  state/                      # Session state files (created at runtime)
  GEMINI.md                   # Context instructions for the agent
```

### `gemini-extension.json`

```json
{
  "name": "babysitter",
  "version": "4.0.139",
  "description": "Process orchestration framework for structured AI agent workflows",
  "sdkVersion": "0.0.170",
  "contextFileName": "GEMINI.md"
}
```

The `contextFileName` field tells Gemini CLI to load `GEMINI.md` from the
extension directory, which provides the agent with instructions about how to
use the babysitter CLI commands.

### Hook Registration via `.gemini/settings.json`

Since Gemini CLI hooks are configured in `settings.json` (project or user
level), register the babysitter hooks there. Place the following in your
project's `.gemini/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "name": "babysitter-session-start",
            "type": "command",
            "command": "$HOME/.gemini/extensions/babysitter/hooks/session-start.sh",
            "timeout": 30000
          }
        ]
      }
    ],
    "AfterAgent": [
      {
        "hooks": [
          {
            "name": "babysitter-after-agent",
            "type": "command",
            "command": "$HOME/.gemini/extensions/babysitter/hooks/after-agent.sh",
            "timeout": 30000
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "matcher": "*",
        "hooks": [
          {
            "name": "babysitter-session-end",
            "type": "command",
            "command": "$HOME/.gemini/extensions/babysitter/hooks/session-end.sh",
            "timeout": 10000
          }
        ]
      }
    ]
  }
}
```

If using extension-bundled hooks (via `hooks/hooks.json` inside the extension
directory), the format is identical but placed in the extension's `hooks/hooks.json`
file. Note that extension hooks require the extension hooks feature to be available
in your Gemini CLI version and may require user consent at install time.

### Extension-Bundled Hooks (`hooks/hooks.json`)

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${extensionPath}/hooks/session-start.sh"
          }
        ]
      }
    ],
    "AfterAgent": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${extensionPath}/hooks/after-agent.sh"
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "${extensionPath}/hooks/session-end.sh"
          }
        ]
      }
    ]
  }
}
```

The `${extensionPath}` variable is substituted by Gemini CLI at runtime with
the absolute path to the installed extension directory.

### Environment Variables Available to Hooks

| Variable | Description |
|----------|-------------|
| `GEMINI_SESSION_ID` | Unique identifier for the current session |
| `GEMINI_PROJECT_DIR` | Absolute path to the project root |
| `GEMINI_CWD` | Current working directory |

### Custom Command: `/babysit`

Create `commands/babysit.toml`:

```toml
[command]
description = "Start a babysitter orchestration loop for the current task"

[command.steps]
[[command.steps.prompt]]
text = """
You have the babysitter SDK installed. Use the following workflow:

1. Create a process definition for the user's task
2. Run: babysitter run:create --process-id <id> --entry <file>#process --inputs <inputs.json> --prompt "<task>" --json
3. Run: babysitter session:associate --session-id $GEMINI_SESSION_ID --state-dir <stateDir> --json
4. Run: babysitter run:iterate .a5c/runs/<runId> --json
5. Execute any pending effects (babysitter task:list, then task:post)
6. When run:iterate returns status "completed", output the completionProof in <promise>PROOF</promise> tags

The AfterAgent hook will keep you iterating until the proof is validated.
"""
```

### GEMINI.md Context File

The `GEMINI.md` file is loaded by Gemini CLI as agent context. It should
contain instructions about the babysitter workflow:

```markdown
# Babysitter Orchestration

When running a babysitter-managed process, follow this workflow:

1. Use `babysitter run:iterate .a5c/runs/{runId} --json` to advance the run
2. Check `babysitter task:list .a5c/runs/{runId} --pending --json` for effects
3. Execute each pending effect based on its kind (node, breakpoint, sleep)
4. Post results via `babysitter task:post .a5c/runs/{runId} {effectId} --status ok --value <file> --json`
5. When status is "completed", output `<promise>COMPLETION_PROOF</promise>`

IMPORTANT: Always post results through the CLI. Never write result.json directly.
IMPORTANT: For breakpoints, NEVER auto-approve. Present to user for explicit approval.
```

---

## 2. SessionStart Hook -- Initialization

**Script:** `hooks/session-start.sh`

The SessionStart hook fires when Gemini CLI begins a new session or resumes an
existing one. It installs the babysitter CLI (if needed) and creates a baseline
session state file. See [Hook Protocol](#gemini-cli-hook-protocol) for the
stdin/stdout JSON contract.

### `hooks/session-start.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Babysitter SessionStart Hook for Gemini CLI
#
# Protocol: see "Gemini CLI Hook Protocol" in Architecture Overview
# ---------------------------------------------------------------------------

EXTENSION_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${EXTENSION_DIR}/state"
SDK_VERSION=""

# Read sdkVersion from gemini-extension.json if present
if [ -f "${EXTENSION_DIR}/gemini-extension.json" ]; then
    SDK_VERSION=$(jq -r '.sdkVersion // empty' "${EXTENSION_DIR}/gemini-extension.json" 2>/dev/null || true)
fi

# --- SDK Installation ---
MARKER_FILE="${EXTENSION_DIR}/.babysitter-install-attempted"

ensure_babysitter_cli() {
    if command -v babysitter &>/dev/null; then
        echo "babysitter CLI found on PATH" >&2
        return 0
    fi

    if [ -f "$MARKER_FILE" ]; then
        echo "Install already attempted, checking fallbacks..." >&2
    else
        echo "Installing babysitter SDK ${SDK_VERSION}..." >&2

        # Try global install
        if npm install -g "@a5c-ai/babysitter-sdk@${SDK_VERSION}" 2>/dev/null; then
            touch "$MARKER_FILE"
            if command -v babysitter &>/dev/null; then
                return 0
            fi
        fi

        # Fallback: prefix install
        if npm install -g "@a5c-ai/babysitter-sdk@${SDK_VERSION}" \
            --prefix "$HOME/.local" 2>/dev/null; then
            export PATH="$HOME/.local/bin:$PATH"
            touch "$MARKER_FILE"
            if command -v babysitter &>/dev/null; then
                return 0
            fi
        fi

        touch "$MARKER_FILE"
    fi

    # Final check with prefix path
    if [ -x "$HOME/.local/bin/babysitter" ]; then
        export PATH="$HOME/.local/bin:$PATH"
        return 0
    fi

    # Fallback: define babysitter as npx wrapper
    echo "Using npx fallback for babysitter CLI" >&2
    babysitter() {
        npx -y "@a5c-ai/babysitter-sdk@${SDK_VERSION}" babysitter "$@"
    }
    export -f babysitter
}

# --- Main ---
ensure_babysitter_cli

# Read stdin (Gemini CLI hook payload)
INPUT=$(cat)
echo "SessionStart hook received input" >&2

# Extract session ID from environment (Gemini CLI provides this)
SESSION_ID="${GEMINI_SESSION_ID:-}"
if [ -z "$SESSION_ID" ]; then
    # Try to extract from stdin JSON payload
    SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null || true)
fi

if [ -z "$SESSION_ID" ]; then
    echo "No session ID available, skipping session init" >&2
    echo '{}'
    exit 0
fi

# Create state directory
mkdir -p "$STATE_DIR"

# Initialize babysitter session
RESULT=$(babysitter session:init \
    --session-id "$SESSION_ID" \
    --state-dir "$STATE_DIR" \
    --json 2>/dev/null) || true

echo "Session initialized: ${SESSION_ID}" >&2
echo '{}'
exit 0
```

### What This Creates

A session state file at `{extensionDir}/state/{sessionId}.md` with YAML
frontmatter. See [State File Format](#state-file-format) for the full schema.
The `run_id` field is empty until a run is created and bound (Section 3).

---

## 3. Run Creation and Session Binding

After the agent receives a task to orchestrate, it must create a babysitter run
and bind it to the current session. This is typically triggered by the `/babysit`
command or by the agent following instructions in `GEMINI.md`.

### CLI Invocation Sequence

```bash
# Step 1: Create the run
babysitter run:create \
  --process-id my-process \
  --entry ./process.js#process \
  --inputs inputs.json \
  --prompt "Build the API" \
  --json

# Step 2: Bind session to run
babysitter session:associate \
  --session-id "${GEMINI_SESSION_ID}" \
  --run-id "${RUN_ID}" \
  --state-dir "${EXTENSION_DIR}/state" \
  --json
```

### Expected JSON Responses

**`run:create` response:**

```json
{
  "runId": "01JQXYZ123ABC",
  "runDir": ".a5c/runs/01JQXYZ123ABC",
  "processId": "my-process",
  "entryPoint": "./process.js#process",
  "createdAt": "2026-03-02T10:00:05Z"
}
```

**`session:associate` response:**

```json
{
  "sessionId": "gemini-abc123",
  "runId": "01JQXYZ123ABC",
  "stateDir": "/home/user/.gemini/extensions/babysitter/state",
  "bound": true
}
```

### Binding Flow

```
Agent receives task
        |
        v
  babysitter run:create --process-id ... --entry ... --inputs ... --json
        |
        v
  Returns: { "runId": "abc123", "runDir": ".a5c/runs/abc123" }
        |
        v
  babysitter session:associate \
    --session-id $GEMINI_SESSION_ID \
    --run-id abc123 \
    --state-dir {extensionDir}/state \
    --json
        |
        v
  State file updated: run_id = "abc123"
```

### TypeScript Helper (for MCP Server or Plugin Hook)

If implementing the integration as a Gemini CLI plugin hook (npm package), the
binding can be done programmatically:

```typescript
import { execSync } from 'child_process';

interface RunCreateResult {
  runId: string;
  runDir: string;
}

function createAndBindRun(opts: {
  processId: string;
  entryPoint: string;
  inputsPath: string;
  prompt: string;
  sessionId: string;
  stateDir: string;
}): RunCreateResult {
  // Step 1: Create the run
  const createOutput = execSync(
    `babysitter run:create` +
    ` --process-id ${opts.processId}` +
    ` --entry ${opts.entryPoint}` +
    ` --inputs ${opts.inputsPath}` +
    ` --prompt "${opts.prompt}"` +
    ` --json`,
    { encoding: 'utf-8' }
  );
  const { runId, runDir } = JSON.parse(createOutput) as RunCreateResult;

  // Step 2: Bind session
  execSync(
    `babysitter session:associate` +
    ` --session-id ${opts.sessionId}` +
    ` --run-id ${runId}` +
    ` --state-dir ${opts.stateDir}` +
    ` --json`,
    { encoding: 'utf-8' }
  );

  return { runId, runDir };
}
```

### Re-entrant Run Prevention

If the session is already bound to a different run, `session:associate` will
fail with an error. The agent must either:

1. Complete the existing run first
2. Remove the old session state file
3. Report the conflict to the user

---

## 4. The AfterAgent Hook -- Core Orchestration Loop

**Script:** `hooks/after-agent.sh`

The AfterAgent hook is the central mechanism that converts Gemini CLI's
single-turn agent execution into a multi-iteration orchestration loop. It fires
after every agent turn, evaluates whether the run is complete, and either
allows the session to end or triggers another agent turn.

For the hook protocol (stdin/stdout JSON contract, exit codes, decision mapping),
see [Hook Protocol](#gemini-cli-hook-protocol).

### `hooks/after-agent.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Babysitter AfterAgent Hook for Gemini CLI
#
# This is the core orchestration loop driver. After each agent turn, it
# checks whether the babysitter run is complete and either denies exit
# (continuing the loop) or allows exit (run complete or no active loop).
#
# Protocol: see "Gemini CLI Hook Protocol" in Architecture Overview
# ---------------------------------------------------------------------------

EXTENSION_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${EXTENSION_DIR}/state"
SESSION_ID="${GEMINI_SESSION_ID:-}"
PROJECT_DIR="${GEMINI_PROJECT_DIR:-$(pwd)}"

# Ensure babysitter CLI is available
if ! command -v babysitter &>/dev/null; then
    if [ -x "$HOME/.local/bin/babysitter" ]; then
        export PATH="$HOME/.local/bin:$PATH"
    else
        SDK_VERSION=$(jq -r '.sdkVersion // "latest"' \
            "${EXTENSION_DIR}/gemini-extension.json" 2>/dev/null || echo "latest")
        babysitter() {
            npx -y "@a5c-ai/babysitter-sdk@${SDK_VERSION}" babysitter "$@"
        }
    fi
fi

# Read stdin (AfterAgent hook payload from Gemini CLI)
INPUT=$(cat)
echo "AfterAgent hook fired" >&2

# --- Guard 1: No session ID ---
if [ -z "$SESSION_ID" ]; then
    echo "No session ID, allowing exit" >&2
    echo '{}'
    exit 0
fi

# --- Guard 2: No state file ---
STATE_FILE="${STATE_DIR}/${SESSION_ID}.md"
if [ ! -f "$STATE_FILE" ]; then
    echo "No state file found, allowing exit" >&2
    echo '{}'
    exit 0
fi

# --- Delegate to babysitter CLI for full decision logic ---
# Capture the last agent output for promise tag scanning
LAST_OUTPUT=$(echo "$INPUT" | jq -r '.last_assistant_message // empty' 2>/dev/null || true)

# Build hook input JSON for babysitter
HOOK_INPUT=$(jq -n \
  --arg sid "$SESSION_ID" \
  --arg msg "$LAST_OUTPUT" \
  '{session_id: $sid, last_assistant_message: $msg}')

# Run the babysitter stop-hook logic
RESULT=$(echo "$HOOK_INPUT" | babysitter hook:run \
    --hook-type stop \
    --harness gemini-cli \
    --plugin-root "$EXTENSION_DIR" \
    --json 2>/dev/null) || {
    echo "hook:run failed, allowing exit" >&2
    echo '{}'
    exit 0
}

echo "hook:run result: $RESULT" >&2

# Parse the decision from babysitter
DECISION=$(echo "$RESULT" | jq -r '.decision // empty' 2>/dev/null || true)

if [ "$DECISION" = "block" ]; then
    # Extract reason and systemMessage from babysitter output
    REASON=$(echo "$RESULT" | jq -r '.reason // empty' 2>/dev/null || true)
    SYSTEM_MSG=$(echo "$RESULT" | jq -r '.systemMessage // empty' 2>/dev/null || true)

    echo "BLOCK: ${SYSTEM_MSG}" >&2

    # Gemini CLI uses "deny" instead of "block"
    jq -n --arg msg "${REASON:-Continue babysitter orchestration}" \
      '{decision: "deny", systemMessage: $msg}'
    exit 0
fi

# APPROVE: allow exit
echo "APPROVE: allowing exit" >&2
echo '{}'
exit 0
```

### Decision State Diagram

The decision algorithm is executed by `babysitter hook:run --hook-type stop`.
The following state diagram includes the decision logic at each transition:

```
                    +----------+
                    |  SESSION  |
                    |  STARTED  |
                    +----+-----+
                         |
                    SessionStart hook
                    creates baseline state
                         |
                         v
                    +----------+
                    |  UNBOUND  |  (state file exists, runId = "")
                    +----+-----+
                         |
                    run:create + session:associate
                    binds session to run
                         |
                         v
                    +----------+
              +---->|  ACTIVE   |  (state file has runId, iteration N)
              |     +----+-----+
              |          |
              |     Agent turn ends -> AfterAgent hook fires
              |          |
              |          v
              |     +---------+
              |     | EVALUATE |  (babysitter hook:run --hook-type stop)
              |     +----+----+
              |          |
              |     Decision logic (evaluated in order):
              |     1. No state file?             -> APPROVE
              |     2. iteration >= maxIterations? -> APPROVE + cleanup
              |     3. avg(last 3) <= 15s after    -> APPROVE + cleanup
              |        5+ iterations?               (runaway detected)
              |     4. No runId bound?             -> APPROVE + cleanup
              |     5. Run state unknown?          -> APPROVE + cleanup
              |     6. Run completed AND           -> APPROVE + cleanup
              |        <promise> matches proof?
              |     7. Otherwise                   -> DENY (continue loop)
              |          |
              |     +----+----+
              |     |         |
              |     v         v
              |  +--------+ +----------------+
              |  |APPROVE | | DENY (continue)|
              |  |({})    | | ({"decision":  |
              |  |cleanup | |  "deny",...})   |
              |  +--------+ +-------+--------+
              |                     |
              |   Agent resumes     |
              |   with systemMessage|
              +---------------------+
```

### Context Re-injection

When the AfterAgent hook returns `{"decision":"deny","systemMessage":"..."}`,
Gemini CLI injects the `systemMessage` content as context for the next agent
turn. The babysitter builds this message from four components:

1. **Iteration number and status** -- e.g., "Babysitter iteration 3/256 [waiting]"
2. **What to do next** -- e.g., "Continue orchestration (run:iterate)"
3. **Pending effect information** -- e.g., "Waiting on: node, breakpoint"
4. **The original user prompt** -- preserved from the session state file

**Example systemMessage with all four components:**

```
Babysitter iteration 3/256 [waiting]

ACTION REQUIRED: Continue orchestration by running:
  babysitter run:iterate .a5c/runs/01JQXYZ123ABC --json

Pending effects (2):
  - E001 [node] "compile-source" (pending)
  - E002 [breakpoint] "approve-deploy" (pending)

Original prompt: Build the REST API with authentication and deploy to staging.
```

---

## 5. Effect Execution and Result Posting

Effect execution follows the same pattern as the generic harness guide. The
agent (Gemini model) is responsible for executing these commands within the
Gemini CLI tool environment.

### The Effect Execution Cycle

```
babysitter run:iterate .a5c/runs/{runId} --json
        |
        v
  Returns: { status, action, effects[] }
        |
        v
babysitter task:list .a5c/runs/{runId} --pending --json
        |
        v
  Returns: { tasks: [{ effectId, kind, status, title }] }
        |
        v
  For each pending task:
        |
        +--[kind = "node"]----------> Execute Node.js script
        |                             Read task definition: babysitter task:show {runDir} {effectId} --json
        |                             Run the script, capture stdout/stderr
        |
        +--[kind = "breakpoint"]----> Present to user for approval
        |                             NEVER auto-approve. Ask user explicitly.
        |
        +--[kind = "sleep"]---------> Check if sleep condition is met
        |
        +--[kind = "orchestrator_  -> Delegate to sub-agent
        |    task"]
        |
        v
  babysitter task:post {runDir} {effectId} --status ok --value output.json --json
```

### Expected JSON Responses

**`run:iterate` response (waiting on effects):**

```json
{
  "status": "waiting",
  "action": "execute_effects",
  "runId": "01JQXYZ123ABC",
  "iteration": 2,
  "effects": [
    {
      "effectId": "E001",
      "kind": "node",
      "status": "pending",
      "title": "greet"
    }
  ]
}
```

**`run:iterate` response (run completed):**

```json
{
  "status": "completed",
  "runId": "01JQXYZ123ABC",
  "completionProof": "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2",
  "output": {
    "greeting": "Hello, Gemini!"
  }
}
```

**`task:list --pending` response:**

```json
{
  "tasks": [
    {
      "effectId": "E001",
      "kind": "node",
      "status": "pending",
      "title": "greet",
      "taskDir": ".a5c/runs/01JQXYZ123ABC/tasks/E001"
    }
  ]
}
```

**`task:post` response:**

```json
{
  "effectId": "E001",
  "status": "ok",
  "journalSeq": 4,
  "journalEvent": "EFFECT_RESOLVED"
}
```

### Breakpoint Handling in Gemini CLI

Gemini CLI does not have a built-in equivalent to Claude Code's `AskUserQuestion`
tool. For breakpoints, the agent should:

1. Output the breakpoint question as a clear prompt to the user
2. Wait for user input on the next turn
3. Parse the user's response as approve/reject
4. Post the result via `task:post`

```bash
# Read the breakpoint definition
babysitter task:show .a5c/runs/${RUN_ID} ${EFFECT_ID} --json

# After user responds, post the result
echo '{"approved": true, "response": "Approved by user"}' > /tmp/bp-result.json
babysitter task:post .a5c/runs/${RUN_ID} ${EFFECT_ID} \
  --status ok \
  --value /tmp/bp-result.json \
  --json
```

### Result Posting Protocol

Results MUST be posted through the CLI. Never write `result.json` directly.

```bash
# Write the result value to a file
echo '{"output": "task completed successfully"}' > tasks/${EFFECT_ID}/output.json

# Post through CLI (handles result.json + journal event + cache update)
babysitter task:post .a5c/runs/${RUN_ID} ${EFFECT_ID} \
  --status ok \
  --value tasks/${EFFECT_ID}/output.json \
  --json
```

| Status | Meaning |
|--------|---------|
| `ok` | Task completed successfully; value contains the result |
| `error` | Task failed; value contains error details |

### MCP Server for Effect Execution (Optional)

For a more integrated experience, you can expose babysitter operations as an
MCP server, giving Gemini CLI native tool access instead of requiring the agent
to invoke shell commands. See [Section 8](#8-mcp-server-deployment) for the
complete implementation and deployment instructions.

---

## 6. Completion Proof and Clean Exit

The completion proof mechanism prevents premature exit from the orchestration
loop. It is a SHA-256 hash that becomes available only when the run genuinely
completes.

### Proof Flow

```
run:iterate returns { status: "completed", completionProof: "a1b2c3..." }
        |
        v
  Agent outputs: <promise>a1b2c3...</promise>
        |
        v
  Agent turn ends -> AfterAgent hook fires
        |
        v
  Hook reads session state, loads journal
  Finds RUN_COMPLETED event
  Derives proof: sha256("{runId}:babysitter-completion-secret-v1")
  Scans agent output for <promise>...</promise>
        |
        v
  promiseValue === completionProof --> MATCH
        |
        v
  Output: {} (APPROVE)
  Delete session state file
        |
        v
  Session ends normally
```

### Promise Tag Format

The agent must output the exact completion proof inside `<promise>` tags:

```
<promise>a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2</promise>
```

### SessionEnd Cleanup Hook

**Script:** `hooks/session-end.sh`

As a safety net, the SessionEnd hook cleans up any orphaned state files.
See [Hook Protocol](#gemini-cli-hook-protocol) for the stdin/stdout contract.

```bash
#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Babysitter SessionEnd Hook for Gemini CLI
# Cleans up session state files on session termination.
# ---------------------------------------------------------------------------

EXTENSION_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${EXTENSION_DIR}/state"
SESSION_ID="${GEMINI_SESSION_ID:-}"

if [ -z "$SESSION_ID" ]; then
    echo '{}'
    exit 0
fi

STATE_FILE="${STATE_DIR}/${SESSION_ID}.md"
if [ -f "$STATE_FILE" ]; then
    echo "Cleaning up session state: ${SESSION_ID}" >&2
    rm -f "$STATE_FILE"
fi

echo '{}'
exit 0
```

### Iteration Guards

The AfterAgent hook includes the same iteration guards as the Claude Code
integration:

**Max Iterations Guard:**
```
IF iteration >= maxIterations (default 256):
    APPROVE exit, cleanup state file
```

**Runaway Speed Guard:**
```
IF iteration >= 5:
    avgDuration = average(last 3 iteration durations)
    IF avgDuration <= 15 seconds:
        APPROVE exit (runaway detected), cleanup state file
```

These guards are implemented inside `babysitter hook:run --hook-type stop`
and do not need to be reimplemented in the shell scripts.

---

## 7. Testing the Integration

### Prerequisites

```bash
# Verify Gemini CLI is installed
gemini --version

# Verify babysitter SDK
babysitter version --json

# Verify hooks are registered (see Section 9 for more diagnostic commands)
jq '.hooks' .gemini/settings.json
```

### Smoke Test Checklist

Run these tests in order. Each builds on the previous.

#### Test 1: CLI Availability

```bash
babysitter version --json
```

Expected output:

```json
{
  "version": "0.0.170",
  "name": "@a5c-ai/babysitter-sdk"
}
```

- [ ] Exit code is 0
- [ ] Output contains `"version"` field

#### Test 2: Session Initialization

```bash
export GEMINI_SESSION_ID="test-gemini-001"
EXTENSION_DIR="$HOME/.gemini/extensions/babysitter"

babysitter session:init \
  --session-id "$GEMINI_SESSION_ID" \
  --state-dir "$EXTENSION_DIR/state" \
  --json
```

Expected output:

```json
{
  "sessionId": "test-gemini-001",
  "stateDir": "/home/user/.gemini/extensions/babysitter/state",
  "stateFile": "/home/user/.gemini/extensions/babysitter/state/test-gemini-001.md",
  "created": true
}
```

- [ ] Exit code is 0
- [ ] State file created at `$EXTENSION_DIR/state/test-gemini-001.md`
- [ ] File contains YAML frontmatter with `active: true`, `iteration: 1`, `run_id: ""`

#### Test 3: Run Creation and Binding

```bash
# Create a minimal process file
cat > /tmp/babysitter-gemini-test/process.js << 'EOF'
exports.process = async function(inputs, ctx) {
  const result = await ctx.task('greet', { name: inputs.name });
  return { greeting: result };
};
EOF

echo '{"name": "Gemini"}' > /tmp/babysitter-gemini-test/inputs.json

# Create the run
RUN_OUTPUT=$(babysitter run:create \
  --process-id test-process \
  --entry /tmp/babysitter-gemini-test/process.js#process \
  --inputs /tmp/babysitter-gemini-test/inputs.json \
  --prompt "Test run from Gemini CLI" \
  --json)

RUN_ID=$(echo "$RUN_OUTPUT" | jq -r '.runId')

# Bind session
babysitter session:associate \
  --session-id "$GEMINI_SESSION_ID" \
  --run-id "$RUN_ID" \
  --state-dir "$EXTENSION_DIR/state" \
  --json
```

- [ ] Run creation exit code is 0
- [ ] `RUN_ID` is non-empty
- [ ] State file now has `run_id: "{RUN_ID}"`

#### Test 4: Iteration and Effect Discovery

```bash
ITER_OUTPUT=$(babysitter run:iterate ".a5c/runs/${RUN_ID}" --json)
echo "$ITER_OUTPUT" | jq .

LIST_OUTPUT=$(babysitter task:list ".a5c/runs/${RUN_ID}" --pending --json)
echo "$LIST_OUTPUT" | jq .
```

Expected `run:iterate` output:

```json
{
  "status": "waiting",
  "action": "execute_effects",
  "runId": "01JQXYZ123ABC",
  "iteration": 1,
  "effects": [
    {
      "effectId": "E001",
      "kind": "node",
      "status": "pending",
      "title": "greet"
    }
  ]
}
```

- [ ] `run:iterate` returns a valid status
- [ ] `task:list` returns a `tasks` array

#### Test 5: AfterAgent Hook Simulation

```bash
# Simulate the AfterAgent hook firing
echo '{"session_id":"test-gemini-001"}' | \
  bash "$EXTENSION_DIR/hooks/after-agent.sh"
```

Expected output when run is active and incomplete (the `systemMessage` value
varies based on iteration state and pending effects):

```json
{
  "decision": "deny",
  "systemMessage": "Babysitter iteration 1/256 [waiting]\n\nACTION REQUIRED: Continue orchestration by running:\n  babysitter run:iterate .a5c/runs/01JQXYZ123ABC --json\n\nPending effects (1):\n  - E001 [node] \"greet\" (pending)\n\nOriginal prompt: E2E test from Gemini CLI"
}
```

- [ ] Output is valid JSON
- [ ] Either `{}` (approve) or `{"decision":"deny","systemMessage":"..."}` (deny/continue)

#### Test 6: Iteration Guard

```bash
babysitter session:check-iteration \
  --session-id "$GEMINI_SESSION_ID" \
  --state-dir "$EXTENSION_DIR/state" \
  --json
```

Expected output:

```json
{
  "shouldContinue": true,
  "iteration": 1,
  "maxIterations": 256,
  "runawayDetected": false
}
```

- [ ] Output contains `"shouldContinue": true`

### End-to-End Test Script

```bash
#!/usr/bin/env bash
set -euo pipefail

# End-to-end test for Gemini CLI + Babysitter integration

SESSION_ID="e2e-gemini-$(date +%s)"
EXTENSION_DIR="$HOME/.gemini/extensions/babysitter"
STATE_DIR="$EXTENSION_DIR/state"
TEST_DIR="/tmp/babysitter-gemini-e2e"

export GEMINI_SESSION_ID="$SESSION_ID"
export GEMINI_PROJECT_DIR="$(pwd)"

mkdir -p "$TEST_DIR" "$STATE_DIR"

echo "=== Test 1: CLI Version ==="
babysitter version --json || { echo "FAIL: CLI not available"; exit 1; }

echo "=== Test 2: Session Init ==="
babysitter session:init \
  --session-id "$SESSION_ID" \
  --state-dir "$STATE_DIR" \
  --json || { echo "FAIL: Session init"; exit 1; }
[ -f "$STATE_DIR/${SESSION_ID}.md" ] || { echo "FAIL: State file not created"; exit 1; }

echo "=== Test 3: Run Create ==="
cat > "$TEST_DIR/process.js" << 'PROC'
exports.process = async function(inputs, ctx) {
  const result = await ctx.task('greet', { name: inputs.name });
  return { greeting: result };
};
PROC
echo '{"name": "Gemini"}' > "$TEST_DIR/inputs.json"

RUN_OUTPUT=$(babysitter run:create \
  --process-id e2e-test \
  --entry "$TEST_DIR/process.js#process" \
  --inputs "$TEST_DIR/inputs.json" \
  --prompt "E2E test from Gemini CLI" \
  --json)
RUN_ID=$(echo "$RUN_OUTPUT" | jq -r '.runId')
[ -n "$RUN_ID" ] && [ "$RUN_ID" != "null" ] || { echo "FAIL: No runId"; exit 1; }

echo "=== Test 4: Session Associate ==="
babysitter session:associate \
  --session-id "$SESSION_ID" \
  --run-id "$RUN_ID" \
  --state-dir "$STATE_DIR" \
  --json || { echo "FAIL: Session associate"; exit 1; }

echo "=== Test 5: Run Iterate ==="
ITER_OUTPUT=$(babysitter run:iterate ".a5c/runs/${RUN_ID}" --json 2>/dev/null) || true
echo "Iterate output: $(echo "$ITER_OUTPUT" | jq .)"

echo "=== Test 6: Task List ==="
LIST_OUTPUT=$(babysitter task:list ".a5c/runs/${RUN_ID}" --pending --json 2>/dev/null) || true
echo "Task list: $(echo "$LIST_OUTPUT" | jq .)"

echo "=== Test 7: Check Iteration ==="
GUARD_OUTPUT=$(babysitter session:check-iteration \
  --session-id "$SESSION_ID" \
  --state-dir "$STATE_DIR" \
  --json)
echo "Guard: $(echo "$GUARD_OUTPUT" | jq .)"

echo "=== Cleanup ==="
rm -f "$STATE_DIR/${SESSION_ID}.md"
rm -rf "$TEST_DIR"

echo ""
echo "END-TO-END TEST PASSED"
```

### Common Failure Modes

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| `babysitter: command not found` | SDK not installed or not on PATH | Run session-start.sh or install manually |
| AfterAgent hook always allows exit | No state file, or `run_id` is empty | Check session:init and session:associate ran |
| Infinite loop (never exits) | Completion proof not output by agent | Ensure GEMINI.md instructs agent to output `<promise>` tags |
| Exits after 1 turn | AfterAgent hook not registered | Check `.gemini/settings.json` hooks config |
| `{"decision":"deny"}` not blocking | Hook exit code not 0, or stdout has extra text | Ensure only JSON on stdout; debug output to stderr |
| Iterations very fast, exits early | Runaway detection triggered | Agent is not doing meaningful work per iteration |
| State file corrupt | Non-atomic write or concurrent access | Babysitter CLI handles atomic writes internally |
| `Session already associated` | Previous run not cleaned up | Delete old state file or complete old run |
| Hook not firing | Hooks not enabled in Gemini CLI | Add `"enableHooks": true` to settings.json |
| Hook stderr in stdout | `echo` without `>&2` redirect | Ensure ALL debug output uses `>&2` |

### Hook Equivalence Table (Gemini CLI to Babysitter)

| Babysitter Hook | Gemini CLI Hook | Required | Notes |
|-----------------|-----------------|----------|-------|
| session-start | SessionStart | Yes | Create baseline state file |
| stop | AfterAgent | Yes | Core loop driver (deny/allow) |
| session-end | SessionEnd | Yes | Cleanup state files |
| on-iteration-start | BeforeAgent | Optional | Before run:iterate call |
| on-iteration-end | AfterAgent | Optional | After all effects posted |
| on-breakpoint | (via agent code) | Optional | Present to user manually |
| on-run-start | (via agent code) | Optional | Fire after run:create completes |
| on-run-complete | (via agent code) | Optional | Fire when run:iterate = completed |
| on-run-fail | (via agent code) | Optional | Fire when run:iterate = failed |
| on-task-start | BeforeTool (*) | Optional | Before executing each effect |
| on-task-complete | (via agent code) | Optional | After task:post completes |
| on-score | (via agent code) | Optional | Quality score callback |
| pre-commit | BeforeTool (*) | Optional | Match on shell/write_file tools |
| pre-branch | BeforeTool (*) | Optional | Match on shell tool |

(*) BeforeTool fires for Gemini CLI tool calls, not babysitter task effects.
Full mapping requires custom logic inside the hook scripts.

---

## 8. MCP Server Deployment

This section contains the complete MCP server implementation and deployment
steps. The server exposes babysitter operations as native Gemini CLI tools so
the agent can call `babysitter_iterate`, `babysitter_task_list`, and
`babysitter_task_post` directly instead of invoking shell commands.

### Complete MCP Server Implementation

Save this as `~/.gemini/extensions/babysitter/mcp-server/babysitter-tools.ts`:

```typescript
// mcp-server/babysitter-tools.ts
//
// Complete MCP server exposing babysitter CLI operations as native Gemini CLI tools.
// Build: npx tsc babysitter-tools.ts --outDir . --module commonjs --target ES2022 \
//          --esModuleInterop --moduleResolution node
// Run:   node babysitter-tools.js

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execSync } from 'child_process';

const BABYSITTER_BIN = process.env.BABYSITTER_BIN || 'babysitter';

function run(cmd: string): string {
  return execSync(cmd, { encoding: 'utf-8', timeout: 30_000 });
}

const server = new McpServer({
  name: 'babysitter-mcp',
  version: '1.0.0',
});

// --- Tools ---

server.tool(
  'babysitter_iterate',
  'Advance a babysitter run and discover pending effects',
  { runDir: z.string().describe('Path to the run directory, e.g. .a5c/runs/abc123') },
  async ({ runDir }) => {
    const output = run(`${BABYSITTER_BIN} run:iterate ${runDir} --json`);
    return { content: [{ type: 'text', text: output }] };
  }
);

server.tool(
  'babysitter_task_list',
  'List pending tasks for a babysitter run',
  { runDir: z.string(), pending: z.boolean().default(true) },
  async ({ runDir, pending }) => {
    const flag = pending ? '--pending' : '';
    const output = run(`${BABYSITTER_BIN} task:list ${runDir} ${flag} --json`);
    return { content: [{ type: 'text', text: output }] };
  }
);

server.tool(
  'babysitter_task_post',
  'Post a result for a completed effect',
  {
    runDir: z.string(),
    effectId: z.string(),
    status: z.enum(['ok', 'error']),
    valuePath: z.string().describe('Path to JSON file containing the result value'),
  },
  async ({ runDir, effectId, status, valuePath }) => {
    const output = run(
      `${BABYSITTER_BIN} task:post ${runDir} ${effectId} --status ${status} --value ${valuePath} --json`
    );
    return { content: [{ type: 'text', text: output }] };
  }
);

server.tool(
  'babysitter_task_show',
  'Read the full task definition for an effect',
  { runDir: z.string(), effectId: z.string() },
  async ({ runDir, effectId }) => {
    const output = run(`${BABYSITTER_BIN} task:show ${runDir} ${effectId} --json`);
    return { content: [{ type: 'text', text: output }] };
  }
);

server.tool(
  'babysitter_run_status',
  'Read run status and completion proof',
  { runDir: z.string() },
  async ({ runDir }) => {
    const output = run(`${BABYSITTER_BIN} run:status ${runDir} --json`);
    return { content: [{ type: 'text', text: output }] };
  }
);

// --- Start ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('MCP server failed to start:', err);
  process.exit(1);
});
```

### Build and Install

```bash
# Navigate to the MCP server directory
cd ~/.gemini/extensions/babysitter/mcp-server

# Initialize the package and install dependencies
npm init -y
npm install @modelcontextprotocol/sdk zod

# Compile TypeScript
npx tsc babysitter-tools.ts --outDir . --module commonjs --target ES2022 \
  --esModuleInterop --moduleResolution node

# Verify the compiled output exists
ls -la babysitter-tools.js
```

### Register in `.gemini/settings.json`

Add the MCP server to your project or user settings:

```json
{
  "mcpServers": {
    "babysitter": {
      "command": "node",
      "args": ["~/.gemini/extensions/babysitter/mcp-server/babysitter-tools.js"],
      "timeout": 30000
    }
  }
}
```

### Verify MCP Server Registration

```bash
# Start Gemini CLI and check available tools
gemini --list-tools 2>/dev/null | grep babysitter

# Or check via the settings file
jq '.mcpServers.babysitter' .gemini/settings.json
```

### MCP Server Environment

The MCP server inherits the shell environment from Gemini CLI. If `babysitter`
is not on the PATH, set the `BABYSITTER_BIN` environment variable to the full
path in your settings:

```json
{
  "mcpServers": {
    "babysitter": {
      "command": "node",
      "args": ["~/.gemini/extensions/babysitter/mcp-server/babysitter-tools.js"],
      "timeout": 30000,
      "env": {
        "BABYSITTER_BIN": "/home/user/.local/bin/babysitter"
      }
    }
  }
}
```

---

## 9. Troubleshooting

### Diagnostic Commands

Use these commands to verify that hooks are correctly registered and functioning.

#### Check hook registration

```bash
# View all registered hooks in project settings
jq '.hooks' .gemini/settings.json

# View all registered hooks in user settings
jq '.hooks' ~/.gemini/settings.json

# Check extension-bundled hooks
jq '.hooks' ~/.gemini/extensions/babysitter/hooks/hooks.json 2>/dev/null || \
  echo "No extension-bundled hooks.json found"
```

#### Verify extension is installed

```bash
# Check the extension directory exists and has required files
ls -la ~/.gemini/extensions/babysitter/
ls -la ~/.gemini/extensions/babysitter/hooks/

# Verify the extension manifest
jq . ~/.gemini/extensions/babysitter/gemini-extension.json
```

#### Check hook scripts are executable

```bash
# All hook scripts must be executable
for f in ~/.gemini/extensions/babysitter/hooks/*.sh; do
  if [ -x "$f" ]; then
    echo "OK: $f"
  else
    echo "NOT EXECUTABLE: $f -- fix with: chmod +x $f"
  fi
done
```

#### Test hook scripts in isolation

```bash
# Test SessionStart hook
export GEMINI_SESSION_ID="diag-test-$(date +%s)"
echo '{}' | bash ~/.gemini/extensions/babysitter/hooks/session-start.sh
echo "Exit code: $?"

# Test AfterAgent hook
echo '{"last_assistant_message":"test"}' | \
  bash ~/.gemini/extensions/babysitter/hooks/after-agent.sh
echo "Exit code: $?"

# Test SessionEnd hook
echo '{}' | bash ~/.gemini/extensions/babysitter/hooks/session-end.sh
echo "Exit code: $?"
```

#### Inspect session state

```bash
# List all active session state files
ls -la ~/.gemini/extensions/babysitter/state/

# View a specific session state file
cat ~/.gemini/extensions/babysitter/state/${GEMINI_SESSION_ID}.md
```

#### Verify jq is available

The hook scripts require `jq` for JSON parsing. Verify it is installed:

```bash
jq --version || echo "jq not found -- install with: sudo apt install jq (or brew install jq)"
```

#### Check babysitter CLI and SDK version

```bash
babysitter version --json | jq .

# If babysitter is not on PATH, check common locations
ls -la "$HOME/.local/bin/babysitter" 2>/dev/null
which npx && npx -y @a5c-ai/babysitter-sdk babysitter version --json
```

#### Inspect run state for debugging

```bash
# List all runs
ls -la .a5c/runs/

# Check a specific run's metadata
jq . ".a5c/runs/${RUN_ID}/run.json"

# View the journal (event log)
ls .a5c/runs/${RUN_ID}/journal/
for f in .a5c/runs/${RUN_ID}/journal/*.json; do
  echo "--- $f ---"
  jq . "$f"
done

# Check pending tasks
babysitter task:list ".a5c/runs/${RUN_ID}" --pending --json | jq .
```

---

## Appendix A: Complete CLI Command Reference

| Command | Purpose | Section |
|---------|---------|---------|
| `babysitter version --json` | Verify CLI installation | 2 |
| `babysitter session:init --session-id ID --state-dir DIR --json` | Create baseline session state | 2 |
| `babysitter run:create --process-id PID --entry FILE --inputs FILE --json` | Create a new run | 3 |
| `babysitter session:associate --session-id ID --run-id RID --state-dir DIR --json` | Bind session to run | 3 |
| `babysitter run:iterate RUNDIR --json` | Advance orchestration, discover effects | 4, 5 |
| `babysitter run:status RUNDIR --json` | Read run status and completion proof | 4 |
| `babysitter task:list RUNDIR --pending --json` | List pending effects | 5 |
| `babysitter task:show RUNDIR EFFECTID --json` | Read task definition | 5 |
| `babysitter task:post RUNDIR EFFECTID --status STATUS --value FILE --json` | Post effect result | 5 |
| `babysitter session:check-iteration --session-id ID --state-dir DIR --json` | Check iteration guards | 6 |
| `babysitter hook:run --hook-type TYPE --harness NAME --json` | Dispatch a lifecycle hook | 4 |

### `babysitter hook:run` -- Detailed Reference

The `hook:run` command is the primary interface between harness hook scripts
and the babysitter SDK's decision logic. The AfterAgent hook script delegates
to this command to determine whether the orchestration loop should continue.

**Synopsis:**

```
echo '<JSON payload>' | babysitter hook:run \
  --hook-type <type> \
  --harness <name> \
  --plugin-root <dir> \
  --json
```

**Flags:**

| Flag | Required | Description |
|------|----------|-------------|
| `--hook-type <type>` | Yes | Hook type to execute. Values: `stop` (evaluate whether to continue the loop), `session-start` (initialize session), `session-end` (cleanup). |
| `--harness <name>` | Yes | Harness identifier. Values: `gemini-cli`, `claude-code`. Controls decision field naming (`deny` vs `block`). |
| `--plugin-root <dir>` | Yes | Absolute path to the extension directory (e.g., `~/.gemini/extensions/babysitter`). Used to locate the `state/` directory. |
| `--json` | No | Output structured JSON instead of human-readable text. |

**Stdin payload (JSON):**

```json
{
  "session_id": "gemini-abc123",
  "last_assistant_message": "I have completed the task. <promise>a1b2c3...</promise>"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `session_id` | string | The current session identifier. |
| `last_assistant_message` | string | The agent's most recent output. Scanned for `<promise>` tags during completion proof validation. |

**Output (JSON, `--hook-type stop`):**

When the decision is BLOCK (continue loop):

```json
{
  "decision": "block",
  "reason": "Run active, iteration 3/256",
  "systemMessage": "Babysitter iteration 3/256 [waiting]\n\nACTION REQUIRED: ..."
}
```

When the decision is APPROVE (allow exit):

```json
{
  "decision": "approve",
  "reason": "Run completed, proof validated"
}
```

The AfterAgent shell script translates `"block"` to `"deny"` for Gemini CLI
(see the [hook script in Section 4](#4-the-afteragent-hook----core-orchestration-loop)).

**Exit codes:**

| Code | Meaning |
|------|---------|
| 0 | Success. Parse stdout as JSON. |
| Non-zero | Error. The calling hook script should fail-safe (allow exit). |

## Appendix B: Gemini CLI vs Claude Code Hook Mapping

| Concept | Claude Code | Gemini CLI |
|---------|-------------|------------|
| Stop/exit interception | `Stop` hook | `AfterAgent` hook |
| Session start | `SessionStart` hook | `SessionStart` hook |
| Session end | (implicit) | `SessionEnd` hook |
| Block decision JSON | `{"decision":"block","reason":"..."}` | `{"decision":"deny","systemMessage":"..."}` |
| Allow decision JSON | `{}` | `{}` |
| Session ID env var | `CLAUDE_SESSION_ID` | `GEMINI_SESSION_ID` |
| Project dir env var | `CLAUDE_PLUGIN_ROOT` | `GEMINI_PROJECT_DIR` |
| Env file persistence | `CLAUDE_ENV_FILE` | Not available (use state files) |
| Context file | `CLAUDE.md` | `GEMINI.md` |
| Extension manifest | `plugin.json` | `gemini-extension.json` |
| Hook config location | `hooks.json` in plugin dir | `.gemini/settings.json` or `hooks/hooks.json` |
| MCP support | Via plugins | Native (`mcpServers` in settings) |
| Custom commands | Skills (SKILL.md) | Commands (TOML files) |
| Critical block | Exit code 1 | Exit code 2 |
| Debug output | stderr | stderr (stdout must be clean JSON) |
| Session resume | `--resume` flag | `gemini --resume` |
| Session storage | Plugin state dir | `~/.gemini/tmp/<hash>/chats/` |

## Appendix C: Harness Adapter Implementation

To add first-class Gemini CLI support in the babysitter SDK, implement the
`HarnessAdapter` interface:

```typescript
// packages/sdk/src/harness/geminiCli.ts
import { HarnessAdapter, SessionBindOptions, SessionBindResult, HookHandlerArgs } from './types';

export class GeminiCliAdapter implements HarnessAdapter {
  readonly name = 'gemini-cli';

  isActive(): boolean {
    return !!(process.env.GEMINI_SESSION_ID || process.env.GEMINI_PROJECT_DIR);
  }

  resolveSessionId(parsed: { sessionId?: string }): string | undefined {
    return parsed.sessionId || process.env.GEMINI_SESSION_ID;
  }

  resolveStateDir(args: { stateDir?: string; pluginRoot?: string }): string | undefined {
    if (args.stateDir) return args.stateDir;
    if (args.pluginRoot) return `${args.pluginRoot}/state`;
    const home = process.env.HOME || process.env.USERPROFILE;
    if (home) return `${home}/.gemini/extensions/babysitter/state`;
    return undefined;
  }

  resolvePluginRoot(args: { pluginRoot?: string }): string | undefined {
    if (args.pluginRoot) return args.pluginRoot;
    const home = process.env.HOME || process.env.USERPROFILE;
    if (home) return `${home}/.gemini/extensions/babysitter`;
    return undefined;
  }

  async bindSession(opts: SessionBindOptions): Promise<SessionBindResult> {
    // Same logic as Claude Code adapter: read/write session state file
    // with runId binding. See claudeCode.ts for reference.
    throw new Error('Not yet implemented -- use CLI commands externally');
  }

  async handleStopHook(args: HookHandlerArgs): Promise<number> {
    // Identical to Claude Code stop hook logic, but output uses
    // "deny" instead of "block" for the decision field.
    throw new Error('Not yet implemented -- use CLI commands externally');
  }

  async handleSessionStartHook(args: HookHandlerArgs): Promise<number> {
    // Same as Claude Code: create baseline state file.
    // No CLAUDE_ENV_FILE equivalent -- skip env file writes.
    throw new Error('Not yet implemented -- use CLI commands externally');
  }

  findHookDispatcherPath(startCwd: string): string | null {
    // Look for hook-dispatcher.sh relative to extension dir
    const home = process.env.HOME || process.env.USERPROFILE;
    if (!home) return null;
    const candidate = `${home}/.gemini/extensions/babysitter/hooks/hook-dispatcher.sh`;
    try {
      require('fs').accessSync(candidate);
      return candidate;
    } catch {
      return null;
    }
  }
}
```

Register in `packages/sdk/src/harness/registry.ts`:

```typescript
import { GeminiCliAdapter } from './geminiCli';

// Add to adapter list (after ClaudeCodeAdapter)
const adapters: HarnessAdapter[] = [
  new ClaudeCodeAdapter(),
  new GeminiCliAdapter(),
  new NullAdapter(),
];
```

---

## References

- [Gemini CLI Repository](https://github.com/google-gemini/gemini-cli)
- [Gemini CLI Hooks Documentation](https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/index.md)
- [Gemini CLI Extensions Documentation](https://github.com/google-gemini/gemini-cli/blob/main/docs/extensions/index.md)
- [Gemini CLI Configuration](https://github.com/google-gemini/gemini-cli/blob/main/docs/get-started/configuration.md)
- [Gemini CLI Writing Extensions](https://github.com/google-gemini/gemini-cli/blob/main/docs/extensions/writing-extensions.md)
- [Gemini CLI Session Management](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/session-management.md)
- [Ralph Extension (AfterAgent loop reference)](https://github.com/gemini-cli-extensions/ralph)
- [Hook Support in Extensions (Issue #14449)](https://github.com/google-gemini/gemini-cli/issues/14449)
- [Comprehensive Hooking System (Issue #9070)](https://github.com/google-gemini/gemini-cli/issues/9070)
- [Generic Harness Guide](../generic-harness-guide.md)
- [Claude Code Integration](../claude-code-integration.md)
