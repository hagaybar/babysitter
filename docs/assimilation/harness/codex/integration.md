# OpenAI Codex CLI Harness Integration for Babysitter SDK

Technical reference for integrating the babysitter SDK orchestration loop with
OpenAI Codex CLI. Covers architecture analysis, integration approach, mapping to
generic harness requirements, full implementation steps, and Codex-specific
considerations.

For the generic harness guide, see
[Generic Harness Integration Guide](../generic-harness-guide.md). For the
reference implementation, see
[Claude Code Integration](../claude-code-integration.md).

---

## Assumptions and Prerequisites

Before using this guide, verify the following:

1. **Codex CLI is installed and accessible.** Run:
   ```bash
   codex --version
   ```
   This guide targets Codex CLI as documented at
   [developers.openai.com/codex/cli](https://developers.openai.com/codex/cli/)
   (verified February 2026).

2. **Required Codex CLI features.** Confirm available subcommands and flags:
   ```bash
   codex --help
   codex exec --help
   codex mcp --help
   ```
   This guide relies on: `exec` (non-interactive mode), `mcp` (MCP server
   management), `sandbox` (OS-level sandboxing), and `--full-auto` (unattended
   approval).

3. **Babysitter SDK is installed.** Run:
   ```bash
   babysitter version --json
   ```

4. **Node.js >= 18** is available for the MCP server and wrapper scripts.

5. **Platform support.** Codex CLI supports macOS (Seatbelt sandbox), Linux
   (Landlock/bubblewrap sandbox), and Windows (native sandbox). The babysitter
   SDK runs on all three platforms. Shell scripts in this guide use POSIX syntax;
   on Windows, use Git Bash, WSL, or adapt to PowerShell. See
   [Section 5.13](#513-platform-compatibility) for platform-specific notes.

6. **Codex CLI architecture claims.** The following Codex features are verified
   against official documentation as of February 2026:
   - **AGENTS.md**: Discovered by walking from cwd to Git root. Size limited by
     `project_doc_max_bytes`.
   - **config.toml**: User-level (`~/.codex/config.toml`) and project-level
     (`.codex/config.toml`). Controls model, sandbox, MCP, agents, and notify.
   - **Notify hook**: Fires on `agent-turn-complete`. Receives JSON payload.
     Cannot block the agent turn or inject context back into the session
     (fire-and-forget semantics).
   - **MCP servers**: Configured under `[mcp_servers]` in config.toml with
     STDIO or HTTP transport. Managed via `codex mcp add|list|remove`.
   - **Sandbox modes**: `read-only`, `workspace-write`, `danger-full-access`.
   - **Approval policies**: `untrusted`, `on-request`, `never`.
   - **Multi-agent**: `[agents]` config with `max_depth` and `max_threads`.
     Requires `features.multi_agent = true`.

7. **Unverified references.** This guide references GitHub discussions and
   issues for proposed Codex hook features. These links could not be
   independently verified and are marked as "proposed" where they appear.

---

## Table of Contents

1. [OpenAI Codex CLI Overview](#1-openai-codex-cli-overview)
2. [Integration Approach](#2-integration-approach)
3. [Mapping Table -- Generic Requirements to Codex Specifics](#3-mapping-table----generic-requirements-to-codex-specifics)
4. [Implementation Steps](#4-implementation-steps)
   - [4a. SDK Installation](#4a-sdk-installation)
   - [4b. Session Initialization](#4b-session-initialization)
   - [4c. Run Creation and Session Binding](#4c-run-creation-and-session-binding)
   - [4d. Orchestration Loop Driver](#4d-orchestration-loop-driver)
   - [4e. Effect Execution](#4e-effect-execution)
   - [4f. Result Posting](#4f-result-posting)
   - [4g. Iteration Guards](#4g-iteration-guards)
5. [Codex-Specific Considerations](#5-codex-specific-considerations)
6. [Example Code](#6-example-code)
7. [Limitations and Workarounds](#7-limitations-and-workarounds)
8. [Appendix: CLI Quick Reference](#appendix-cli-quick-reference)
9. [Appendix: Integration Verification Checklist](#appendix-integration-verification-checklist)

---

## 1. OpenAI Codex CLI Overview

### What Is Codex CLI

OpenAI Codex CLI is a lightweight coding agent that runs in the terminal. It can
read, modify, and execute code on the local machine. It is built in Rust and
available as an open-source project at
[github.com/openai/codex](https://github.com/openai/codex). Codex CLI is
included with ChatGPT Plus, Pro, Business, Edu, and Enterprise plans.

### Architecture Relevant to Integration

- **Inputs**: AGENTS.md (instructions), config.toml (configuration), MCP Servers (tool sources)
- **Agent Loop (Core)**: User Input -> Model Inference -> Tool Calls -> Response. Tool results feed back into the next inference cycle. All tool execution is sandboxed.
- **Tool Layer**: Shell Tool (sandboxed exec), File Operations (read/write/edit), MCP Tool Calls (custom tools)
- **Control Layer**: Notify Hook (fire-and-forget event callback on turn complete), Approval Policy (permission rules for tool execution)

### Key Architectural Components

| Component | Description | Integration Relevance |
|-----------|-------------|----------------------|
| **Agent Loop** | Core inference-tool-call cycle. Each "turn" consists of model inference followed by zero or more tool calls. Turns end with an assistant message. | The loop is internal to Codex; we cannot inject a stop hook mid-turn. |
| **AGENTS.md** | Instruction files loaded at startup. Discovered from `~/.codex/` (global) and project directories (walking from Git root to cwd). | Primary mechanism for injecting babysitter orchestration instructions. |
| **config.toml** | Configuration at `~/.codex/config.toml` (user) or `.codex/config.toml` (project). Controls model, sandbox, MCP servers, agents, and notifications. | Used to register babysitter MCP server and configure notifications. |
| **MCP Servers** | Model Context Protocol servers providing additional tools. Configured in `config.toml` with STDIO or HTTP transport. Managed via `codex mcp` subcommand. | Babysitter CLI can be exposed as MCP tools for the agent to call. |
| **Notify Hook** | External program invoked on `agent-turn-complete` events. Receives JSON payload with thread ID, turn ID, and last assistant message. Fire-and-forget: cannot block the turn or inject context. | Closest equivalent to a stop hook. Useful for monitoring only. |
| **Exec Mode** | `codex exec` runs non-interactively, piping results to stdout. Supports `--full-auto` for unattended operation and `--json` for structured output. | Enables scripted orchestration wrapper around Codex. |
| **Sandbox** | OS-level sandboxing (macOS Seatbelt, Linux Landlock/bubblewrap, Windows native). Modes: `read-only`, `workspace-write`, `danger-full-access`. | Must allow babysitter CLI execution and `.a5c/` directory writes. |
| **Approval Policy** | Controls when user approval is needed: `untrusted`, `on-request`, `never`. | Must be configured to allow babysitter CLI calls without prompting. |
| **Multi-Agent** | `[agents]` config section enables spawning sub-agents with role-specific configs. Max depth and thread limits configurable. Requires `features.multi_agent = true`. | Can delegate orchestrator tasks to sub-agents. |

### Codex Agent Loop Lifecycle

```
User provides prompt
       |
       v
  Model Inference (Responses API)
       |
       v
  Response contains tool_calls?
  |                            |
  YES                          NO
  |                            |
  v                            v
  Execute tool calls           Assistant message returned
  (shell, file, MCP tools)    Turn ends --> notify hook fires
  |
  v
  Feed tool results back
  to model for next inference
  |
  +---> Loop back to Model Inference
```

---

## 2. Integration Approach

**Critical constraint -- No Stop Hook:** Codex CLI does not expose a "Stop"
hook that can block the agent from ending its turn. The `notify` mechanism
fires after the turn completes with fire-and-forget semantics and cannot
prevent the agent from returning control to the user. This is the single most
significant gap for babysitter integration and is the primary factor driving
strategy selection below.

Given this constraint and the broader architecture of Codex CLI, three
integration strategies are available, listed from most to least recommended.

### Strategy A: External Wrapper Loop (Recommended)

Wrap `codex exec` in a shell or Node.js script that implements the orchestration
loop externally. The wrapper calls `codex exec` repeatedly, feeding babysitter
context as the prompt for each iteration.

**How it works:** The wrapper script manages the full lifecycle -- session init,
run creation, iteration guards, and result posting. Codex is invoked once per
iteration via `codex exec --full-auto` to execute pending task effects. The
wrapper parses output and posts results back through the babysitter CLI.

**Pros:** Full control over the orchestration loop. No dependency on Codex
hooks or model instruction compliance. Works with `codex exec` non-interactive
mode.

**Cons:** Each iteration is a separate Codex session (no persistent context
across turns). Prompt caching mitigates cost but does not eliminate it.

### Strategy B: AGENTS.md + MCP Server (In-Session)

Configure babysitter as an MCP server that exposes orchestration tools. Use
AGENTS.md to instruct the Codex agent to follow the babysitter orchestration
protocol within a single interactive session.

**How it works:** The MCP server exposes tools like `babysitter_iterate`,
`babysitter_task_post`, and `babysitter_check_iteration`. AGENTS.md contains
the orchestration protocol the model must follow. The agent calls MCP tools
in its natural tool-call loop.

**Pros:** Single session with full context. Leverages Codex's native tool-call
loop. Simpler setup for interactive use.

**Cons:** Relies on the model following AGENTS.md instructions reliably. No
enforcement mechanism if the model decides to stop early. Cannot block exit.

### Strategy C: Notify Hook + External Orchestrator (Hybrid)

Use the `notify` hook to detect `agent-turn-complete` events and trigger an
external orchestrator that feeds the next iteration back via a new prompt.

**Cons:** Because the notify hook cannot block the turn or inject context back
into the session, this approach requires starting a new session for each
iteration, making it functionally equivalent to Strategy A but more complex.
Not recommended.

### Recommended Approach

**Use Strategy A (External Wrapper) for production/CI environments** where
reliable orchestration is critical. **Use Strategy B (AGENTS.md + MCP) for
interactive development** where the developer can intervene if the agent stops
prematurely.

---

## 3. Mapping Table -- Generic Requirements to Codex Specifics

The table below maps each generic harness requirement to its Codex CLI
equivalent. For strategy-specific implementation details, see Section 4.

| Generic Requirement | Required | Codex CLI Equivalent |
|---------------------|----------|----------------------|
| Shell command execution | YES | Shell tool (sandboxed). `codex exec` for non-interactive. MCP server tools. |
| Exit/stop interception | YES | NOT AVAILABLE NATIVELY. External wrapper loop (Strategy A) or AGENTS.md self-discipline (Strategy B). |
| Context re-injection | YES | Strategy A: new `codex exec` prompt per iteration. Strategy B: model self-continues via tools. |
| Session/conversation ID | YES | `thread-id` from notify payload. Strategy A: generate externally. Strategy B: derive from cwd or `CODEX_HOME`. |
| File system read/write | YES | Sandbox mode must be `workspace-write` or higher. `.a5c/` must be in `writable_roots`. |
| Transcript access | RECOMMENDED | Notify payload includes `last_assistant_msg`. Strategy B: agent outputs proof explicitly. |
| Lifecycle hooks | RECOMMENDED | Notify (`agent-turn-complete` only). No pre-turn, post-turn, or session-start hooks. See hook mapping below. |
| Persistent environment | RECOMMENDED | `config.toml` persists. Environment variables via `shell_environment_policy`. MCP server env vars. |
| Interactive user prompts | OPTIONAL | Interactive mode supports user input. `codex exec` does not. |
| Sub-agent delegation | OPTIONAL | Multi-agent feature (`agents.*` config). Requires `features.multi_agent = true`. |

### Hook Mapping

| Babysitter Hook | Tier | Codex CLI Equivalent |
|-----------------|------|----------------------|
| `session-start` | 1 | External wrapper: before first `codex exec`. Strategy B: MCP tool call at session start. |
| `stop` | 1 | NOT AVAILABLE. External wrapper loop or AGENTS.md self-discipline. |
| `on-run-start` | 3 | External wrapper: after `run:create`. |
| `on-run-complete` | 3 | External wrapper: when `run:iterate` returns `status=completed`. |
| `on-run-fail` | 3 | External wrapper: when `run:iterate` returns `status=failed`. |
| `on-task-start` | 3 | MCP tool: before delegating task to Codex. |
| `on-task-complete` | 3 | MCP tool: after `task:post`. |
| `on-iteration-start` | 2 | External wrapper: before `codex exec` call. |
| `on-iteration-end` | 2 | External wrapper: after `codex exec` returns. |
| `on-breakpoint` | 2 | Interactive mode: present to user. Exec mode: auto-resolve or fail. |
| `on-score` | 3 | MCP tool invocation. |
| `pre-commit` | 3 | Proposed: `exec_policy` rules (if governance hooks land in a future Codex release). |

---

## 4. Implementation Steps

### 4a. SDK Installation

**Goal:** Ensure the `babysitter` CLI binary is available for Codex to invoke.

#### Prerequisite Verification

Before installing, verify the environment:

```bash
# Check Codex CLI version and available subcommands
codex --version
codex exec --help

# Check MCP support
codex mcp list

# Check current sandbox configuration
codex --config sandbox_mode
```

#### For Strategy A (External Wrapper)

The wrapper script installs the SDK before entering the loop. This is identical
to the generic guide.

```bash
#!/usr/bin/env bash
set -euo pipefail

SDK_VERSION="${BABYSITTER_SDK_VERSION:-latest}"
MARKER_FILE="${HOME}/.babysitter-install-attempted"

install_babysitter() {
  if command -v babysitter &>/dev/null; then
    return 0
  fi

  if [[ -f "$MARKER_FILE" ]]; then
    return 1
  fi

  echo "Installing babysitter SDK v${SDK_VERSION}..."
  if npm install -g "@a5c-ai/babysitter-sdk@${SDK_VERSION}" 2>/dev/null; then
    touch "$MARKER_FILE"
    return 0
  fi

  if npm install -g "@a5c-ai/babysitter-sdk@${SDK_VERSION}" \
       --prefix "$HOME/.local" 2>/dev/null; then
    export PATH="$HOME/.local/bin:$PATH"
    touch "$MARKER_FILE"
    return 0
  fi

  touch "$MARKER_FILE"
  return 1
}

babysitter_cmd() {
  if command -v babysitter &>/dev/null; then
    babysitter "$@"
  else
    npx -y "@a5c-ai/babysitter-sdk@${SDK_VERSION}" babysitter "$@"
  fi
}

install_babysitter
babysitter_cmd version --json
```

#### For Strategy B (MCP Server)

The MCP server wrapper script must ensure the SDK is installed at startup. Add
an installation check to the MCP server entry point (see Section 6 for the full
MCP server implementation).

---

### 4b. Session Initialization

**Goal:** Create a baseline session state file before orchestration begins.

#### Strategy A: External Wrapper

```bash
SESSION_ID="codex-$(date +%s)-$(openssl rand -hex 4)"
STATE_DIR="${PLUGIN_ROOT}/skills/babysit/state"
mkdir -p "$STATE_DIR"

babysitter_cmd session:init \
  --session-id "$SESSION_ID" \
  --state-dir "$STATE_DIR" \
  --json
```

#### Strategy B: AGENTS.md + MCP

The MCP server initializes the session when the first tool call is made. Include
in AGENTS.md:

```markdown
# Babysitter Orchestration Protocol

At the start of any babysitter-orchestrated task, call
`babysitter_session_init` with a unique session ID before creating a run.
```

The MCP server tool handler:

```typescript
async function handleSessionInit(args: {
  sessionId: string;
  stateDir: string;
}): Promise<{ success: boolean; sessionId: string }> {
  const result = await execBabysitter([
    'session:init',
    '--session-id', args.sessionId,
    '--state-dir', args.stateDir,
    '--json',
  ]);
  return JSON.parse(result.stdout);
}
```

---

### 4c. Run Creation and Session Binding

**Goal:** Create a babysitter run and bind it to the current session.

#### Strategy A: External Wrapper

```bash
# Create the run
RUN_OUTPUT=$(babysitter_cmd run:create \
  --process-id "$PROCESS_ID" \
  --entry "$ENTRY_POINT" \
  --inputs "$INPUTS_FILE" \
  --prompt "$USER_PROMPT" \
  --json)

RUN_ID=$(echo "$RUN_OUTPUT" | jq -r '.runId')
RUN_DIR=".a5c/runs/${RUN_ID}"

# Bind session to run
babysitter_cmd session:associate \
  --session-id "$SESSION_ID" \
  --run-id "$RUN_ID" \
  --state-dir "$STATE_DIR" \
  --json
```

#### Strategy B: MCP Tool

```typescript
async function handleRunCreate(args: {
  processId: string;
  entry: string;
  inputsFile: string;
  prompt: string;
  sessionId: string;
  stateDir: string;
}): Promise<{ runId: string; runDir: string }> {
  const createResult = await execBabysitter([
    'run:create',
    '--process-id', args.processId,
    '--entry', args.entry,
    '--inputs', args.inputsFile,
    '--prompt', args.prompt,
    '--json',
  ]);
  const { runId } = JSON.parse(createResult.stdout);
  const runDir = `.a5c/runs/${runId}`;

  await execBabysitter([
    'session:associate',
    '--session-id', args.sessionId,
    '--run-id', runId,
    '--state-dir', args.stateDir,
    '--json',
  ]);

  return { runId, runDir };
}
```

---

### 4d. Orchestration Loop Driver

This is where the two strategies diverge most significantly.

#### Strategy A: External Wrapper Loop

The external wrapper replaces Codex's missing stop hook with an explicit loop.
Each iteration calls `codex exec` with a prompt that includes the current
orchestration state.

```
ORCHESTRATION LOOP (External Wrapper -- Strategy A)

  1. session:init
  2. run:create + session:associate
  3. LOOP:
     a. session:check-iteration --> shouldContinue?
        NO  --> EXIT LOOP
        YES --> continue
     b. run:iterate --> discover pending effects
     c. Build iteration prompt:
        - Iteration number and max
        - Pending effects list with task definitions
        - Instructions: execute effects, post results
     d. codex exec --full-auto "{iteration_prompt}"
        (Codex executes effects using shell/MCP tools)
     e. Capture Codex output
     f. Parse for <promise>PROOF</promise>
     g. If proof found and matches completion proof:
        --> EXIT LOOP (success)
     h. Update session state (increment iteration, timing)
     i. Go to 3a
  4. Cleanup session state file
```

**Key implementation detail:** Because each `codex exec` invocation is a
separate session, the prompt must include all necessary context. There is no
persistent memory across iterations (unless you maintain a context file that
Codex reads).

```bash
#!/usr/bin/env bash
# babysitter-codex-wrapper.sh -- External wrapper orchestration loop

set -euo pipefail

SESSION_ID="codex-$(date +%s)-$(openssl rand -hex 4)"
STATE_DIR="${PLUGIN_ROOT}/skills/babysit/state"
RUN_DIR=".a5c/runs/${RUN_ID}"
MAX_ITERATIONS=256
ITERATION=0

while true; do
  ITERATION=$((ITERATION + 1))

  # Guard: check iteration limits
  GUARD=$(babysitter_cmd session:check-iteration \
    --session-id "$SESSION_ID" \
    --state-dir "$STATE_DIR" \
    --json)

  SHOULD_CONTINUE=$(echo "$GUARD" | jq -r '.shouldContinue')
  if [[ "$SHOULD_CONTINUE" != "true" ]]; then
    echo "Orchestration stopped: $(echo "$GUARD" | jq -r '.reason')"
    break
  fi

  # Iterate: discover pending effects
  ITER_RESULT=$(babysitter_cmd run:iterate "$RUN_DIR" --json)
  STATUS=$(echo "$ITER_RESULT" | jq -r '.status')

  if [[ "$STATUS" == "completed" ]]; then
    PROOF=$(echo "$ITER_RESULT" | jq -r '.completionProof')
    echo "Run completed. Proof: $PROOF"
    break
  fi

  if [[ "$STATUS" == "failed" ]]; then
    echo "Run failed."
    break
  fi

  # List pending tasks
  TASKS=$(babysitter_cmd task:list "$RUN_DIR" --pending --json)

  # Build iteration prompt for Codex
  PROMPT=$(cat <<PROMPT_EOF
You are executing iteration ${ITERATION} of a babysitter orchestration run.

Run directory: ${RUN_DIR}
Run status: ${STATUS}

Pending tasks:
$(echo "$TASKS" | jq -r '.tasks[] | "- Effect \(.effectId): kind=\(.kind) title=\(.title)"')

For each pending task:
1. Read the task definition: babysitter task:show ${RUN_DIR} {effectId} --json
2. Execute the task according to its kind
3. Write the result to a file
4. Post the result: babysitter task:post ${RUN_DIR} {effectId} --status ok --value {resultFile} --json

After posting all results, output DONE.
PROMPT_EOF
  )

  # Execute via Codex
  CODEX_OUTPUT=$(codex exec --full-auto "$PROMPT" 2>&1) || true

  # Check for completion on next iteration (run:iterate will pick up posted results)
done

# Cleanup
rm -f "${STATE_DIR}/${SESSION_ID}.md"
```

#### Strategy B: AGENTS.md Self-Driven Loop

In this strategy, the Codex agent drives its own orchestration loop by following
AGENTS.md instructions and calling MCP tools. There is no external wrapper.

The agent is instructed to:
1. Initialize the session via MCP tool
2. Create a run via MCP tool
3. Iterate: call `babysitter_iterate`, execute pending tasks, post results
4. Repeat until the run is completed
5. Output the completion proof in `<promise>` tags

The risk is that the model may decide to stop early. AGENTS.md instructions are
advisory, not enforced. See Section 7 for workarounds.

---

### 4e. Effect Execution

**Goal:** Execute pending tasks discovered by `run:iterate`.

#### Using Codex's Shell Tool (Strategy A)

In Strategy A, the `codex exec` prompt instructs Codex to execute tasks using
its built-in shell tool. Codex can:

- Run Node.js scripts for `node` kind tasks
- Execute shell commands
- Read and write files
- Call MCP tools

The prompt must include the task definition and clear instructions for each
task kind.

#### Using MCP Tools (Strategy B)

Expose task execution helpers as MCP tools:

```typescript
async function handleExecuteNodeTask(args: {
  runDir: string;
  effectId: string;
}): Promise<{ status: string; output: unknown }> {
  const taskDir = `${args.runDir}/tasks/${args.effectId}`;

  const taskResult = await execBabysitter([
    'task:show', args.runDir, args.effectId, '--json',
  ]);
  const taskDef = JSON.parse(taskResult.stdout);

  if (taskDef.kind === 'node') {
    const execResult = await execNode(taskDef);
    return { status: 'ok', output: execResult };
  }

  if (taskDef.kind === 'breakpoint') {
    return {
      status: 'pending',
      output: {
        question: taskDef.args?.question,
        options: taskDef.args?.options,
        requiresUserInput: true,
      },
    };
  }

  return { status: 'error', output: { message: `Unknown kind: ${taskDef.kind}` } };
}
```

#### Task Kind Handling

| Task Kind | Strategy A (Wrapper) | Strategy B (MCP) |
|-----------|---------------------|-------------------|
| `node` | Codex shell tool runs Node.js script | MCP tool executes script and returns result |
| `breakpoint` | Cannot prompt user in exec mode. Auto-resolve or skip. | Interactive mode: present to user. Exec mode: auto-resolve. |
| `sleep` | Wrapper checks time condition in loop | MCP tool checks time and returns status |
| `orchestrator_task` | Codex executes as sub-prompt | Multi-agent: spawn sub-agent via `agents.*` config |
| `agent` | Codex executes as sub-prompt | Multi-agent: spawn sub-agent |

---

### 4f. Result Posting

**Goal:** Record effect execution results back into the run journal.

Results MUST be posted through the babysitter CLI. Never write `result.json`
directly.

#### Strategy A: Codex Shell Execution

The `codex exec` prompt instructs Codex to post results using the CLI:

```
After executing the task, post the result:

1. Write the result JSON to a file:
   echo '{"value": "result data here"}' > .a5c/runs/{runId}/tasks/{effectId}/output.json

2. Post through the CLI:
   babysitter task:post .a5c/runs/{runId} {effectId} \
     --status ok \
     --value .a5c/runs/{runId}/tasks/{effectId}/output.json \
     --json
```

#### Strategy B: MCP Tool

```typescript
async function handleTaskPost(args: {
  runDir: string;
  effectId: string;
  status: 'ok' | 'error';
  value: unknown;
}): Promise<{ success: boolean }> {
  const valueFile = `${args.runDir}/tasks/${args.effectId}/output.json`;
  await writeFile(valueFile, JSON.stringify(args.value));

  const result = await execBabysitter([
    'task:post', args.runDir, args.effectId,
    '--status', args.status,
    '--value', valueFile,
    '--json',
  ]);

  return { success: result.exitCode === 0 };
}
```

---

### 4g. Iteration Guards

**Goal:** Prevent infinite loops and detect runaway behavior.

#### Strategy A: External Wrapper

The wrapper calls `session:check-iteration` at the top of each loop iteration
(shown in Section 4d). This provides both max-iteration and runaway-speed
guards.

#### Strategy B: MCP Tool

Expose `session:check-iteration` as an MCP tool and instruct the agent to call
it before each iteration via AGENTS.md.

```typescript
async function handleCheckIteration(args: {
  sessionId: string;
  stateDir: string;
}): Promise<{
  shouldContinue: boolean;
  reason?: string;
  nextIteration?: number;
}> {
  const result = await execBabysitter([
    'session:check-iteration',
    '--session-id', args.sessionId,
    '--state-dir', args.stateDir,
    '--json',
  ]);
  return JSON.parse(result.stdout);
}
```

**Important for Strategy B:** The agent may ignore the `shouldContinue: false`
result. AGENTS.md must clearly instruct:

```markdown
CRITICAL: If babysitter_check_iteration returns shouldContinue=false, you MUST
stop immediately. Output the reason and do not make any more tool calls.
```

---

## 5. Codex-Specific Considerations

### 5.1 No Native Stop Hook

Codex CLI does not provide a mechanism to block the agent from ending its turn.
The `notify` hook fires after the turn completes and cannot prevent exit or
inject context. This is the most significant architectural gap.

**Impact:** The orchestration loop cannot be enforced by the harness. It must be
implemented externally (Strategy A) or rely on model compliance (Strategy B).

**Mitigation for Strategy B:** Use strong AGENTS.md instructions combined with
a "loop anchor" tool that the agent must call at the start and end of each
iteration. If the agent fails to call the anchor, the notify hook can detect the
gap and alert the user.

### 5.2 Error Recovery: Codex Crash Mid-Iteration

If Codex crashes or is killed during an iteration, the babysitter run can be
resumed from the last successful iteration. The journal is append-only and only
records completed effects, so partial work from the interrupted iteration is
safely ignored.

**Recovery steps (Strategy A):**

1. Check run status: `babysitter run:status .a5c/runs/RUN_ID --json`
2. If status is `running` or `waiting`, re-run the wrapper script with the same
   `--run-id`. The replay engine rebuilds state from the journal and picks up
   from the last resolved effect.
3. If the run lock is stale (Codex process died without releasing it), remove
   it: `rm .a5c/runs/RUN_ID/run.lock` -- or wait for the lock retry logic
   (40 retries at 250ms) to expire.

**Recovery steps (Strategy B):**

1. Restart the MCP server. It reads session state from disk on startup.
2. Re-enter the orchestration loop. The agent calls `babysitter_iterate` which
   replays the journal and returns only unresolved effects.

**Automated recovery in the wrapper:**

```bash
# In the wrapper loop, wrap codex exec in a retry
CODEX_OUTPUT=$(codex exec --full-auto "$PROMPT" 2>&1) || {
  echo "Codex crashed on iteration ${ITERATION}. Resuming..."
  # Remove stale lock if present
  rm -f "${RUN_DIR}/run.lock"
  continue  # Re-enter the loop; run:iterate will replay from journal
}
```

### 5.3 Sandbox Configuration

The babysitter CLI needs to write to the `.a5c/` directory and read/write task
artifacts. Configure the sandbox appropriately:

```toml
# .codex/config.toml
sandbox_mode = "workspace-write"

[sandbox_workspace_write]
writable_roots = [".a5c"]
```

If the babysitter CLI is installed globally, the sandbox must allow executing
binaries outside the workspace. With `workspace-write`, global binaries are
typically accessible for read/execute.

### 5.4 Approval Policy

Babysitter CLI commands should execute without interactive approval prompts.
Configure the approval policy to allow them:

```toml
# .codex/config.toml
approval_policy = "on-request"
```

For `codex exec --full-auto`, approvals are handled automatically. For
interactive mode, you may need to add babysitter commands to an allow-list.

### 5.5 AGENTS.md Size Limits

Codex limits combined AGENTS.md content to `project_doc_max_bytes` (default
value varies by Codex version). The babysitter orchestration instructions must
fit within this budget alongside any other project instructions.

```toml
# Increase if needed
project_doc_max_bytes = 65536
```

### 5.6 MCP Server Startup Timeout

The babysitter MCP server must start within the configured timeout. If SDK
installation is needed at startup, this may not be sufficient.

```toml
[mcp_servers.babysitter]
command = "node"
args = ["./babysitter-mcp-server.js"]
startup_timeout_sec = 30
tool_timeout_sec = 120
```

### 5.7 Prompt Caching

Codex aggressively caches prompts. Changing AGENTS.md content, MCP tool
definitions, or sandbox configuration between iterations can invalidate the
cache. For Strategy A, keep the prompt prefix stable across iterations and
append iteration-specific context at the end.

### 5.8 Multi-Agent for Orchestrator Tasks

Codex's multi-agent feature can handle `orchestrator_task` and `agent` effect
kinds:

```toml
[features]
multi_agent = true

[agents]
max_depth = 3
max_threads = 6

[agents.babysitter-worker]
description = "Executes babysitter task effects"
config_file = ".codex/babysitter-worker.toml"
```

### 5.9 Thread Identity

In Strategy A, each `codex exec` call creates a new thread. The session ID must
be managed externally. In Strategy B, the thread ID is available in the notify
payload but not directly accessible to MCP tools during execution. Generate the
session ID at MCP server startup or derive it from the working directory.

### 5.10 Notify Hook for Monitoring

Even when using Strategy A, the notify hook can provide observability:

```toml
# .codex/config.toml
notify = ["node", "./babysitter-notify.js"]
```

The notify script receives a JSON payload:

```json
{
  "type": "agent-turn-complete",
  "thread-id": "thread-abc123",
  "turn-id": "turn-001",
  "cwd": "/path/to/project",
  "last-assistant-message": "I have completed the task..."
}
```

This can be used to log iteration metrics, detect unexpected completions, or
trigger alerts.

### 5.11 Security: Protecting the .a5c/ Directory

The `.a5c/` directory contains run journals, task artifacts, session state, and
potentially sensitive process inputs and outputs. When using Codex CLI with
babysitter, take the following precautions:

- **Add `.a5c/` to `.gitignore`.** Run journals and state caches are derived
  data and should not be committed. Task artifacts may contain secrets or
  credentials passed as process inputs.
- **Restrict sandbox writable_roots.** Only grant write access to `.a5c/` and
  directories the process explicitly needs. Do not use `danger-full-access`
  sandbox mode in production.
- **Audit MCP tool arguments.** The babysitter MCP server receives process
  inputs and task arguments as tool call parameters. Ensure these do not leak
  into Codex telemetry or logging. Set `BABYSITTER_ALLOW_SECRET_LOGS=false`
  (the default).
- **Protect run.lock.** The lock file contains a PID and timestamp. In shared
  environments, ensure `.a5c/runs/` has appropriate filesystem permissions
  (e.g., `chmod 700`).
- **CI/CD environments.** If running in CI, ensure `.a5c/` is excluded from
  build artifacts and not cached between pipeline runs unless explicitly
  intended for resumption.

### 5.12 Concurrent Orchestration

When multiple Codex sessions or wrapper instances operate on the same project,
run isolation and lock strategy must be considered.

**Run-level locking.** The babysitter SDK uses exclusive file locks
(`run.lock`) with 40 retries at 250ms intervals. Two concurrent iterations on
the same run will serialize automatically. However, if a Codex process dies
while holding the lock, the stale lock must be removed manually or by the
wrapper's crash recovery logic (see Section 5.2).

**Session isolation.** Each wrapper instance must use a unique session ID. Do
not share session IDs across concurrent Codex invocations. The session state
file (`{stateDir}/{sessionId}.md`) is per-session and does not conflict.

**Parallel runs on the same project.** Multiple independent runs (different
run IDs) can execute concurrently without conflict. Each run has its own
directory under `.a5c/runs/` with independent journals and locks.

**Multi-agent and concurrency.** When using Codex's multi-agent feature
(`features.multi_agent = true`), sub-agents share the same sandbox and
filesystem. If sub-agents execute tasks for the same babysitter run, the
run lock serializes their `task:post` calls. If sub-agents operate on
different runs, no coordination is needed.

**Strategy A with parallel wrappers.** Running multiple wrapper instances
targeting different runs is safe. Running multiple wrappers targeting the
same run is not recommended -- the lock will serialize iterations, but the
wrappers may issue redundant `codex exec` calls for the same pending effects.

### 5.13 Platform Compatibility

| Platform | Sandbox Backend | Notes |
|----------|----------------|-------|
| **macOS** | Seatbelt | Full support. Sandbox profiles managed by Codex. |
| **Linux** | Landlock (default), bubblewrap (optional) | Full support. Landlock requires kernel >= 5.13. |
| **Windows** | Native sandbox | Supported. Shell scripts in this guide use POSIX syntax; use Git Bash, WSL, or adapt to PowerShell. Path separators differ (`\` vs `/`). |

**Windows-specific considerations:**
- Use forward slashes in `.a5c/` paths within config.toml (Codex normalizes).
- The `openssl rand -hex 4` command in session ID generation requires OpenSSL
  on PATH. Alternative: `powershell -c "[guid]::NewGuid().ToString('N').Substring(0,8)"`.
- The `babysitter-codex-wrapper.sh` script requires Bash. On Windows without
  WSL, use the TypeScript wrapper (Section 6.4) instead.

---

## 6. Example Code

### 6.1 Babysitter MCP Server for Codex (Strategy B)

A minimal MCP server that exposes babysitter CLI commands as tools for Codex.

```typescript
// babysitter-mcp-server.ts
// Run with: node babysitter-mcp-server.js
// Register in config.toml:
//   [mcp_servers.babysitter]
//   command = "node"
//   args = ["./babysitter-mcp-server.js"]

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

// --- Babysitter CLI wrapper ---

async function execBabysitter(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await execFileAsync('babysitter', args, {
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      exitCode: e.code ?? 1,
    };
  }
}

// --- MCP Tool Definitions ---

const TOOLS = [
  {
    name: 'babysitter_session_init',
    description: 'Initialize a babysitter session state file',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Unique session identifier' },
        stateDir: { type: 'string', description: 'Directory for state files' },
      },
      required: ['sessionId', 'stateDir'],
    },
  },
  {
    name: 'babysitter_run_create',
    description:
      'Create a new babysitter run and bind it to the current session',
    inputSchema: {
      type: 'object',
      properties: {
        processId: { type: 'string' },
        entry: { type: 'string' },
        inputsFile: { type: 'string' },
        prompt: { type: 'string' },
        sessionId: { type: 'string' },
        stateDir: { type: 'string' },
      },
      required: ['processId', 'entry', 'inputsFile', 'prompt'],
    },
  },
  {
    name: 'babysitter_iterate',
    description:
      'Advance the orchestration: replay journal and discover pending effects',
    inputSchema: {
      type: 'object',
      properties: {
        runDir: { type: 'string', description: 'Path to the run directory' },
      },
      required: ['runDir'],
    },
  },
  {
    name: 'babysitter_task_list',
    description: 'List pending tasks for a run',
    inputSchema: {
      type: 'object',
      properties: {
        runDir: { type: 'string' },
      },
      required: ['runDir'],
    },
  },
  {
    name: 'babysitter_task_show',
    description: 'Read the definition of a specific task',
    inputSchema: {
      type: 'object',
      properties: {
        runDir: { type: 'string' },
        effectId: { type: 'string' },
      },
      required: ['runDir', 'effectId'],
    },
  },
  {
    name: 'babysitter_task_post',
    description: 'Post a result for a completed task effect',
    inputSchema: {
      type: 'object',
      properties: {
        runDir: { type: 'string' },
        effectId: { type: 'string' },
        status: { type: 'string', enum: ['ok', 'error'] },
        value: { description: 'The result value (any JSON)' },
      },
      required: ['runDir', 'effectId', 'status', 'value'],
    },
  },
  {
    name: 'babysitter_run_status',
    description: 'Get the current status of a run including completion proof',
    inputSchema: {
      type: 'object',
      properties: {
        runDir: { type: 'string' },
      },
      required: ['runDir'],
    },
  },
  {
    name: 'babysitter_check_iteration',
    description:
      'Check iteration guards (max iterations, runaway detection)',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        stateDir: { type: 'string' },
      },
      required: ['sessionId', 'stateDir'],
    },
  },
];

// --- MCP Tool Handlers ---

async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case 'babysitter_session_init': {
      const { sessionId, stateDir } = args as {
        sessionId: string;
        stateDir: string;
      };
      mkdirSync(stateDir, { recursive: true });
      const result = await execBabysitter([
        'session:init',
        '--session-id', sessionId,
        '--state-dir', stateDir,
        '--json',
      ]);
      return JSON.parse(result.stdout || '{}');
    }

    case 'babysitter_run_create': {
      const { processId, entry, inputsFile, prompt, sessionId, stateDir } =
        args as Record<string, string>;
      const createArgs = [
        'run:create',
        '--process-id', processId,
        '--entry', entry,
        '--inputs', inputsFile,
        '--prompt', prompt,
        '--json',
      ];
      const createResult = await execBabysitter(createArgs);
      const { runId } = JSON.parse(createResult.stdout);

      if (sessionId && stateDir) {
        await execBabysitter([
          'session:associate',
          '--session-id', sessionId,
          '--run-id', runId,
          '--state-dir', stateDir,
          '--json',
        ]);
      }

      return { runId, runDir: `.a5c/runs/${runId}` };
    }

    case 'babysitter_iterate': {
      const { runDir } = args as { runDir: string };
      const result = await execBabysitter(['run:iterate', runDir, '--json']);
      return JSON.parse(result.stdout || '{}');
    }

    case 'babysitter_task_list': {
      const { runDir } = args as { runDir: string };
      const result = await execBabysitter([
        'task:list', runDir, '--pending', '--json',
      ]);
      return JSON.parse(result.stdout || '{"tasks":[]}');
    }

    case 'babysitter_task_show': {
      const { runDir, effectId } = args as {
        runDir: string;
        effectId: string;
      };
      const result = await execBabysitter([
        'task:show', runDir, effectId, '--json',
      ]);
      return JSON.parse(result.stdout || '{}');
    }

    case 'babysitter_task_post': {
      const { runDir, effectId, status, value } = args as {
        runDir: string;
        effectId: string;
        status: string;
        value: unknown;
      };
      const valueFile = join(runDir, 'tasks', effectId, 'output.json');
      mkdirSync(join(runDir, 'tasks', effectId), { recursive: true });
      writeFileSync(valueFile, JSON.stringify(value));

      const result = await execBabysitter([
        'task:post', runDir, effectId,
        '--status', status,
        '--value', valueFile,
        '--json',
      ]);
      return JSON.parse(result.stdout || '{}');
    }

    case 'babysitter_run_status': {
      const { runDir } = args as { runDir: string };
      const result = await execBabysitter(['run:status', runDir, '--json']);
      return JSON.parse(result.stdout || '{}');
    }

    case 'babysitter_check_iteration': {
      const { sessionId, stateDir } = args as {
        sessionId: string;
        stateDir: string;
      };
      const result = await execBabysitter([
        'session:check-iteration',
        '--session-id', sessionId,
        '--state-dir', stateDir,
        '--json',
      ]);
      return JSON.parse(result.stdout || '{}');
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// --- MCP STDIO Protocol Handler ---

const rl = createInterface({ input: process.stdin });

function sendResponse(id: string | number, result: unknown): void {
  const response = JSON.stringify({
    jsonrpc: '2.0',
    id,
    result,
  });
  process.stdout.write(response + '\n');
}

rl.on('line', async (line: string) => {
  try {
    const msg = JSON.parse(line);

    if (msg.method === 'initialize') {
      sendResponse(msg.id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'babysitter', version: '1.0.0' },
      });
      return;
    }

    if (msg.method === 'tools/list') {
      sendResponse(msg.id, { tools: TOOLS });
      return;
    }

    if (msg.method === 'tools/call') {
      const result = await handleToolCall(
        msg.params.name,
        msg.params.arguments ?? {},
      );
      sendResponse(msg.id, {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      });
      return;
    }

    // Unhandled method
    sendResponse(msg.id, { error: `Unknown method: ${msg.method}` });
  } catch (err) {
    // Best-effort error response
    process.stderr.write(`MCP error: ${err}\n`);
  }
});
```

### 6.2 AGENTS.md for Babysitter Orchestration (Strategy B)

Place this file at `.codex/AGENTS.md` or `AGENTS.md` in the project root:

```markdown
# Babysitter Orchestration Protocol

You are operating under babysitter SDK orchestration. Follow this protocol
exactly for any task that requires babysitter process execution.

## Available MCP Tools

- `babysitter_session_init` -- Initialize session state
- `babysitter_run_create` -- Create a run and bind to session
- `babysitter_iterate` -- Advance orchestration, discover pending effects
- `babysitter_task_list` -- List pending tasks
- `babysitter_task_show` -- Read task definition
- `babysitter_task_post` -- Post task result
- `babysitter_run_status` -- Check run status and get completion proof
- `babysitter_check_iteration` -- Check iteration guards

## Orchestration Protocol

When asked to execute a babysitter-managed process:

1. Generate a unique session ID (format: `codex-{timestamp}-{random}`)
2. Call `babysitter_session_init` with sessionId and stateDir
3. Call `babysitter_run_create` with process details and sessionId
4. Enter the orchestration loop:

### Orchestration Loop

Repeat until the run completes or guards stop you:

a. Call `babysitter_check_iteration`. If `shouldContinue` is false, STOP.
b. Call `babysitter_iterate` with the run directory.
c. If status is "completed":
   - Call `babysitter_run_status` to get the `completionProof`
   - Output: `<promise>{completionProof}</promise>`
   - STOP.
d. If status is "failed": report the error and STOP.
e. Call `babysitter_task_list` to get pending tasks.
f. For each pending task:
   - Call `babysitter_task_show` to read the definition
   - Execute the task according to its kind
   - Call `babysitter_task_post` with the result
g. Return to step (a).

## CRITICAL RULES

- NEVER stop the orchestration loop early. Always continue until the run
  is completed, failed, or guards indicate you should stop.
- ALWAYS post results through `babysitter_task_post`. Never write result
  files directly.
- ALWAYS output the completion proof in `<promise>` tags when the run
  completes. This is required for the orchestration system to verify
  completion.
- If `babysitter_check_iteration` returns `shouldContinue: false`, you
  MUST stop immediately.
```

### 6.3 Codex config.toml for Babysitter Integration

```toml
# .codex/config.toml -- Project-scoped configuration for babysitter integration

# Sandbox: allow writes to .a5c/ for run storage
sandbox_mode = "workspace-write"

[sandbox_workspace_write]
writable_roots = [".a5c", ".codex"]

# MCP Server: babysitter tools
[mcp_servers.babysitter]
command = "node"
args = ["./babysitter-mcp-server.js"]
startup_timeout_sec = 30
tool_timeout_sec = 120

# Increase AGENTS.md size limit for orchestration instructions
project_doc_max_bytes = 65536

# Optional: notification hook for monitoring
notify = ["node", "./babysitter-notify.js"]

# Optional: multi-agent for orchestrator tasks
[features]
multi_agent = true

[agents]
max_depth = 3
max_threads = 4
```

### 6.4 External Wrapper Script (Strategy A -- Complete)

```typescript
// babysitter-codex-orchestrator.ts
// Usage: npx tsx babysitter-codex-orchestrator.ts \
//   --process-id my-process \
//   --entry ./process.js#process \
//   --inputs ./inputs.json \
//   --prompt "Build the feature"
//
// Works on macOS, Linux, and Windows (Node.js handles path normalization).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';

const execFileAsync = promisify(execFile);

interface IterateResult {
  status: string;
  completionProof?: string;
}

interface CheckResult {
  found: boolean;
  shouldContinue: boolean;
  reason?: string;
  nextIteration?: number;
}

interface TaskListResult {
  tasks: Array<{
    effectId: string;
    kind: string;
    title: string;
    status: string;
  }>;
}

async function babysitter(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('babysitter', args, {
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

async function codexExec(prompt: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'codex',
      ['exec', '--full-auto', prompt],
      { timeout: 900_000, maxBuffer: 50 * 1024 * 1024 },
    );
    return stdout;
  } catch (err: unknown) {
    const e = err as { stdout?: string };
    return e.stdout ?? '';
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const processId = args[args.indexOf('--process-id') + 1];
  const entry = args[args.indexOf('--entry') + 1];
  const inputsFile = args[args.indexOf('--inputs') + 1];
  const prompt = args[args.indexOf('--prompt') + 1];

  const sessionId = `codex-${Date.now()}-${randomBytes(4).toString('hex')}`;
  const stateDir = '.a5c/state';
  mkdirSync(stateDir, { recursive: true });

  // 1. Initialize session
  await babysitter([
    'session:init',
    '--session-id', sessionId,
    '--state-dir', stateDir,
    '--json',
  ]);

  // 2. Create run
  const createOutput = await babysitter([
    'run:create',
    '--process-id', processId,
    '--entry', entry,
    '--inputs', inputsFile,
    '--prompt', prompt,
    '--json',
  ]);
  const { runId } = JSON.parse(createOutput);
  const runDir = `.a5c/runs/${runId}`;

  // 3. Bind session
  await babysitter([
    'session:associate',
    '--session-id', sessionId,
    '--run-id', runId,
    '--state-dir', stateDir,
    '--json',
  ]);

  console.log(`Session: ${sessionId}, Run: ${runId}`);

  // 4. Orchestration loop
  let iteration = 0;

  while (true) {
    iteration++;
    console.log(`\n--- Iteration ${iteration} ---`);

    // Check guards
    const guardOutput = await babysitter([
      'session:check-iteration',
      '--session-id', sessionId,
      '--state-dir', stateDir,
      '--json',
    ]);
    const guard: CheckResult = JSON.parse(guardOutput);

    if (!guard.shouldContinue) {
      console.log(`Stopping: ${guard.reason}`);
      break;
    }

    // Iterate
    const iterOutput = await babysitter([
      'run:iterate', runDir, '--json',
    ]);
    const iterResult: IterateResult = JSON.parse(iterOutput);

    if (iterResult.status === 'completed') {
      console.log(`Run completed. Proof: ${iterResult.completionProof}`);
      break;
    }

    if (iterResult.status === 'failed') {
      console.error('Run failed.');
      break;
    }

    // List pending tasks
    const taskOutput = await babysitter([
      'task:list', runDir, '--pending', '--json',
    ]);
    const taskList: TaskListResult = JSON.parse(taskOutput);

    if (taskList.tasks.length === 0) {
      console.log('No pending tasks.');
      continue;
    }

    // Build prompt for Codex
    const taskDescriptions = taskList.tasks
      .map((t) => `- Effect ${t.effectId}: kind=${t.kind}, title=${t.title}`)
      .join('\n');

    const iterPrompt = `
You are executing babysitter orchestration iteration ${iteration}.
Run directory: ${runDir}

Pending tasks:
${taskDescriptions}

For EACH pending task above:
1. Run: babysitter task:show ${runDir} EFFECT_ID --json
   (replace EFFECT_ID with the actual effect ID)
2. Execute the task based on its kind and arguments
3. Write the result to: ${runDir}/tasks/EFFECT_ID/output.json
4. Post the result: babysitter task:post ${runDir} EFFECT_ID --status ok --value ${runDir}/tasks/EFFECT_ID/output.json --json

Execute all pending tasks and post all results. Output "TASKS_COMPLETE" when done.
`.trim();

    // Execute via Codex
    console.log(`Delegating ${taskList.tasks.length} tasks to Codex...`);
    const codexOutput = await codexExec(iterPrompt);
    console.log(`Codex output length: ${codexOutput.length} chars`);
  }

  // Cleanup
  try {
    rmSync(`${stateDir}/${sessionId}.md`, { force: true });
  } catch {
    // Best-effort cleanup
  }

  console.log('\nOrchestration complete.');
}

main().catch(console.error);
```

### 6.5 Notify Script for Monitoring

```typescript
// babysitter-notify.ts
// Registered in config.toml: notify = ["node", "./babysitter-notify.js"]
// Receives JSON payload as first argument from Codex

import { appendFileSync } from 'node:fs';

interface NotifyPayload {
  type: string;
  'thread-id': string;
  'turn-id': string;
  cwd: string;
  'last-assistant-message': string;
}

const payload: NotifyPayload = JSON.parse(process.argv[2] || '{}');

if (payload.type === 'agent-turn-complete') {
  const lastMessage = payload['last-assistant-message'] || '';

  // Check for promise tag (completion proof)
  const promiseMatch = lastMessage.match(/<promise>([\s\S]*?)<\/promise>/);
  if (promiseMatch) {
    const proof = promiseMatch[1].trim();
    console.log(`[babysitter] Completion proof detected: ${proof}`);
  }

  // Log iteration
  const logEntry = {
    timestamp: new Date().toISOString(),
    threadId: payload['thread-id'],
    turnId: payload['turn-id'],
    hasPromise: !!promiseMatch,
    messageLength: lastMessage.length,
  };

  appendFileSync(
    '.a5c/codex-notify.log',
    JSON.stringify(logEntry) + '\n',
  );
}
```

---

## 7. Limitations and Workarounds

### 7.1 No Stop Hook -- Cannot Block Agent Exit

**Limitation:** Codex CLI has no mechanism to intercept and block the agent from
ending its turn. The notify hook fires after the turn completes with
fire-and-forget semantics. This prevents enforcing the orchestration loop at the
harness level.

**Workaround (Strategy A):** Use an external wrapper that calls `codex exec`
repeatedly. Each iteration is a separate Codex invocation. The wrapper controls
the loop externally.

**Workaround (Strategy B):** Use strong AGENTS.md instructions to make the
model self-enforce the loop. Accept that the model may occasionally exit early.
Add a monitor via the notify hook to detect premature exits.

**Proposed future improvement:** OpenAI community discussions have expressed
interest in a hooks system with `pre-command` and `post-command` hook points.
If governance hooks ship in a future Codex release, a proper stop-hook
equivalent may become possible. (Note: specific GitHub issue/discussion links
for this feature request could not be independently verified.)

### 7.2 No Context Persistence Across `codex exec` Calls

**Limitation:** In Strategy A, each `codex exec` invocation starts fresh. There
is no shared conversation history between iterations.

**Workaround:** Maintain a context file (e.g., `.a5c/codex-context.md`) that is
updated after each iteration with relevant state. Include this file in the
prompt:

```bash
PROMPT="$(cat .a5c/codex-context.md)

Iteration ${ITERATION}: Execute the following pending tasks..."
```

Codex's prompt caching helps if the prefix remains stable.

### 7.3 Breakpoints in Non-Interactive Mode

**Limitation:** `codex exec` does not support interactive user prompts.
Breakpoints requiring human approval cannot be handled.

**Workaround:** For `codex exec`, implement an auto-resolve strategy:

- If the breakpoint has a default option, select it
- If the process allows non-interactive resolution, use that path
- Otherwise, post an error result and let the process handle it

For interactive mode (Strategy B), breakpoints can be presented to the user
through Codex's normal conversation flow.

### 7.4 Session ID Not Available to MCP Tools

**Limitation:** MCP tools do not receive the Codex thread ID directly. The
`thread-id` is only available in the notify payload.

**Workaround:** Generate the session ID within the MCP server at startup and
store it in memory. Or instruct the agent via AGENTS.md to generate and pass a
session ID as a tool argument.

### 7.5 MCP Server Reliability

**Limitation:** If the MCP server crashes or times out, Codex cannot recover
the babysitter session state.

**Workaround:** The babysitter session state is stored on disk. A restarted MCP
server can read the state file and resume. Configure MCP server settings to
ensure Codex fails fast if the server is unavailable rather than proceeding
without babysitter tools.

### 7.6 Sandbox Restrictions on babysitter CLI

**Limitation:** In strict sandbox modes, the babysitter CLI may not be able to
write to `.a5c/` or execute Node.js scripts for task effects.

**Workaround:** Configure `writable_roots` to include `.a5c`:

```toml
[sandbox_workspace_write]
writable_roots = [".a5c"]
```

If running in `read-only` mode, Strategy A is the only viable option (the
wrapper runs outside the sandbox).

### 7.7 No Transcript Access for Proof Verification

**Limitation:** The MCP server cannot read the full agent transcript. It only
sees tool call arguments, not the agent's natural language output.

**Workaround:** Instead of parsing the transcript for `<promise>` tags, have
the agent call a dedicated MCP tool to submit the proof:

```typescript
// Additional MCP tool
{
  name: 'babysitter_submit_proof',
  description: 'Submit the completion proof to verify run completion',
  inputSchema: {
    type: 'object',
    properties: {
      runDir: { type: 'string' },
      proof: { type: 'string' },
    },
    required: ['runDir', 'proof'],
  },
}
```

AGENTS.md instructs: "When the run completes, call `babysitter_submit_proof`
with the completion proof AND output it in `<promise>` tags."

### 7.8 AGENTS.md Instruction Compliance

**Limitation:** The model may not follow AGENTS.md instructions perfectly,
especially for complex multi-step protocols like the orchestration loop.

**Workaround:** Keep instructions concise and structured. Use numbered steps.
Reinforce critical rules with "CRITICAL" labels. Test with the specific model
version used by Codex. Consider splitting complex orchestration across multiple
AGENTS.md files at different directory levels.

### 7.9 Integration Tier Achievability

Given the current Codex CLI architecture:

| Tier | Achievability | Notes |
|------|--------------|-------|
| Tier 1 (Minimum Viable) | YES with Strategy A | External wrapper provides full loop control |
| Tier 1 with Strategy B | PARTIAL | Loop works if model follows instructions; no enforcement |
| Tier 2 (Robust) | YES with Strategy A | All guards implemented in wrapper |
| Tier 2 with Strategy B | PARTIAL | Breakpoints work in interactive mode only |
| Tier 3 (Full) | PARTIAL | Multi-agent available. Governance hooks pending. |

---

## Appendix: CLI Quick Reference

| Command | Purpose | Section |
|---------|---------|---------|
| `codex --version` | Verify Codex CLI installation | Prerequisites |
| `codex exec --help` | Confirm exec mode availability | Prerequisites |
| `codex mcp list` | Verify MCP support | Prerequisites |
| `babysitter version --json` | Verify babysitter CLI installation | 4a |
| `babysitter session:init` | Create baseline session state | 4b |
| `babysitter run:create` | Create a new run | 4c |
| `babysitter session:associate` | Bind session to run | 4c |
| `babysitter run:iterate <run-dir> --json` | Advance orchestration | 4d |
| `babysitter run:status <run-dir> --json` | Read run status and proof | 4d |
| `babysitter task:list <run-dir> --pending --json` | List pending effects | 4e |
| `babysitter task:show <run-dir> <effect-id> --json` | Read task definition | 4e |
| `babysitter task:post <run-dir> <effect-id> --status <ok\|error> --value <result-file> --json` | Post result | 4f |
| `babysitter session:check-iteration` | Check iteration guards | 4g |
| `codex exec --full-auto "{prompt}"` | Non-interactive Codex execution | 4d |
| `codex mcp add babysitter -- node ./server.js` | Register MCP server | 6.1 |

---

## Appendix: Integration Verification Checklist

Use this checklist to verify a working Codex + babysitter integration.

### Environment

- [ ] `codex --version` returns a supported version
- [ ] `codex exec --help` confirms exec mode is available
- [ ] `codex mcp list` shows MCP support (Strategy B only)
- [ ] `babysitter version --json` returns SDK version info
- [ ] Node.js >= 18 is installed: `node --version`

### Configuration

- [ ] `.codex/config.toml` sets `sandbox_mode = "workspace-write"`
- [ ] `writable_roots` includes `".a5c"`
- [ ] MCP server registered in `config.toml` (Strategy B only)
- [ ] AGENTS.md placed at project root or `.codex/AGENTS.md` (Strategy B only)
- [ ] `.a5c/` is listed in `.gitignore`

### Orchestration Loop (Strategy A)

- [ ] Wrapper script creates session: `session:init` succeeds
- [ ] Run creation: `run:create` returns a valid `runId`
- [ ] Session binding: `session:associate` succeeds
- [ ] First iteration: `run:iterate` returns pending effects
- [ ] `codex exec --full-auto` executes and returns output
- [ ] Task results posted: `task:post` succeeds for each effect
- [ ] Guard check: `session:check-iteration` returns `shouldContinue`
- [ ] Loop terminates on `status=completed` or guard stop
- [ ] Crash recovery: removing stale `run.lock` and re-entering loop works

### Orchestration Loop (Strategy B)

- [ ] MCP server starts within `startup_timeout_sec`
- [ ] Agent calls `babysitter_session_init` on first interaction
- [ ] Agent follows orchestration loop per AGENTS.md instructions
- [ ] Agent calls `babysitter_check_iteration` before each iteration
- [ ] Agent outputs `<promise>` tag on run completion
- [ ] Agent stops when `shouldContinue` is false

### Security

- [ ] `.a5c/` is excluded from version control
- [ ] `BABYSITTER_ALLOW_SECRET_LOGS` is `false` (default)
- [ ] Sandbox does not use `danger-full-access` in production
- [ ] Run directory permissions restrict access in shared environments

---

## Sources

- [OpenAI Codex CLI](https://developers.openai.com/codex/cli/)
- [Codex CLI Features](https://developers.openai.com/codex/cli/features/)
- [Codex CLI Command Reference](https://developers.openai.com/codex/cli/reference/)
- [Codex Configuration Reference](https://developers.openai.com/codex/config-reference/)
- [Codex Advanced Configuration](https://developers.openai.com/codex/config-advanced/)
- [Codex Sample Configuration](https://developers.openai.com/codex/config-sample/)
- [Codex Config Basics](https://developers.openai.com/codex/config-basic/)
- [Codex MCP Integration](https://developers.openai.com/codex/mcp/)
- [Codex Agents SDK Guide](https://developers.openai.com/codex/guides/agents-sdk/)
- [Codex GitHub Repository](https://github.com/openai/codex)
- [Codex AGENTS.md (GitHub)](https://github.com/openai/codex/blob/main/AGENTS.md)
- [Codex GitHub Action](https://developers.openai.com/codex/github-action/)
