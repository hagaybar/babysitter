# Google Antigravity Harness Integration for Babysitter SDK

Technical reference for integrating the babysitter SDK orchestration loop with
[Google Antigravity](https://developers.google.com/antigravity), Google's agent-first IDE.
Covers the full lifecycle from skill registration, MCP server configuration, session
management, the orchestration loop via Workflows and lifecycle hooks, effect execution
through the multi-agent manager, and completion proof validation.

For the harness-agnostic guide, see [Generic Harness Guide](../generic-harness-guide.md).
For the canonical reference implementation, see [Claude Code Integration](../claude-code-integration.md).

---

## Glossary

| Term | Definition |
|------|-----------|
| **Effect** | A unit of work requested by a process function during orchestration. Effects have a `kind` (node, agent, breakpoint, sleep, orchestrator_task), an `effectId`, and a lifecycle: requested → pending → resolved. The process function calls `ctx.task()` to request an effect; the harness executes it externally and posts the result back via `task:post`. |
| **Completion Proof** | A SHA-256 hash (`sha256("{runId}:babysitter-completion-secret-v1")`) that the SDK emits only when a run genuinely completes. The agent must echo this value inside `<promise>` tags so the orchestration loop can verify the run finished before allowing the session to exit. |
| **Skill** | Antigravity's primary extensibility unit. A directory containing `SKILL.md` (metadata + instructions), optional `scripts/`, `references/`, and `assets/`. Loaded on-demand via semantic matching against user intent. |
| **Workflow** | Antigravity's user-triggered macros invoked via `/` commands. Orchestrate multiple skills into pipelines. |
| **Rule** | Always-on guardrails injected into Antigravity's system prompt. Enforce constraints like code standards, architectural patterns, or — in our case — orchestration discipline. |
| **MCP** | Model Context Protocol. Standardized protocol for connecting AI applications to external tools and data sources. Antigravity supports MCP via `mcp_config.json`. |
| **Harness** | The host environment that drives the babysitter orchestration loop. Antigravity is the harness in this document. |
| **Artifact** | Tangible deliverable produced by an Antigravity agent: task lists, plans, code diffs, screenshots, browser recordings. Supports Google Docs-style commenting for feedback loops. |

---

## Table of Contents

1. [Antigravity Overview](#1-antigravity-overview)
2. [Architecture Overview](#2-architecture-overview)
3. [Integration Approach](#3-integration-approach)
4. [Mapping Table](#4-mapping-table)
5. [Implementation Steps](#5-implementation-steps)
   - [5a. MCP Server Configuration](#5a-mcp-server-configuration)
   - [5b. Babysitter Orchestration Skill](#5b-babysitter-orchestration-skill)
   - [5c. Session Initialization](#5c-session-initialization)
   - [5d. Run Creation and Session Binding](#5d-run-creation-and-session-binding)
   - [5e. The Orchestration Loop Driver](#5e-the-orchestration-loop-driver)
   - [5f. Effect Execution](#5f-effect-execution)
   - [5g. Result Posting](#5g-result-posting)
   - [5h. Breakpoint Handling](#5h-breakpoint-handling)
   - [5i. Iteration Guards](#5i-iteration-guards)
6. [Complete Skill Structure](#6-complete-skill-structure)
7. [Complete MCP Server Config](#7-complete-mcp-server-config)
8. [Workflow Example](#8-workflow-example)
9. [Rule Definition](#9-rule-definition)
10. [Session State Management](#10-session-state-management)
11. [Hook Equivalence Table](#11-hook-equivalence-table)
12. [Antigravity-Specific Considerations](#12-antigravity-specific-considerations)
13. [Testing the Integration](#13-testing-the-integration)
14. [Limitations and Workarounds](#14-limitations-and-workarounds)
15. [Troubleshooting](#15-troubleshooting)

---

## 1. Antigravity Overview

Google Antigravity is an **agent-first IDE** — a fundamental departure from traditional
CLI-based AI coding assistants. Where tools like Claude Code, Gemini CLI, or Codex
operate as terminal programs with an agent loop, Antigravity provides a full graphical
development platform with three integrated surfaces:

1. **Editor View** — AI-powered code editor with tab completions and inline commands
2. **Agent Manager** — Asynchronous orchestration layer that spawns, monitors, and
   coordinates multiple agents working in parallel across different workspaces
3. **Browser** — Integrated headless Chrome instance for autonomous testing and verification

### Extensibility Architecture

Antigravity provides four extension mechanisms, layered from passive to active:

| Mechanism | Trigger | Scope | Persistence |
|-----------|---------|-------|-------------|
| **Rules** | Always-on (system prompt) | `.agents/` or `~/.gemini/` | Permanent per scope |
| **Skills** | On-demand (semantic matching) | `.agent/skills/` or `~/.gemini/antigravity/skills/` | Loaded when relevant |
| **Workflows** | User-invoked (`/command`) | `.agents/` or `~/.gemini/` | Explicit activation |
| **MCP Servers** | Tool calls | `mcp_config.json` or `mcp_servers.json` | Always available |

### Progressive Disclosure

Unlike CLI tools that load all instructions at session start (risking context pollution),
Antigravity uses **progressive disclosure**: skills are loaded on-demand based on semantic
understanding of the current task. This is critical for babysitter integration — the
orchestration skill only activates when the user initiates a babysitter-managed process.

### Multi-Model Support

Antigravity supports multiple LLM backends:
- Gemini 3 Pro (native, generous rate limits)
- Claude Sonnet (via Anthropic)
- OpenAI GPT models
- Open models: Llama, Grok, Qwen

The babysitter integration is model-agnostic — the orchestration skill works identically
regardless of which model powers the agent.

---

## 2. Architecture Overview

```
+-----------------------------------------------------------------------+
|                       Google Antigravity IDE                           |
|                                                                       |
|  +-------------------+  +-------------------+  +-------------------+  |
|  | Editor View       |  | Agent Manager     |  | Browser           |  |
|  | (AI editor)       |  | (multi-agent)     |  | (headless Chrome) |  |
|  +-------------------+  +-------------------+  +-------------------+  |
|           |                     |                       |             |
|  +-------------------------------------------------------------+     |
|  |                     Extension Layer                          |     |
|  |  +--------+  +--------+  +-----------+  +---------------+   |     |
|  |  | Rules  |  | Skills |  | Workflows |  | MCP Servers   |   |     |
|  |  +--------+  +--------+  +-----------+  +---------------+   |     |
|  +-------------------------------------------------------------+     |
+-----------------------------------------------------------------------+
         |                |                           |
         v                v                           v
+-------------------+  +----------------------------+  +------------------+
| Babysitter Skill  |  | Babysitter Orchestration   |  | Babysitter MCP   |
| .agent/skills/    |  | Rule                       |  | Server           |
| babysitter/       |  | .agents/babysitter-loop.md |  | (stdio transport)|
|                   |  +----------------------------+  |                  |
| SKILL.md          |              |                   | Tools:           |
| scripts/          |              v                   | - run:create     |
|   init.sh         |  +----------------------------+  | - run:iterate    |
|   iterate.sh      |  | Session State              |  | - run:status     |
|   check-status.sh |  | .agent/skills/babysitter/  |  | - task:list      |
+-------------------+  | state/{sessionId}.md       |  | - task:post      |
         |              +----------------------------+  | - session:*      |
         v                         |                   +------------------+
+-------------------------------------------------------------------+
|                        babysitter CLI                              |
|                   (@a5c-ai/babysitter-sdk)                        |
+-------------------------------------------------------------------+
         |
         v
+-------------------------------------------------------------------+
|                     .a5c/runs/{runId}/                             |
|  run.json | journal/ | tasks/ | state/ | blobs/                   |
+-------------------------------------------------------------------+
```

### Data Flow

```
User activates /babysit workflow
        │
        ▼
┌─────────────────────┐
│ Babysitter Skill    │ ◄── Loaded via progressive disclosure
│ (SKILL.md)          │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐     ┌─────────────────────┐
│ MCP: run:create     │────▶│ .a5c/runs/{runId}/   │
│ MCP: session:init   │     │ run.json created     │
└─────────┬───────────┘     └─────────────────────┘
          │
          ▼
┌─────────────────────┐
│ ORCHESTRATION LOOP  │ ◄── Driven by skill instructions + rule enforcement
│                     │
│ 1. MCP: run:iterate │
│ 2. MCP: task:list   │
│ 3. Execute effects  │ ──▶ Agent Manager dispatches sub-agents
│ 4. MCP: task:post   │
│ 5. Repeat           │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ Completion check    │
│ run:status shows    │
│ status: completed   │
│ + completionSecret  │
└─────────────────────┘
```

---

## 3. Integration Approach

Antigravity's integration uses a **three-layer strategy**:

### Layer 1: MCP Server (Tool Access)

An MCP server wrapping the babysitter CLI provides tool-level access to all SDK
commands. This is the foundation — without it, the agent cannot interact with the
babysitter SDK programmatically.

### Layer 2: Skill (Orchestration Intelligence)

A babysitter skill provides the instructions, context, and scripts needed to drive
the orchestration loop. The skill teaches the agent *how* to use the MCP tools in
the correct sequence.

### Layer 3: Rule (Loop Discipline)

A babysitter rule enforces orchestration discipline: the agent must not abandon the
loop prematurely, must check for completion proof, and must follow the iterate →
execute → post → repeat cycle.

### Optional Layer: Workflow (User Entry Point)

A `/babysit` workflow provides a clean user-facing entry point that initializes the
session, creates the run, and triggers the orchestration skill.

### Why This Differs from CLI Harnesses

CLI harnesses (Claude Code, Gemini CLI, Codex) rely on **exit interception** — a
stop hook that fires when the agent tries to end its turn. Antigravity operates
differently:

| CLI Harness Pattern | Antigravity Pattern |
|---------------------|---------------------|
| Agent tries to exit → stop hook fires → blocks exit → re-injects context | Agent follows skill instructions → continues loop voluntarily → rule enforces discipline |
| Loop driven by hook system (external) | Loop driven by skill + rule (internal to agent) |
| Session state checked by hook script | Session state checked by agent via MCP tools |
| Completion proof scanned from transcript | Completion proof verified by agent from run:status |

In Antigravity, the agent is the loop driver rather than being forced by hooks.
The skill provides instructions; the rule prevents premature exit; MCP tools
provide the mechanism.

---

## 4. Mapping Table

| Generic Requirement | Antigravity Mechanism | Implementation |
|---------------------|----------------------|----------------|
| **SDK Installation** | Skill `scripts/install.sh` | `npm i -g @a5c-ai/babysitter-sdk@latest` executed during skill activation |
| **Session Initialization** | Skill activation + MCP `session:init` | Skill instructs agent to call `babysitter session:init` via MCP |
| **Run Creation** | MCP tool `run:create` | Agent calls MCP tool with process-id, entry, inputs |
| **Session Binding** | MCP tool `session:associate` | Agent calls MCP tool with run-id and session-id |
| **Orchestration Loop** | Skill instructions + Rule enforcement | Agent follows iterate→execute→post→repeat cycle from SKILL.md |
| **Exit Interception** | Rule (always-on constraint) | Rule prevents agent from declaring "done" without completion proof |
| **Context Re-injection** | Not needed | Agent maintains loop voluntarily; no exit to intercept |
| **Effect Execution** | Agent Manager (multi-agent dispatch) | For `kind: agent` effects, spawn sub-agents via multi-agent manager |
| **Shell Effects** | Terminal execution | For `kind: shell` or `kind: node` effects, execute via terminal |
| **Result Posting** | MCP tool `task:post` | Agent calls MCP tool with effectId, status, value file |
| **Breakpoints** | Artifact system + user feedback | Create artifact with question; wait for user comment/approval |
| **Iteration Guards** | Skill script `check-status.sh` | Check iteration count and timing; warn or abort if runaway detected |
| **Completion Proof** | MCP `run:status` → `completionSecret` | Agent reads secret from status, echoes in `<promise>` tags |
| **Transcript Access** | Agent's own output | Agent can read its own prior responses |
| **Session Persistence** | Skill state directory | `.agent/skills/babysitter/state/{sessionId}.md` |

---

## 5. Implementation Steps

### 5a. MCP Server Configuration

Create or update the MCP configuration to expose babysitter CLI as tools.

**File: `~/.gemini/antigravity/mcp_config.json`** (global) or **`.gemini/mcp_servers.json`** (workspace)

```json
{
  "mcpServers": {
    "babysitter": {
      "transport": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "@a5c-ai/babysitter-sdk@latest",
        "mcp-server"
      ],
      "enabled": true,
      "env": {
        "BABYSITTER_RUNS_DIR": ".a5c/runs",
        "BABYSITTER_MAX_ITERATIONS": "256",
        "BABYSITTER_LOG_LEVEL": "info"
      }
    }
  }
}
```

If the SDK does not ship a built-in MCP server, use a shell-based wrapper:

```json
{
  "mcpServers": {
    "babysitter": {
      "transport": "stdio",
      "command": "node",
      "args": [".agent/skills/babysitter/scripts/mcp-server.js"],
      "enabled": true
    }
  }
}
```

The wrapper script (Section 7) translates MCP tool calls to babysitter CLI invocations.

### 5b. Babysitter Orchestration Skill

Create the skill directory:

```
.agent/skills/babysitter/
├── SKILL.md                    # Orchestration instructions
├── scripts/
│   ├── install.sh              # Install/verify babysitter SDK
│   ├── init-session.sh         # Initialize session state
│   ├── iterate.sh              # Run one orchestration iteration
│   ├── check-status.sh         # Check run status and iteration guards
│   └── mcp-server.js           # MCP server wrapper (if needed)
├── references/
│   ├── generic-harness-guide.md  # Link to generic guide
│   └── cli-reference.md         # Quick CLI command reference
└── state/                       # Session state files (gitignored)
    └── {sessionId}.md
```

The complete SKILL.md is provided in Section 6.

### 5c. Session Initialization

When the babysitter skill activates, the agent must initialize a session. This happens
automatically via the skill's instructions.

**Script: `scripts/install.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

# Check if babysitter CLI is available
if ! command -v babysitter &>/dev/null; then
  echo "Installing babysitter SDK..."
  npm i -g @a5c-ai/babysitter-sdk@latest @a5c-ai/babysitter@latest
fi

# Verify installation
babysitter version --json
```

**Script: `scripts/init-session.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

SESSION_ID="${1:?Session ID required}"
SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="${SKILL_DIR}/state"

mkdir -p "${STATE_DIR}"

# Initialize session via SDK CLI
babysitter session:init \
  --session-id "${SESSION_ID}" \
  --state-dir "${STATE_DIR}" \
  --json

echo "Session initialized: ${STATE_DIR}/${SESSION_ID}.md"
```

### 5d. Run Creation and Session Binding

The agent creates a run and binds it to the session using MCP tools or shell scripts.

**Via MCP tool calls** (preferred):

```
Agent: I'll create a babysitter run for this process.
→ MCP call: babysitter.run_create({
    processId: "my-process",
    entry: ".a5c/processes/my-process.js",
    inputs: ".a5c/processes/my-process-inputs.json"
  })
← Response: { runId: "01KJQA...", runDir: ".a5c/runs/01KJQA..." }

Agent: Now I'll bind this run to our session.
→ MCP call: babysitter.session_associate({
    runId: "01KJQA...",
    sessionId: "<current-session-id>"
  })
← Response: { success: true }
```

**Via shell script** (fallback):

```bash
#!/usr/bin/env bash
# scripts/create-run.sh
set -euo pipefail

PROCESS_ID="${1:?Process ID required}"
ENTRY="${2:?Entry path required}"
INPUTS="${3:?Inputs path required}"
SESSION_ID="${4:?Session ID required}"

# Create the run
RUN_OUTPUT=$(babysitter run:create \
  --process-id "${PROCESS_ID}" \
  --entry "${ENTRY}" \
  --inputs "${INPUTS}" \
  --json)

RUN_ID=$(echo "${RUN_OUTPUT}" | jq -r '.runId')

# Bind session to run
babysitter session:associate \
  --run-id "${RUN_ID}" \
  --session-id "${SESSION_ID}" \
  --json

echo "${RUN_OUTPUT}"
```

### 5e. The Orchestration Loop Driver

This is the critical integration point. In Antigravity, the loop is **agent-driven**
rather than hook-driven.

**How it works:**

1. The babysitter skill instructs the agent to follow the iterate → execute → post cycle
2. The babysitter rule prevents the agent from declaring "done" prematurely
3. The agent checks `run:status` and `run:iterate` output to decide whether to continue

**Script: `scripts/iterate.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

RUN_ID="${1:?Run ID required}"
ITERATION="${2:?Iteration number required}"

# Run one iteration
RESULT=$(babysitter run:iterate "${RUN_ID}" --json --iteration "${ITERATION}")

STATUS=$(echo "${RESULT}" | jq -r '.status')
ACTION=$(echo "${RESULT}" | jq -r '.action')

echo "${RESULT}"

# Return exit codes for the agent to interpret
case "${STATUS}" in
  executed)  exit 0 ;;  # Continue looping
  waiting)   exit 0 ;;  # Effects pending, execute them
  completed) exit 0 ;;  # Run finished
  failed)    exit 1 ;;  # Run failed
  none)      exit 0 ;;  # Nothing to do
  *)         exit 2 ;;  # Unknown status
esac
```

**The agent's loop logic** (driven by SKILL.md instructions):

```
REPEAT:
  1. Call run:iterate with current iteration number
  2. Parse the response:
     - If status == "completed": read completionSecret, emit <promise>SECRET</promise>, EXIT
     - If status == "failed": report error, EXIT
     - If status == "waiting" or "executed":
       a. Call task:list --pending to get requested effects
       b. For each effect:
          - If kind == "agent": dispatch sub-agent via Agent Manager
          - If kind == "node" or "shell": execute via terminal
          - If kind == "breakpoint": create artifact, wait for user feedback
          - If kind == "sleep": wait for specified duration
       c. Post each result via task:post
     - If status == "none": call run:iterate again (process may need another step)
  3. Increment iteration counter
  4. Check iteration guards (max iterations, runaway detection)
  5. GOTO REPEAT
```

### 5f. Effect Execution

Antigravity's multi-agent manager provides natural support for parallel effect execution.

**For `kind: agent` effects:**

The agent dispatches sub-agents via Antigravity's Agent Manager. Each sub-agent works
in its own workspace/context.

```
Agent: I have 3 agent effects to execute in parallel. Let me dispatch them.

Sub-agent 1: Working on effect-abc123 (code review)
Sub-agent 2: Working on effect-def456 (test generation)
Sub-agent 3: Working on effect-ghi789 (documentation)
```

Each sub-agent:
1. Reads the task definition from `tasks/{effectId}/task.json`
2. Follows the prompt instructions
3. Writes its output to `tasks/{effectId}/output.json`
4. The orchestrating agent then calls `task:post` for each

**For `kind: node` or `kind: shell` effects:**

Execute directly via terminal:

```bash
# Read the task definition
TASK_DEF=$(cat .a5c/runs/${RUN_ID}/tasks/${EFFECT_ID}/task.json)

# Extract the script/command
SCRIPT=$(echo "${TASK_DEF}" | jq -r '.node.script // .shell.command')

# Execute
eval "${SCRIPT}" > .a5c/runs/${RUN_ID}/tasks/${EFFECT_ID}/stdout.txt \
                  2> .a5c/runs/${RUN_ID}/tasks/${EFFECT_ID}/stderr.txt
EXIT_CODE=$?

# Write output
if [ ${EXIT_CODE} -eq 0 ]; then
  echo '{"success": true}' > .a5c/runs/${RUN_ID}/tasks/${EFFECT_ID}/output.json
else
  echo "{\"success\": false, \"exitCode\": ${EXIT_CODE}}" > \
    .a5c/runs/${RUN_ID}/tasks/${EFFECT_ID}/output.json
fi
```

**For `kind: breakpoint` effects:**

See Section 5h.

### 5g. Result Posting

After executing each effect, post the result back to the SDK:

**Via MCP tool** (preferred):

```
→ MCP call: babysitter.task_post({
    runId: "01KJQA...",
    effectId: "effect-abc123",
    status: "ok",
    value: "tasks/effect-abc123/output.json"
  })
← Response: { success: true, event: "EFFECT_RESOLVED" }
```

**Via shell script:**

```bash
#!/usr/bin/env bash
set -euo pipefail

RUN_ID="${1:?Run ID required}"
EFFECT_ID="${2:?Effect ID required}"
STATUS="${3:-ok}"
VALUE_FILE="${4:-tasks/${EFFECT_ID}/output.json}"

babysitter task:post "${RUN_ID}" "${EFFECT_ID}" \
  --status "${STATUS}" \
  --value "${VALUE_FILE}" \
  --json
```

**Important**: Never write `result.json` directly. The SDK owns that file. Always write
your output to a separate file (e.g., `output.json`) and let `task:post` create the
proper `result.json` with schema version, metadata, and your value.

### 5h. Breakpoint Handling

Antigravity's artifact system provides a natural mechanism for breakpoints.

**When a breakpoint effect is encountered:**

1. The agent creates an artifact containing:
   - The breakpoint question/title
   - Context files (referenced in the breakpoint definition)
   - Current progress summary

2. The user reviews the artifact and provides feedback via comments

3. The agent reads the user's response and posts it as the breakpoint result

```
Agent: This process requires human approval. I'll create a review artifact.

[Creates artifact: "Phase 1 Review - Architecture Approval"]
  - Question: "Does the proposed architecture meet your requirements?"
  - Attached files: architecture-diagram.md, component-list.md
  - Current status: Phase 1 complete, 3 components implemented

User: [Comments on artifact] "Looks good, but add error handling to the API layer"

Agent: Got the feedback. Let me post this as the breakpoint result.
→ MCP call: babysitter.task_post({
    runId: "01KJQA...",
    effectId: "breakpoint-xyz",
    status: "ok",
    value: "tasks/breakpoint-xyz/output.json"
  })
  // output.json contains: {"approved": true, "feedback": "Add error handling to API layer"}
```

### 5i. Iteration Guards

Prevent runaway loops by checking iteration count and timing.

**Script: `scripts/check-status.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

SESSION_ID="${1:?Session ID required}"
SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STATE_FILE="${SKILL_DIR}/state/${SESSION_ID}.md"

if [ ! -f "${STATE_FILE}" ]; then
  echo '{"status": "no-session", "action": "abort"}'
  exit 1
fi

# Read YAML frontmatter fields
ITERATION=$(sed -n 's/^iteration: *//p' "${STATE_FILE}" | head -1)
MAX_ITERATIONS=$(sed -n 's/^max_iterations: *//p' "${STATE_FILE}" | head -1)

# Check max iterations
if [ "${ITERATION}" -ge "${MAX_ITERATIONS}" ]; then
  echo "{\"status\": \"max-iterations-reached\", \"iteration\": ${ITERATION}, \"max\": ${MAX_ITERATIONS}, \"action\": \"abort\"}"
  exit 1
fi

# Check for runaway (average of last 3 iterations <= 15 seconds)
babysitter session:check-iteration \
  --session-id "${SESSION_ID}" \
  --state-dir "${SKILL_DIR}/state" \
  --json
```

---

## 6. Complete Skill Structure

### SKILL.md

```yaml
---
name: babysitter-orchestrator
description: Orchestrate babysitter SDK runs with iterative quality convergence. Manages the full lifecycle from run creation through effect execution to completion proof validation.
---

# Babysitter Orchestration Skill

## Goal

Drive a babysitter SDK orchestration run to completion. This skill manages the
iterate → execute → post → repeat cycle until the run produces a completion proof.

## Prerequisites

- babysitter SDK installed (`npm i -g @a5c-ai/babysitter-sdk@latest`)
- MCP server "babysitter" configured and enabled
- A process definition file (`.a5c/processes/*.js`) with matching inputs JSON

## Instructions

### Phase 1: Initialize

1. Verify SDK installation: run `scripts/install.sh`
2. Determine or generate a session ID for this conversation
3. Initialize session state: run `scripts/init-session.sh <sessionId>`
4. Create the babysitter run:
   ```
   babysitter run:create --process-id <id> --entry <path> --inputs <path> --json
   ```
5. Associate session with run:
   ```
   babysitter session:associate --run-id <runId> --session-id <sessionId>
   ```

### Phase 2: Orchestration Loop

Repeat the following cycle:

1. **Iterate**: Call `babysitter run:iterate <runId> --json --iteration <n>`
2. **Check status**:
   - `completed` → Read `completionSecret` from response, emit `<promise>SECRET</promise>`, STOP
   - `failed` → Report error details, STOP
   - `waiting` or `executed` → Continue to step 3
   - `none` → Call iterate again
3. **List pending tasks**: Call `babysitter task:list <runId> --pending --json`
4. **Execute each effect**:
   - `kind: agent` → Dispatch sub-agent with the prompt from task definition
   - `kind: node` or `kind: shell` → Execute script/command via terminal
   - `kind: breakpoint` → Create artifact for user review, wait for feedback
   - `kind: sleep` → Wait for specified duration
5. **Post results**: For each executed effect:
   - Write output to `tasks/<effectId>/output.json`
   - Call `babysitter task:post <runId> <effectId> --status ok --value tasks/<effectId>/output.json --json`
6. **Check guards**: Run `scripts/check-status.sh <sessionId>` to verify iteration limits
7. **Increment** iteration counter and repeat from step 1

### Phase 3: Completion

When `run:iterate` returns `status: completed`:
1. Read `completionSecret` from the response
2. Emit `<promise>COMPLETION_SECRET_VALUE</promise>` in your response
3. Report final results to the user

## Constraints

- NEVER skip the orchestration loop. Every iteration must go through run:iterate.
- NEVER write result.json directly. Always use task:post.
- NEVER declare the run complete without a valid completionSecret.
- NEVER abandon the loop because a single effect fails. Post error status and continue.
- Always check iteration guards before each cycle.
- Always post results for ALL pending effects before calling run:iterate again.

## Examples

### Example: Starting a TDD run

```
User: Run the TDD quality convergence process for the auth module

Agent: I'll set up a babysitter run for TDD quality convergence.

1. Creating run...
   → babysitter run:create --process-id tdd-quality-convergence \
       --entry .a5c/processes/tdd-quality-convergence.js \
       --inputs .a5c/processes/tdd-inputs.json --json
   ← { runId: "01KJR...", runDir: ".a5c/runs/01KJR..." }

2. Running iteration 1...
   → babysitter run:iterate 01KJR... --json --iteration 1
   ← { status: "waiting", nextActions: [{ kind: "agent", label: "Write tests" }] }

3. Executing effect: Write tests
   [Dispatches sub-agent to write tests]
   → babysitter task:post 01KJR... effect-abc --status ok --value tasks/effect-abc/output.json

4. Running iteration 2...
   [Continues until completion]
```
```

### scripts/ directory

Each script is documented in Section 5.

### references/cli-reference.md

```markdown
# Babysitter CLI Quick Reference

## Run Management
| Command | Description |
|---------|-------------|
| `babysitter run:create --process-id <id> --entry <path> --inputs <path> --json` | Create new run |
| `babysitter run:iterate <runId> --json --iteration <n>` | Execute one iteration |
| `babysitter run:status <runId> --json` | Check run status |
| `babysitter run:events <runId> --limit 20 --reverse` | View recent events |

## Task Management
| Command | Description |
|---------|-------------|
| `babysitter task:list <runId> --pending --json` | List pending tasks |
| `babysitter task:post <runId> <effectId> --status <ok\|error> --value <file> --json` | Post task result |
| `babysitter task:show <runId> <effectId> --json` | Show task details |

## Session Management
| Command | Description |
|---------|-------------|
| `babysitter session:init --session-id <id> --state-dir <dir> --json` | Initialize session |
| `babysitter session:associate --run-id <id> --session-id <id> --json` | Bind session to run |
| `babysitter session:check-iteration --session-id <id> --state-dir <dir> --json` | Check iteration guards |
```

---

## 7. Complete MCP Server Config

If the babysitter SDK does not ship a built-in MCP server, create a wrapper:

**File: `scripts/mcp-server.js`**

```javascript
#!/usr/bin/env node

/**
 * Babysitter MCP Server
 * Wraps babysitter CLI commands as MCP tools.
 * Transport: stdio
 */

import { execSync } from 'child_process';
import { createInterface } from 'readline';

const CLI = 'npx -y @a5c-ai/babysitter-sdk@latest';

const tools = {
  'run_create': {
    description: 'Create a new babysitter run',
    inputSchema: {
      type: 'object',
      properties: {
        processId: { type: 'string', description: 'Process identifier' },
        entry: { type: 'string', description: 'Entry point path (file.js#export)' },
        inputs: { type: 'string', description: 'Path to inputs JSON file' },
        runId: { type: 'string', description: 'Optional custom run ID' }
      },
      required: ['processId', 'entry', 'inputs']
    },
    handler: (args) => {
      let cmd = `${CLI} run:create --process-id ${args.processId} --entry ${args.entry} --inputs ${args.inputs} --json`;
      if (args.runId) cmd += ` --run-id ${args.runId}`;
      return JSON.parse(execSync(cmd, { encoding: 'utf-8' }));
    }
  },

  'run_iterate': {
    description: 'Execute one orchestration iteration',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'Run ID' },
        iteration: { type: 'number', description: 'Iteration number' }
      },
      required: ['runId', 'iteration']
    },
    handler: (args) => {
      const cmd = `${CLI} run:iterate ${args.runId} --json --iteration ${args.iteration}`;
      return JSON.parse(execSync(cmd, { encoding: 'utf-8' }));
    }
  },

  'run_status': {
    description: 'Check run status',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string' } },
      required: ['runId']
    },
    handler: (args) => {
      return JSON.parse(execSync(`${CLI} run:status ${args.runId} --json`, { encoding: 'utf-8' }));
    }
  },

  'task_list': {
    description: 'List pending tasks for a run',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string' },
        pending: { type: 'boolean', default: true }
      },
      required: ['runId']
    },
    handler: (args) => {
      let cmd = `${CLI} task:list ${args.runId} --json`;
      if (args.pending !== false) cmd += ' --pending';
      return JSON.parse(execSync(cmd, { encoding: 'utf-8' }));
    }
  },

  'task_post': {
    description: 'Post a task result',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string' },
        effectId: { type: 'string' },
        status: { type: 'string', enum: ['ok', 'error'] },
        value: { type: 'string', description: 'Path to value JSON file' },
        error: { type: 'string', description: 'Path to error JSON file' }
      },
      required: ['runId', 'effectId', 'status']
    },
    handler: (args) => {
      let cmd = `${CLI} task:post ${args.runId} ${args.effectId} --status ${args.status} --json`;
      if (args.value) cmd += ` --value ${args.value}`;
      if (args.error) cmd += ` --error ${args.error}`;
      return JSON.parse(execSync(cmd, { encoding: 'utf-8' }));
    }
  },

  'session_init': {
    description: 'Initialize a babysitter session',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        stateDir: { type: 'string' }
      },
      required: ['sessionId', 'stateDir']
    },
    handler: (args) => {
      return JSON.parse(execSync(
        `${CLI} session:init --session-id ${args.sessionId} --state-dir ${args.stateDir} --json`,
        { encoding: 'utf-8' }
      ));
    }
  },

  'session_associate': {
    description: 'Associate a session with a run',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string' },
        sessionId: { type: 'string' }
      },
      required: ['runId', 'sessionId']
    },
    handler: (args) => {
      return JSON.parse(execSync(
        `${CLI} session:associate --run-id ${args.runId} --session-id ${args.sessionId} --json`,
        { encoding: 'utf-8' }
      ));
    }
  }
};

// MCP stdio protocol handler
const rl = createInterface({ input: process.stdin });

function respond(id, result) {
  const response = JSON.stringify({ jsonrpc: '2.0', id, result });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(response)}\r\n\r\n${response}`);
}

function respondError(id, code, message) {
  const response = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(response)}\r\n\r\n${response}`);
}

let buffer = '';

rl.on('line', (line) => {
  buffer += line;
  try {
    const request = JSON.parse(buffer);
    buffer = '';

    if (request.method === 'tools/list') {
      respond(request.id, {
        tools: Object.entries(tools).map(([name, def]) => ({
          name,
          description: def.description,
          inputSchema: def.inputSchema
        }))
      });
    } else if (request.method === 'tools/call') {
      const tool = tools[request.params.name];
      if (!tool) {
        respondError(request.id, -32601, `Unknown tool: ${request.params.name}`);
        return;
      }
      try {
        const result = tool.handler(request.params.arguments || {});
        respond(request.id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
      } catch (err) {
        respond(request.id, { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true });
      }
    } else if (request.method === 'initialize') {
      respond(request.id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'babysitter-mcp', version: '1.0.0' }
      });
    }
  } catch {
    // Incomplete JSON, wait for more data
  }
});
```

---

## 8. Workflow Example

Create a workflow that provides a clean `/babysit` entry point:

**File: `~/.gemini/workflows/babysit.md`** or **`.agents/workflows/babysit.md`**

```markdown
---
name: babysit
description: Start a babysitter-managed orchestration run
---

# /babysit Workflow

## Steps

1. **Verify Prerequisites**
   - Check that the babysitter MCP server is configured and responding
   - Verify that `@a5c-ai/babysitter-sdk` is installed
   - Confirm `.a5c/` directory exists in the project

2. **Identify Process**
   - Ask the user which process to run, or detect from context
   - Locate the process definition in `.a5c/processes/` or the skill library
   - Verify the inputs file exists

3. **Activate Babysitter Skill**
   - Load the `babysitter-orchestrator` skill
   - Follow its initialization instructions

4. **Monitor and Report**
   - Display iteration progress as the skill drives the loop
   - Surface breakpoint artifacts for user review
   - Report completion with final results
```

**Usage:**

```
User: /babysit tdd-quality-convergence for the auth module
→ Workflow activates
→ Loads babysitter-orchestrator skill
→ Creates run with tdd-quality-convergence process
→ Drives orchestration loop to completion
```

---

## 9. Rule Definition

Create a rule that enforces orchestration discipline:

**File: `.agents/babysitter-loop.md`** or **`~/.gemini/rules/babysitter-loop.md`**

```markdown
---
name: babysitter-loop-discipline
description: Enforce babysitter orchestration loop discipline when a run is active
---

# Babysitter Loop Discipline Rule

When a babysitter orchestration run is active (you have called `run:create` and
received a runId), you MUST follow these rules:

## Required Behavior

1. **Never abandon the loop.** Once a run is created, you must continue the
   iterate → execute → post → repeat cycle until:
   - `run:iterate` returns `status: completed` with a `completionSecret`, OR
   - `run:iterate` returns `status: failed`, OR
   - The iteration guard triggers (max iterations reached)

2. **Never declare success without proof.** You may only state that a run is
   complete if you have received a `completionSecret` from `run:iterate` or
   `run:status` and have emitted it in `<promise>` tags.

3. **Always post results.** Every pending effect must have its result posted
   via `task:post` before calling `run:iterate` again.

4. **Never write result.json directly.** Use `task:post` which manages the
   file format, schema versioning, and journal events.

5. **Check iteration guards.** Before each iteration, verify you haven't
   exceeded `max_iterations` (default: 256).

## When This Rule Applies

This rule is active whenever:
- You have a `runId` from a babysitter `run:create` call
- The run status is not `completed` or `failed`
- The babysitter-orchestrator skill is loaded
```

---

## 10. Session State Management

### State File Location

```
.agent/skills/babysitter/state/{sessionId}.md
```

### State File Format

```yaml
---
active: true
iteration: 1
max_iterations: 256
run_id: ""
started_at: "2026-03-02T10:00:00Z"
last_iteration_at: "2026-03-02T10:00:00Z"
iteration_times: []
---
```

### Field Semantics

| Field | Type | Created By | Updated By |
|-------|------|-----------|-----------|
| `active` | boolean | `session:init` | Agent (set `false` on completion/abort) |
| `iteration` | integer | `session:init` (value: 1) | Agent (incremented each cycle) |
| `max_iterations` | integer | `session:init` (default: 256) | Not updated |
| `run_id` | string | `session:init` (value: `""`) | `session:associate` (set to ULID) |
| `started_at` | ISO-8601 | `session:init` | Not updated |
| `last_iteration_at` | ISO-8601 | `session:init` | Agent (each iteration) |
| `iteration_times` | number[] | `session:init` (value: `[]`) | Agent (appended each iteration) |

### Session ID Strategy

Antigravity manages sessions internally. Options for session ID:

1. **Workspace hash**: Use a hash of the project directory path
2. **Timestamp-based**: Generate a ULID at skill activation time
3. **Agent-managed**: Let the agent generate and track the ID

Recommended: Use a ULID generated at skill activation, stored in the skill's
working memory for the duration of the conversation.

---

## 11. Hook Equivalence Table

| Babysitter Hook | Claude Code | Gemini CLI | Antigravity |
|-----------------|-------------|------------|-------------|
| `session-start` | SessionStart plugin hook | SessionStart extension hook | Skill activation (on-demand) |
| `stop` (exit interception) | Stop plugin hook (blocks exit) | AfterAgent hook (exit code 2 blocks) | Rule enforcement (agent follows loop voluntarily) |
| `on-iteration-start` | on-iteration-start/ hook directory | BeforeAgent hook | Skill instruction: "Before each iteration..." |
| `on-iteration-end` | on-iteration-end/ hook directory | AfterModel hook | Skill instruction: "After each iteration..." |
| `on-run-start` | SDK internal | SDK internal | SDK internal (via run:create) |
| `on-run-complete` | SDK internal + stop hook approve | SDK internal + AfterAgent approve | SDK internal (agent reads completionSecret) |
| `on-run-fail` | SDK internal | SDK internal | SDK internal (agent reads error) |
| `on-task-start` | SDK internal | SDK internal | SDK internal |
| `on-task-complete` | SDK internal | SDK internal | SDK internal |
| `on-breakpoint` | Stop hook pauses for user | AfterAgent pauses | Artifact system (user comments) |
| `on-score` | SDK internal | SDK internal | SDK internal |
| `pre-commit` | SDK hook | SDK hook | SDK hook |
| `pre-branch` | SDK hook | SDK hook | SDK hook |

### Key Difference

In CLI harnesses, the **host** drives the loop via hooks (external control).
In Antigravity, the **agent** drives the loop via skill instructions (internal control).
The babysitter Rule provides a safety net to prevent the agent from abandoning the loop.

---

## 12. Antigravity-Specific Considerations

### Progressive Disclosure Benefits

The babysitter orchestration skill only loads when relevant, preventing context
pollution during normal coding tasks. This means:

- No overhead when the user isn't running babysitter processes
- Full orchestration context when the skill activates
- Other skills can coexist without interference

### Multi-Agent Parallel Execution

Antigravity's Agent Manager natively supports spawning multiple agents:

```
Orchestrating agent: I have 4 parallel effects to execute.
→ Dispatches Agent 1: Code review of module A
→ Dispatches Agent 2: Test generation for module B
→ Dispatches Agent 3: Documentation update
→ Dispatches Agent 4: Lint and format check

[All 4 agents work simultaneously in separate workspaces]

Agent 1 completes → Post result via task:post
Agent 2 completes → Post result via task:post
Agent 3 completes → Post result via task:post
Agent 4 completes → Post result via task:post

Orchestrating agent: All effects resolved. Running next iteration.
```

This maps directly to `ctx.parallel.all()` in babysitter process definitions.

### Artifact-Based Review

The artifact system provides a richer breakpoint experience than CLI harnesses:

| Feature | CLI Breakpoint | Antigravity Artifact |
|---------|---------------|---------------------|
| Question display | Terminal text | Rich formatted card |
| Context files | File paths in JSON | Attached files with preview |
| User response | Text input | Google Docs-style comments |
| Visual review | Not supported | Screenshots, browser recordings |
| Collaboration | Single user | Shareable artifacts |

### Browser Integration for Quality Gates

Antigravity's integrated headless Chrome enables quality gates that execute
browser-based tests:

```
Quality gate agent:
1. Start dev server (terminal)
2. Navigate to http://localhost:3000 (browser)
3. Run visual regression test (screenshot + compare)
4. Check accessibility (axe-core via browser)
5. Report scores as effect result
```

This enables closing the widest quality loop (e2e with real browser) directly
within the orchestration process.

### Model-Agnostic Execution

Since the babysitter SDK is model-agnostic and Antigravity supports multiple
models, the same process can run with:
- Gemini 3 Pro for high-throughput tasks
- Claude Sonnet for nuanced analysis
- GPT for specific strengths

The orchestrating agent can even delegate different effects to different models
based on the task characteristics.

---

## 13. Testing the Integration

### Smoke Test Checklist

- [ ] MCP server responds to `tools/list`
- [ ] `babysitter version --json` returns valid version
- [ ] `babysitter run:create` with a simple process succeeds
- [ ] `babysitter run:iterate` returns valid status JSON
- [ ] `babysitter task:list --pending` returns task array
- [ ] `babysitter task:post` with mock result succeeds
- [ ] Skill loads when user mentions "babysitter" or "orchestration"
- [ ] Rule activates when run is created
- [ ] Workflow `/babysit` triggers skill loading

### Integration Test

Create a minimal test process:

**File: `.a5c/processes/smoke-test.js`**

```javascript
import { defineTask } from '@a5c-ai/babysitter-sdk';

const echoTask = defineTask('echo', (args, taskCtx) => ({
  kind: 'agent',
  title: 'Echo test',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Test agent',
      task: `Echo back: ${args.message}`,
      instructions: ['Return the message exactly as received'],
      outputFormat: 'JSON with {message: string}'
    }
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/result.json`
  }
}));

export async function process(inputs, ctx) {
  const result = await ctx.task(echoTask, { message: inputs.message || 'Hello from babysitter!' });
  return { success: true, echo: result };
}
```

**File: `.a5c/processes/smoke-test-inputs.json`**

```json
{ "message": "Integration smoke test" }
```

**Run the test:**

```
User: /babysit smoke-test

Expected:
1. Skill activates
2. Run created
3. Iteration 1: echo task requested
4. Agent executes echo task
5. Result posted
6. Iteration 2: run completed
7. Completion proof emitted
```

### Verification Script

```bash
#!/usr/bin/env bash
# scripts/verify-integration.sh
set -euo pipefail

echo "=== Babysitter Antigravity Integration Verification ==="

# 1. Check SDK
echo -n "SDK installed: "
babysitter version --json | jq -r '.version'

# 2. Check MCP server
echo -n "MCP config exists: "
if [ -f ".gemini/mcp_servers.json" ] || [ -f "${HOME}/.gemini/antigravity/mcp_config.json" ]; then
  echo "yes"
else
  echo "NO - create mcp_config.json"
fi

# 3. Check skill
echo -n "Skill exists: "
if [ -f ".agent/skills/babysitter/SKILL.md" ]; then
  echo "yes"
else
  echo "NO - create SKILL.md"
fi

# 4. Check rule
echo -n "Rule exists: "
if [ -f ".agents/babysitter-loop.md" ]; then
  echo "yes"
else
  echo "NO (optional) - create babysitter-loop.md"
fi

# 5. Test run create/iterate
echo "Running smoke test..."
RESULT=$(babysitter run:create \
  --process-id smoke-test \
  --entry .a5c/processes/smoke-test.js \
  --inputs .a5c/processes/smoke-test-inputs.json \
  --json 2>&1)

RUN_ID=$(echo "${RESULT}" | jq -r '.runId')
echo "Run created: ${RUN_ID}"

ITER=$(babysitter run:iterate "${RUN_ID}" --json --iteration 1)
STATUS=$(echo "${ITER}" | jq -r '.status')
echo "Iteration 1 status: ${STATUS}"

echo "=== Verification complete ==="
```

---

## 14. Limitations and Workarounds

### No Native Stop Hook

**Limitation**: Antigravity doesn't have a stop/exit hook equivalent that can
programmatically block the agent from finishing its turn.

**Workaround**: Use the babysitter Rule to instruct the agent to continue the
loop voluntarily. The Rule is injected into the system prompt and acts as a
persistent constraint. This is softer than a programmatic hook but works because
Antigravity agents are designed to follow Rules faithfully.

**Risk**: An agent could theoretically ignore the Rule if it believes the task
is complete (hallucinated completion). Mitigation: require `completionSecret`
from `run:status` before allowing any "done" declaration.

### Agent-First vs Task-First Paradigm

**Limitation**: Babysitter's effect model is task-first (request effect → execute
externally → post result). Antigravity is agent-first (agents plan and execute
autonomously).

**Workaround**: The babysitter skill bridges the paradigm gap by:
1. Reading effect definitions from `task:list`
2. Translating them into agent-friendly instructions
3. Having agents execute the work
4. Posting results back to the SDK

### Session Persistence Across Conversations

**Limitation**: Antigravity manages sessions internally and may not expose a
stable session ID across multiple conversations.

**Workaround**: Generate a ULID at session start and store it in the skill's
state directory. If the user returns to continue a run, they can reference the
run ID directly (which is stored in `.a5c/runs/`).

### No Transcript Scanning

**Limitation**: Antigravity does not provide a hook to scan the agent's output
for `<promise>` tags (unlike Claude Code's stop hook which reads the last message).

**Workaround**: The agent itself checks for completion proof. When `run:iterate`
or `run:status` returns `completionSecret`, the agent emits it in `<promise>` tags.
Since the agent controls the loop, it doesn't need external transcript scanning.

### Workflow Limitations

**Limitation**: Workflows are user-triggered (not automatic). The babysitter loop
cannot self-activate on project open.

**Workaround**: The user must explicitly invoke `/babysit` or mention orchestration
to trigger the skill. For automatic activation, add a Rule that detects `.a5c/runs/`
with active (non-completed) runs and suggests resuming.

---

## 15. Troubleshooting

### MCP Server Not Responding

```
Symptom: Agent says "I don't have babysitter tools available"
```

**Check:**
1. Verify `mcp_config.json` or `mcp_servers.json` exists
2. Verify `"enabled": true` in the server config
3. Restart Antigravity after config changes
4. Ask the agent: "What tools do you have access to?"
5. Check that `npx -y @a5c-ai/babysitter-sdk@latest` resolves correctly

### Skill Not Loading

```
Symptom: Agent doesn't follow babysitter orchestration instructions
```

**Check:**
1. Verify `SKILL.md` exists at `.agent/skills/babysitter/SKILL.md`
2. Check that the `description` field in SKILL.md frontmatter contains relevant
   trigger keywords: "babysitter", "orchestration", "process run"
3. Explicitly ask the agent to "use the babysitter skill"

### Run Iterate Returns Error

```
Symptom: { status: "failed", error: "..." }
```

**Check:**
1. Run `babysitter run:events <runId> --limit 5 --reverse` to see recent events
2. Check if the process definition has syntax errors
3. Verify the entry path is correct in `run:create`
4. Check `.a5c/runs/<runId>/journal/` for the last events

### Runaway Loop Detection

```
Symptom: Agent keeps iterating without progress
```

**Check:**
1. Run `scripts/check-status.sh <sessionId>` to check iteration timing
2. If average of last 3 iterations is under 15 seconds, the loop may be stuck
3. Check `task:list --pending` for effects that aren't being executed
4. Review effect definitions — the agent may not know how to execute a specific kind

### Sub-Agent Dispatch Fails

```
Symptom: Agent can't spawn sub-agents for parallel effects
```

**Check:**
1. Verify Antigravity's multi-agent feature is available in your plan
2. Check that the agent has workspace access for sub-agent execution
3. Fall back to sequential execution if parallel dispatch is unavailable:
   execute effects one at a time in the main agent

### Breakpoint Artifact Not Created

```
Symptom: Agent skips breakpoints instead of creating review artifacts
```

**Check:**
1. Verify the SKILL.md instructions for breakpoint handling are clear
2. Check the Rule for breakpoint enforcement
3. The agent may need explicit instruction: "When you encounter a breakpoint
   effect, create an artifact for me to review"

---

## Appendix A: File Layout Reference

```
project/
├── .a5c/
│   ├── runs/{runId}/           # Babysitter run data
│   │   ├── run.json
│   │   ├── journal/
│   │   ├── tasks/{effectId}/
│   │   └── state/
│   └── processes/              # Process definitions
│       ├── my-process.js
│       └── my-process-inputs.json
├── .agent/
│   └── skills/
│       └── babysitter/         # Babysitter orchestration skill
│           ├── SKILL.md
│           ├── scripts/
│           │   ├── install.sh
│           │   ├── init-session.sh
│           │   ├── iterate.sh
│           │   ├── check-status.sh
│           │   ├── mcp-server.js
│           │   └── verify-integration.sh
│           ├── references/
│           │   └── cli-reference.md
│           └── state/          # Session state (gitignored)
│               └── {sessionId}.md
├── .agents/
│   ├── babysitter-loop.md      # Orchestration discipline rule
│   └── workflows/
│       └── babysit.md          # /babysit workflow
└── .gemini/
    └── mcp_servers.json        # MCP server config (workspace)
```

## Appendix B: Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BABYSITTER_RUNS_DIR` | `.a5c/runs` | Root directory for run storage |
| `BABYSITTER_MAX_ITERATIONS` | `256` | Maximum orchestration iterations |
| `BABYSITTER_QUALITY_THRESHOLD` | `80` | Minimum quality score |
| `BABYSITTER_TIMEOUT` | `120000` | Operation timeout (ms) |
| `BABYSITTER_LOG_LEVEL` | `info` | Logging verbosity |

## Appendix C: Comparison with Other Harnesses

| Feature | Claude Code | Gemini CLI | Codex | OpenCode | OpenClaw | Antigravity |
|---------|-------------|------------|-------|----------|----------|-------------|
| Loop driver | Stop hook | AfterAgent hook | Wrapper/MCP | session.idle hook | agent_end hook | Skill + Rule |
| Exit blocking | Native (block/approve) | Exit code 2 | External wrapper | Plugin hook | Plugin hook | Rule enforcement |
| Parallel effects | Sequential agents | Sequential agents | Sequential | Sequential | Multi-channel | Multi-agent manager |
| Breakpoints | Terminal prompt | Terminal prompt | AGENTS.md | Plugin dialog | Webhook | Artifacts |
| Session state | Plugin state dir | Extension state dir | Config dir | Plugin storage | Gateway DB | Skill state dir |
| MCP support | Native | Native | Native | Native | Native | Native |
| Browser testing | Not built-in | Not built-in | Not built-in | Not built-in | Not built-in | Integrated Chrome |
