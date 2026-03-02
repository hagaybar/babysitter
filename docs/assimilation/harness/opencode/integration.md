# OpenCode Harness Integration for Babysitter SDK

Technical reference for integrating the babysitter SDK orchestration loop with
OpenCode (opencode-ai/opencode). Covers architecture analysis, integration
approach, mapping to generic harness requirements, full implementation steps,
and OpenCode-specific considerations.

For the generic harness guide, see
[Generic Harness Integration Guide](../generic-harness-guide.md). For the
reference implementation, see
[Claude Code Integration](../claude-code-integration.md).

---

## Table of Contents

1. [OpenCode Overview](#1-opencode-overview)
2. [Integration Approach](#2-integration-approach)
3. [Mapping Table -- Generic Requirements to OpenCode Specifics](#3-mapping-table----generic-requirements-to-opencode-specifics)
4. [Implementation Steps](#4-implementation-steps)
   - [4a. Strategy A -- Plugin with Stop Hook](#4a-strategy-a----plugin-with-stop-hook)
   - [4b. Strategy B -- External Wrapper](#4b-strategy-b----external-wrapper)
5. [Skills Porting](#5-skills-porting)
6. [OpenCode-Specific Considerations](#6-opencode-specific-considerations)
7. [Example Code](#7-example-code)
8. [E2E Verification](#8-e2e-verification)
9. [Production Deployment](#9-production-deployment)
10. [Troubleshooting](#10-troubleshooting)
11. [Limitations and Workarounds](#11-limitations-and-workarounds)

---

## Configuration

All tunable constants used throughout this document are defined here. Override
them via environment variables or pass them explicitly to the plugin/wrapper.

| Constant | Default | Env Override | Description |
|----------|---------|--------------|-------------|
| `MAX_ITERATIONS` | `256` | `BABYSITTER_MAX_ITERATIONS` | Maximum orchestration iterations per run |
| `MIN_ITERATION_INTERVAL_MS` | `2000` | `BABYSITTER_MIN_ITERATION_MS` | Minimum time between iterations before runaway detection triggers |
| `MAX_FAST_ITERATIONS` | `5` | `BABYSITTER_MAX_FAST_ITERS` | Consecutive fast iterations allowed before halting |
| `RUN_TIMEOUT_MS` | `120000` | `BABYSITTER_TIMEOUT` | General operation timeout |
| `HOOK_TIMEOUT_MS` | `30000` | `BABYSITTER_HOOK_TIMEOUT` | Per-hook execution timeout |
| `NODE_TASK_TIMEOUT_MS` | `900000` | `BABYSITTER_NODE_TASK_TIMEOUT` | Node task execution timeout |
| `QUALITY_THRESHOLD` | `80` | `BABYSITTER_QUALITY_THRESHOLD` | Minimum quality score to pass |

```typescript
// config.ts -- shared configuration for both strategies
const CONFIG = {
  MAX_ITERATIONS: parseInt(process.env.BABYSITTER_MAX_ITERATIONS ?? "256", 10),
  MIN_ITERATION_INTERVAL_MS: parseInt(process.env.BABYSITTER_MIN_ITERATION_MS ?? "2000", 10),
  MAX_FAST_ITERATIONS: parseInt(process.env.BABYSITTER_MAX_FAST_ITERS ?? "5", 10),
  RUN_TIMEOUT_MS: parseInt(process.env.BABYSITTER_TIMEOUT ?? "120000", 10),
  HOOK_TIMEOUT_MS: parseInt(process.env.BABYSITTER_HOOK_TIMEOUT ?? "30000", 10),
  NODE_TASK_TIMEOUT_MS: parseInt(process.env.BABYSITTER_NODE_TASK_TIMEOUT ?? "900000", 10),
  QUALITY_THRESHOLD: parseInt(process.env.BABYSITTER_QUALITY_THRESHOLD ?? "80", 10),
} as const
```

---

## 1. OpenCode Overview

### What Is OpenCode

OpenCode is an open-source AI coding agent built for the terminal. It provides
a TUI (Terminal User Interface) and a headless server mode for interacting with
various AI models. It is built in Go and available at
[github.com/opencode-ai/opencode](https://github.com/opencode-ai/opencode).

### Architecture Relevant to Integration

```
+----------------------------------------------------------------------+
|                       OpenCode Architecture                          |
|                                                                      |
|  +------------------+  +---------------------+  +-----------------+  |
|  | Plugin System    |  | opencode.json       |  | MCP Servers     |  |
|  | (.opencode/      |  | (Configuration)     |  | (Tool Sources)  |  |
|  |  plugins/)       |  |                     |  |                 |  |
|  +--------+---------+  +----------+----------+  +--------+--------+  |
|           |                       |                      |           |
|           v                       v                      v           |
|  +--------------------------------------------------------------+    |
|  |                     Agent Loop (Core)                         |    |
|  |                                                               |    |
|  |  User Input --> Model Inference --> Tool Calls --> Response   |    |
|  |       ^                                   |                   |    |
|  |       |           Plugin Hooks            |                   |    |
|  |       +------- (tool results) <-----------+                   |    |
|  +--------------------------------------------------------------+    |
|           |                       |                      |           |
|           v                       v                      v           |
|  +------------------+  +---------------------+  +-----------------+  |
|  | Built-in Tools   |  | File Operations     |  | MCP Tool Calls  |  |
|  | (shell, edit)    |  | (read/write/edit)   |  | (custom tools)  |  |
|  +------------------+  +---------------------+  +-----------------+  |
|                                                                      |
|  +------------------+  +---------------------+  +-----------------+  |
|  | Stop Hook        |  | Event System        |  | SDK Client      |  |
|  | (block exit)     |  | (SSE stream)        |  | (@opencode-ai/  |  |
|  +------------------+  +---------------------+  |  sdk)            |  |
|                                                  +-----------------+  |
+----------------------------------------------------------------------+
```

### Key Architectural Components

| Component | Description | Integration Relevance |
|-----------|-------------|----------------------|
| **Plugin System** | JS/TS modules in `.opencode/plugins/` or npm packages. Receive context object, return hooks. | Primary integration mechanism. Plugins can intercept stop, subscribe to events, add tools, and transform prompts. |
| **Stop Hook** | Plugin hook that intercepts agent stop attempts. Can send new prompts to continue the session. | **Critical for babysitter.** This is the exit/stop interception mechanism. Unlike many harnesses, OpenCode natively supports blocking exit. |
| **Event System** | Server-sent events stream via `client.event.subscribe()`. Events include `session.idle`, `session.created`, `session.error`, and 20+ other types. | Provides lifecycle awareness. `session.idle` signals turn completion. |
| **SDK Client** | `@opencode-ai/sdk` provides type-safe client: `client.session.prompt()`, `client.session.create()`, `client.session.abort()`, etc. | Enables programmatic session and message control from plugins. |
| **Custom Tools** | Plugins can define tools via `tool()` API. Tools receive args and context (directory, worktree). | Babysitter CLI commands can be exposed as custom tools the agent calls directly. |
| **CLI Run Mode** | `opencode run "prompt"` executes non-interactively. Supports `--model`, `--session`, `--continue`, `--format json`. | Enables external wrapper orchestration (Strategy B). |
| **Server Mode** | `opencode serve` exposes REST API. `POST /session/:id/message` sends prompts. Full OpenAPI 3.1 spec. | Alternative programmatic control for headless environments. |
| **System Prompt Transform** | `experimental.chat.system.transform` hook can inject context into the system prompt. | Inject babysitter orchestration instructions dynamically. |
| **Compaction Hook** | `experimental.session.compacting` hook fires before context compaction. Can preserve state. | Preserve babysitter state across context window compactions. |
| **opencode.json** | Project and global configuration. Controls providers, plugins, MCP servers. | Used to register babysitter plugin and MCP servers. |

### OpenCode Agent Loop Lifecycle

```
User provides prompt (TUI, CLI run, or SDK client.session.prompt())
       |
       v
  Model Inference
       |
       v
  +-- Response contains tool_calls? --+
  |                                    |
  | YES                                | NO
  |                                    |
  v                                    v
  Execute tool calls                   Assistant message returned
  (built-in, MCP, plugin tools)       Session becomes idle
  |                                    |
  v                                    v
  Plugin hooks fire:                 Plugin hooks fire:
  tool.execute.before/after          session.idle event
  |                                    |
  +---> Loop back to inference       Stop hook fires:
                                     Plugin can send new prompt
                                     to continue the session
                                     OR allow exit
```

**Critical advantage over other harnesses:** OpenCode's plugin `stop` hook
can intercept exit and send a new prompt via `client.session.prompt()`. This
provides the exit/stop interception that the babysitter orchestration loop
requires, without needing an external wrapper.

---

## 2. Integration Approach

Given OpenCode's rich plugin system and native stop hook, two strategies are
available.

### Strategy A: Plugin with Stop Hook (Recommended)

Implement the babysitter orchestration loop as an OpenCode plugin. The plugin
uses the `stop` hook to intercept agent exit, runs `session:check-iteration`
and `run:iterate`, and sends continuation prompts via `client.session.prompt()`.

```
+--------------------------------------------------------------+
|              OpenCode Plugin Orchestration                    |
|                                                               |
|  Plugin init:                                                |
|    1. Subscribe to session.created event                     |
|    2. On session start: babysitter session:init              |
|    3. On session start: babysitter run:create                |
|                                                               |
|  Stop hook (fires when agent tries to exit):                 |
|    1. babysitter session:check-iteration                     |
|       NO continue --> allow stop                             |
|       YES continue --> continue                              |
|    2. babysitter run:iterate (discover pending effects)      |
|    3. Build continuation prompt with pending tasks           |
|    4. client.session.prompt({ path, body })                  |
|       (Agent continues working in same session)              |
|    5. Repeat on next stop                                    |
|                                                               |
|  Event: session.idle                                         |
|    - Check for completion proof in last message              |
|    - If run completed, allow next stop to exit               |
+--------------------------------------------------------------+
```

**Pros:** Full stop-hook enforcement. Single session with persistent context.
Leverages native plugin system -- no external scripts. Agent sees all prior
context on each iteration.

**Cons:** Requires understanding the OpenCode plugin API. Plugin must manage
state across stop-hook invocations.

### Strategy B: External Wrapper with CLI Run Mode

Wrap `opencode run` in a script that implements the orchestration loop
externally. Each iteration invokes `opencode run "prompt"` with babysitter
context.

```
+--------------------------------------------------------------+
|                  External Wrapper Script                      |
|                                                               |
|  while (shouldContinue):                                      |
|    1. babysitter session:check-iteration                      |
|    2. babysitter run:iterate (discover pending effects)       |
|    3. Build prompt with iteration context + pending tasks     |
|    4. opencode run "{prompt}" --format json                   |
|       (OpenCode executes effects via tools)                   |
|    5. Parse output for completion proof                       |
|    6. If effects were executed, post results via task:post    |
|    7. Check completion proof                                  |
|    8. Update session state                                    |
+--------------------------------------------------------------+
```

**Pros:** Simple to implement. No plugin knowledge required. Works in CI/CD.

**Cons:** Each iteration is a separate session (no persistent context). Higher
token cost without prompt caching.

### Recommended Approach

**Use Strategy A (Plugin with Stop Hook) for all environments.** OpenCode's
native stop hook provides the critical exit interception that most harnesses
lack. Only fall back to Strategy B if the plugin system is unavailable or if
operating in a restricted environment where plugins cannot be loaded.

---

## 3. Mapping Table -- Generic Requirements to OpenCode Specifics

```
+---------------------------+----------+----------------------------------------------+
| Generic Requirement       | Required | OpenCode Equivalent                          |
+---------------------------+----------+----------------------------------------------+
| Shell command execution   | YES      | Built-in shell tool. Plugin $ (Bun shell     |
|                           |          | API). opencode run for non-interactive.       |
+---------------------------+----------+----------------------------------------------+
| Exit/stop interception    | YES      | NATIVE: Plugin stop hook. Can intercept       |
|                           |          | exit and send continuation prompt via         |
|                           |          | client.session.prompt().                      |
+---------------------------+----------+----------------------------------------------+
| Context re-injection      | YES      | client.session.prompt() sends new messages    |
|                           |          | into the active session. System prompt        |
|                           |          | transform for persistent context.             |
+---------------------------+----------+----------------------------------------------+
| Session/conversation ID   | YES      | session.id from client.session.create() or    |
|                           |          | event.properties.session_id from events.      |
+---------------------------+----------+----------------------------------------------+
| File system read/write    | YES      | Built-in file tools. Plugin has directory     |
|                           |          | and worktree context.                         |
+---------------------------+----------+----------------------------------------------+
| Transcript access         | RECOM.   | client.session.messages() returns full        |
|                           |          | message history with parts.                   |
+---------------------------+----------+----------------------------------------------+
| Lifecycle hooks           | RECOM.   | NATIVE: session.created, session.idle,        |
|                           |          | session.deleted, tool.execute.before/after,   |
|                           |          | stop hook.                                    |
+---------------------------+----------+----------------------------------------------+
| Persistent environment    | RECOM.   | Plugin state persists across hook calls.      |
|                           |          | Plugin context has project and directory.     |
+---------------------------+----------+----------------------------------------------+
| Interactive user prompts  | OPTIONAL | TUI mode supports full interaction.           |
|                           |          | Plugin can use tui.showToast() for alerts.    |
+---------------------------+----------+----------------------------------------------+
| Sub-agent delegation      | OPTIONAL | No native sub-agent feature. Can spawn        |
|                           |          | separate sessions via SDK client.             |
+---------------------------+----------+----------------------------------------------+
```

### Hook Equivalence

This table maps babysitter SDK hooks to OpenCode plugin hooks. The "Origin"
column clarifies which system defines each hook.

```
+---------------------+--------+------+-------------------------------------------+
| Hook                | Origin | Tier | OpenCode Equivalent                       |
+---------------------+--------+------+-------------------------------------------+
| session-start       | SDK    |  1   | Plugin event: session.created             |
+---------------------+--------+------+-------------------------------------------+
| stop                | SDK    |  1   | Plugin stop hook (NATIVE -- can block     |
|                     |        |      | exit and send continuation prompt)        |
+---------------------+--------+------+-------------------------------------------+
| on-run-start        | SDK    |  3   | Plugin: after run:create CLI call         |
+---------------------+--------+------+-------------------------------------------+
| on-run-complete     | SDK    |  3   | Plugin: when run:iterate returns          |
|                     |        |      | status=completed                          |
+---------------------+--------+------+-------------------------------------------+
| on-run-fail         | SDK    |  3   | Plugin: when run:iterate returns          |
|                     |        |      | status=failed                             |
+---------------------+--------+------+-------------------------------------------+
| on-task-start       | SDK    |  3   | Plugin tool: before delegating task       |
+---------------------+--------+------+-------------------------------------------+
| on-task-complete    | SDK    |  3   | Plugin tool: after task:post              |
+---------------------+--------+------+-------------------------------------------+
| on-iteration-start  | SDK    |  2   | Plugin stop hook: entry point             |
+---------------------+--------+------+-------------------------------------------+
| on-iteration-end    | SDK    |  2   | Plugin event: session.idle                |
+---------------------+--------+------+-------------------------------------------+
| on-breakpoint       | SDK    |  2   | TUI mode: tui.showToast() + wait.         |
|                     |        |      | CLI run mode: auto-resolve or fail.       |
+---------------------+--------+------+-------------------------------------------+
| on-score            | SDK    |  3   | Plugin tool invocation                    |
+---------------------+--------+------+-------------------------------------------+
| pre-commit          | SDK    |  3   | Plugin tool.execute.before hook           |
+---------------------+--------+------+-------------------------------------------+
| -- OpenCode-only hooks below --                                               |
+---------------------+--------+------+-------------------------------------------+
| session.idle        | OC     |  --  | Fires when agent turn completes.          |
|                     |        |      | Used to detect iteration boundaries.      |
+---------------------+--------+------+-------------------------------------------+
| session.compacted   | OC     |  --  | Fires after context compaction.           |
|                     |        |      | Use compacting hook to preserve state.    |
+---------------------+--------+------+-------------------------------------------+
| tool.execute.before | OC     |  --  | Fires before any tool execution.          |
|                     |        |      | Can modify or block tool calls.           |
+---------------------+--------+------+-------------------------------------------+
| tool.execute.after  | OC     |  --  | Fires after tool execution completes.     |
+---------------------+--------+------+-------------------------------------------+
| experimental.chat   | OC     |  --  | Transform system prompt to inject         |
| .system.transform   |        |      | babysitter context.                       |
+---------------------+--------+------+-------------------------------------------+
```

---

## 4. Implementation Steps

This section provides one integrated example per strategy. Each example covers
the full lifecycle: SDK installation, session initialization, run creation,
orchestration loop, effect execution (including breakpoints), result posting,
and iteration guards.

### 4a. Strategy A -- Plugin with Stop Hook

The plugin implements the complete babysitter orchestration loop inside
OpenCode. It handles session lifecycle, run management, effect execution via
custom tools, breakpoint handling, and iteration guards -- all in a single
cohesive module.

**Prerequisites:**

```bash
# Option 1: Global install
npm install -g @a5c-ai/babysitter-sdk

# Option 2: Project dependency (plugin can use Bun shell to invoke npx)
npm install --save-dev @a5c-ai/babysitter-sdk
```

**Complete integrated plugin:**

```typescript
// .opencode/plugins/babysitter.ts
//
// Full babysitter orchestration plugin for OpenCode.
// Covers: installation verification, session init, run creation,
// stop-hook orchestration, custom tools, breakpoint handling,
// iteration guards, runaway detection, and compaction preservation.

import { type Plugin, tool } from "@opencode-ai/plugin"
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs"

// ---------------------------------------------------------------------------
// Configuration -- all constants read from env with documented defaults
// (see Configuration section at the top of this document)
// ---------------------------------------------------------------------------
const CONFIG = {
  MAX_ITERATIONS: parseInt(process.env.BABYSITTER_MAX_ITERATIONS ?? "256", 10),
  MIN_ITERATION_INTERVAL_MS: parseInt(process.env.BABYSITTER_MIN_ITERATION_MS ?? "2000", 10),
  MAX_FAST_ITERATIONS: parseInt(process.env.BABYSITTER_MAX_FAST_ITERS ?? "5", 10),
  RUN_TIMEOUT_MS: parseInt(process.env.BABYSITTER_TIMEOUT ?? "120000", 10),
  HOOK_TIMEOUT_MS: parseInt(process.env.BABYSITTER_HOOK_TIMEOUT ?? "30000", 10),
  NODE_TASK_TIMEOUT_MS: parseInt(process.env.BABYSITTER_NODE_TASK_TIMEOUT ?? "900000", 10),
  QUALITY_THRESHOLD: parseInt(process.env.BABYSITTER_QUALITY_THRESHOLD ?? "80", 10),
} as const

// ---------------------------------------------------------------------------
// Session state -- all dynamic properties are explicitly declared
// ---------------------------------------------------------------------------
interface SessionState {
  /** Babysitter session ID (opencode-<timestamp>-<random>) */
  babysitterId: string
  /** Babysitter run ID, set after run:create */
  runId: string | undefined
  /** Run directory path relative to project root */
  runDir: string | undefined
  /** Current orchestration iteration count */
  iteration: number
  /** Whether this run has completed or failed */
  completed: boolean
  /** Timestamp of the last iteration start (ms since epoch) */
  lastIterationTime: number | undefined
  /** Count of consecutive fast iterations (below MIN_ITERATION_INTERVAL_MS) */
  fastIterationCount: number
  /** Process ID for the babysitter process definition */
  processId: string | undefined
  /** Entry point for the process function */
  entryPoint: string | undefined
  /** Whether a breakpoint is currently pending user approval */
  breakpointPending: boolean
  /** Effect ID of the pending breakpoint, if any */
  pendingBreakpointEffectId: string | undefined
}

function createSessionState(babysitterId: string): SessionState {
  return {
    babysitterId,
    runId: undefined,
    runDir: undefined,
    iteration: 0,
    completed: false,
    lastIterationTime: undefined,
    fastIterationCount: 0,
    processId: undefined,
    entryPoint: undefined,
    breakpointPending: false,
    pendingBreakpointEffectId: undefined,
  }
}

// ---------------------------------------------------------------------------
// Persistence file for surviving plugin restarts
// ---------------------------------------------------------------------------
const SESSION_MAP_FILE = ".a5c/opencode-sessions.json"

function persistSessions(
  sessions: Map<string, SessionState>,
  directory: string,
): void {
  const filePath = `${directory}/${SESSION_MAP_FILE}`
  const dir = filePath.substring(0, filePath.lastIndexOf("/"))
  mkdirSync(dir, { recursive: true })
  const data = Object.fromEntries(sessions.entries())
  writeFileSync(filePath, JSON.stringify(data, null, 2))
}

function restoreSessions(
  directory: string,
): Map<string, SessionState> {
  const filePath = `${directory}/${SESSION_MAP_FILE}`
  if (!existsSync(filePath)) return new Map()
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf-8"))
    return new Map(Object.entries(raw))
  } catch {
    return new Map()
  }
}

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------
export const BabysitterOrchestrator: Plugin = async ({ $, client, directory }) => {
  const stateDir = `${directory}/.a5c/state`
  const sessions = restoreSessions(directory)

  // --- Verify babysitter CLI is available ---
  const versionCheck = await $`babysitter version --json`.quiet()
  if (versionCheck.exitCode !== 0) {
    await client.app.log({
      body: { level: "error", message: "babysitter CLI not found. Install with: npm install -g @a5c-ai/babysitter-sdk" }
    })
    return {}
  }
  await client.app.log({
    body: { level: "info", message: `babysitter: ${versionCheck.stdout.toString().trim()}` }
  })

  // --- Helper: safe babysitter CLI execution ---
  async function execBabysitter(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    try {
      const result = await $`babysitter ${args.join(" ")}`.quiet()
      return {
        ok: result.exitCode === 0,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
      }
    } catch (err: unknown) {
      const e = err as { stdout?: { toString(): string }; stderr?: { toString(): string } }
      return {
        ok: false,
        stdout: e.stdout?.toString() ?? "",
        stderr: e.stderr?.toString() ?? `babysitter command failed: ${String(err)}`,
      }
    }
  }

  // --- Helper: build continuation prompt ---
  function buildPrompt(
    iteration: number,
    runDir: string,
    status: string,
    tasks: Array<{ effectId: string; kind: string; title: string }>,
  ): string {
    const taskLines = tasks
      .map(t => `- Effect ${t.effectId}: kind=${t.kind}, title="${t.title}"`)
      .join("\n")

    return [
      `Babysitter orchestration iteration ${iteration}.`,
      `Run: ${runDir} | Status: ${status}`,
      "",
      "Pending tasks:",
      taskLines,
      "",
      "For each task: use babysitter_task_show to read the definition,",
      "execute it, then use babysitter_task_post to post the result.",
      "",
      "For breakpoint tasks: use babysitter_breakpoint_resolve to approve or reject.",
    ].join("\n")
  }

  // --- Helper: runaway detection using configured thresholds ---
  function isRunaway(state: SessionState): boolean {
    const now = Date.now()
    if (
      state.lastIterationTime !== undefined &&
      (now - state.lastIterationTime) < CONFIG.MIN_ITERATION_INTERVAL_MS
    ) {
      state.fastIterationCount++
      if (state.fastIterationCount >= CONFIG.MAX_FAST_ITERATIONS) return true
    } else {
      state.fastIterationCount = 0
    }
    state.lastIterationTime = now
    return false
  }

  // --- Plugin hooks and tools ---
  return {
    // -----------------------------------------------------------------------
    // Custom tools for the agent to call
    // -----------------------------------------------------------------------
    tool: {
      babysitter_task_show: tool({
        description: "Read a babysitter task definition by effect ID",
        args: {
          runDir: tool.schema.string(),
          effectId: tool.schema.string(),
        },
        async execute(args) {
          const r = await execBabysitter([
            "task:show", args.runDir, args.effectId, "--json",
          ])
          if (!r.ok) return JSON.stringify({ error: r.stderr })
          return r.stdout
        },
      }),

      babysitter_task_post: tool({
        description: "Post a result for a completed babysitter task",
        args: {
          runDir: tool.schema.string(),
          effectId: tool.schema.string(),
          status: tool.schema.string(),
          resultJson: tool.schema.string(),
        },
        async execute(args) {
          const valueFile = `${args.runDir}/tasks/${args.effectId}/output.json`
          try {
            mkdirSync(`${args.runDir}/tasks/${args.effectId}`, { recursive: true })
            writeFileSync(valueFile, args.resultJson)
          } catch (err: unknown) {
            return JSON.stringify({ error: `Failed to write result file: ${String(err)}` })
          }
          const r = await execBabysitter([
            "task:post", args.runDir, args.effectId,
            "--status", args.status,
            "--value", valueFile,
            "--json",
          ])
          if (!r.ok) return JSON.stringify({ error: r.stderr })
          return r.stdout
        },
      }),

      babysitter_task_list: tool({
        description: "List pending babysitter tasks for a run",
        args: {
          runDir: tool.schema.string(),
        },
        async execute(args) {
          const r = await execBabysitter([
            "task:list", args.runDir, "--pending", "--json",
          ])
          if (!r.ok) return JSON.stringify({ error: r.stderr })
          return r.stdout
        },
      }),

      babysitter_run_status: tool({
        description: "Get babysitter run status and completion proof",
        args: { runDir: tool.schema.string() },
        async execute(args) {
          const r = await execBabysitter([
            "run:status", args.runDir, "--json",
          ])
          if (!r.ok) return JSON.stringify({ error: r.stderr })
          return r.stdout
        },
      }),

      babysitter_breakpoint_resolve: tool({
        description: "Resolve a pending breakpoint by approving or rejecting it",
        args: {
          runDir: tool.schema.string(),
          effectId: tool.schema.string(),
          action: tool.schema.string(), // "approve" or "reject"
          reason: tool.schema.string().optional(),
        },
        async execute(args) {
          const status = args.action === "approve" ? "ok" : "error"
          const resultPayload = JSON.stringify({
            approved: args.action === "approve",
            reason: args.reason ?? (args.action === "approve" ? "Approved by agent" : "Rejected by agent"),
          })
          const valueFile = `${args.runDir}/tasks/${args.effectId}/output.json`
          try {
            mkdirSync(`${args.runDir}/tasks/${args.effectId}`, { recursive: true })
            writeFileSync(valueFile, resultPayload)
          } catch (err: unknown) {
            return JSON.stringify({ error: `Failed to write breakpoint result: ${String(err)}` })
          }
          const r = await execBabysitter([
            "task:post", args.runDir, args.effectId,
            "--status", status,
            "--value", valueFile,
            "--json",
          ])
          if (!r.ok) return JSON.stringify({ error: r.stderr })

          // Clear breakpoint state
          for (const [, state] of sessions) {
            if (state.runDir === args.runDir && state.pendingBreakpointEffectId === args.effectId) {
              state.breakpointPending = false
              state.pendingBreakpointEffectId = undefined
            }
          }

          return r.stdout
        },
      }),

      babysitter_session_init: tool({
        description: "Initialize a babysitter session and create a run",
        args: {
          processId: tool.schema.string(),
          entry: tool.schema.string(),
          prompt: tool.schema.string(),
          inputsFile: tool.schema.string().optional(),
        },
        async execute(args, ctx) {
          const sessionId = `opencode-${Date.now()}-${
            Math.random().toString(36).slice(2, 10)
          }`

          await $`mkdir -p ${stateDir}`.quiet()
          const initResult = await execBabysitter([
            "session:init",
            "--session-id", sessionId,
            "--state-dir", stateDir,
            "--json",
          ])
          if (!initResult.ok) {
            return JSON.stringify({ error: `session:init failed: ${initResult.stderr}` })
          }

          const createArgs = [
            "run:create",
            "--process-id", args.processId,
            "--entry", args.entry,
            "--prompt", args.prompt,
          ]
          if (args.inputsFile) createArgs.push("--inputs", args.inputsFile)
          createArgs.push("--json")

          const createResult = await execBabysitter(createArgs)
          if (!createResult.ok) {
            return JSON.stringify({ error: `run:create failed: ${createResult.stderr}` })
          }

          const { runId } = JSON.parse(createResult.stdout)
          const runDir = `.a5c/runs/${runId}`

          const assocResult = await execBabysitter([
            "session:associate",
            "--session-id", sessionId,
            "--run-id", runId,
            "--state-dir", stateDir,
            "--json",
          ])
          if (!assocResult.ok) {
            return JSON.stringify({ error: `session:associate failed: ${assocResult.stderr}` })
          }

          return JSON.stringify({ sessionId, runId, runDir })
        },
      }),
    },

    // -----------------------------------------------------------------------
    // Event handler for session lifecycle
    // -----------------------------------------------------------------------
    event: async ({ event }) => {
      if (event.type === "session.created") {
        const ocId = event.properties.session_id
        const babysitterId = `opencode-${Date.now()}-${
          Math.random().toString(36).slice(2, 10)
        }`

        await $`mkdir -p ${stateDir}`.quiet()
        await execBabysitter([
          "session:init",
          "--session-id", babysitterId,
          "--state-dir", stateDir,
          "--json",
        ])

        sessions.set(ocId, createSessionState(babysitterId))
        persistSessions(sessions, directory)
      }

      if (event.type === "session.deleted") {
        sessions.delete(event.properties.session_id)
        persistSessions(sessions, directory)
      }
    },

    // -----------------------------------------------------------------------
    // Stop hook: core orchestration loop driver
    // -----------------------------------------------------------------------
    stop: async (input) => {
      const state = sessions.get(input.sessionID)
      if (!state || !state.runDir || state.completed) return

      // --- Iteration guard: check with babysitter CLI ---
      const guardResult = await execBabysitter([
        "session:check-iteration",
        "--session-id", state.babysitterId,
        "--state-dir", stateDir,
        "--json",
      ])

      if (!guardResult.ok) {
        await client.app.log({
          body: { level: "error", message: `Guard check failed: ${guardResult.stderr}` }
        })
        state.completed = true
        persistSessions(sessions, directory)
        return
      }

      const guard = JSON.parse(guardResult.stdout)
      if (!guard.shouldContinue) {
        await client.app.log({
          body: { level: "warn", message: `Stopping: ${guard.reason}` }
        })
        state.completed = true
        persistSessions(sessions, directory)
        return
      }

      // --- Runaway detection ---
      if (isRunaway(state)) {
        await client.app.log({
          body: {
            level: "error",
            message: `Runaway detected: ${state.fastIterationCount} consecutive iterations ` +
              `under ${CONFIG.MIN_ITERATION_INTERVAL_MS}ms each. Halting.`,
          }
        })
        state.completed = true
        persistSessions(sessions, directory)
        return
      }

      // --- Iterate: advance the orchestration ---
      const iterResult = await execBabysitter(["run:iterate", state.runDir, "--json"])
      if (!iterResult.ok) {
        await client.app.log({
          body: { level: "error", message: `run:iterate failed: ${iterResult.stderr}` }
        })
        state.completed = true
        persistSessions(sessions, directory)
        return
      }

      const iter = JSON.parse(iterResult.stdout)

      if (iter.status === "completed") {
        await client.app.log({
          body: { level: "info", message: `Run completed. Proof: ${iter.completionProof ?? "none"}` }
        })
        state.completed = true
        persistSessions(sessions, directory)
        return
      }

      if (iter.status === "failed") {
        await client.app.log({
          body: { level: "error", message: `Run failed: ${iter.error ?? "unknown error"}` }
        })
        state.completed = true
        persistSessions(sessions, directory)
        return
      }

      // --- List pending tasks ---
      const taskResult = await execBabysitter([
        "task:list", state.runDir, "--pending", "--json",
      ])

      if (!taskResult.ok) {
        await client.app.log({
          body: { level: "error", message: `task:list failed: ${taskResult.stderr}` }
        })
        return
      }

      const { tasks } = JSON.parse(taskResult.stdout)
      if (tasks.length === 0) return // No pending tasks, allow exit

      // --- Handle breakpoints ---
      const breakpointTasks = tasks.filter(
        (t: { kind: string }) => t.kind === "breakpoint"
      )
      if (breakpointTasks.length > 0) {
        const bp = breakpointTasks[0]
        state.breakpointPending = true
        state.pendingBreakpointEffectId = bp.effectId

        // In TUI mode, alert the user
        try {
          // tui.showToast is available in TUI mode only
          await client.app.log({
            body: {
              level: "warn",
              message: `BREAKPOINT: "${bp.title}" (effect ${bp.effectId}). ` +
                `Use babysitter_breakpoint_resolve tool to approve or reject.`,
            }
          })
        } catch {
          // Not in TUI mode -- log only
        }
      }

      state.iteration++
      persistSessions(sessions, directory)

      // --- Send continuation prompt ---
      await client.session.prompt({
        path: { id: input.sessionID },
        body: {
          parts: [{
            type: "text",
            text: buildPrompt(state.iteration, state.runDir, iter.status, tasks),
          }],
        },
      })
    },

    // -----------------------------------------------------------------------
    // Preserve state across context compaction
    // -----------------------------------------------------------------------
    "experimental.session.compacting": async (_input, output) => {
      for (const [, state] of sessions) {
        if (state.runDir && !state.completed) {
          output.context.push(
            `<babysitter-state>Session=${state.babysitterId} ` +
            `Run=${state.runId} Dir=${state.runDir} ` +
            `Iteration=${state.iteration}` +
            `${state.breakpointPending ? ` BreakpointPending=${state.pendingBreakpointEffectId}` : ""}` +
            `</babysitter-state>`
          )
        }
      }
    },

    // -----------------------------------------------------------------------
    // Inject skill awareness into system prompt
    // -----------------------------------------------------------------------
    "experimental.chat.system.transform": async (_input, output) => {
      output.system.push(
        `<babysitter-context>` +
        `Babysitter orchestration is active. Use babysitter_* tools to interact with runs and tasks. ` +
        `For breakpoints, use babysitter_breakpoint_resolve to approve or reject.` +
        `</babysitter-context>`
      )
    },
  }
}
```

---

### 4b. Strategy B -- External Wrapper

The external wrapper script implements the complete orchestration loop outside
OpenCode, using `opencode run` for each iteration.

**Prerequisites:**

```bash
#!/usr/bin/env bash
set -euo pipefail

SDK_VERSION="${BABYSITTER_SDK_VERSION:-latest}"

install_babysitter() {
  if command -v babysitter &>/dev/null; then
    return 0
  fi

  echo "Installing babysitter SDK v${SDK_VERSION}..."
  npm install -g "@a5c-ai/babysitter-sdk@${SDK_VERSION}" 2>/dev/null || \
  npm install -g "@a5c-ai/babysitter-sdk@${SDK_VERSION}" \
    --prefix "$HOME/.local" 2>/dev/null

  export PATH="$HOME/.local/bin:$PATH"
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

**Complete integrated wrapper:**

```typescript
// babysitter-opencode-orchestrator.ts
// Usage: npx tsx babysitter-opencode-orchestrator.ts \
//   --process-id my-process \
//   --entry ./process.js#process \
//   --inputs ./inputs.json \
//   --prompt "Build the feature"

import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { randomBytes } from "node:crypto"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"

const execFileAsync = promisify(execFile)

// Configuration -- all constants read from env with documented defaults
const CONFIG = {
  MAX_ITERATIONS: parseInt(process.env.BABYSITTER_MAX_ITERATIONS ?? "256", 10),
  MIN_ITERATION_INTERVAL_MS: parseInt(process.env.BABYSITTER_MIN_ITERATION_MS ?? "2000", 10),
  MAX_FAST_ITERATIONS: parseInt(process.env.BABYSITTER_MAX_FAST_ITERS ?? "5", 10),
  RUN_TIMEOUT_MS: parseInt(process.env.BABYSITTER_TIMEOUT ?? "120000", 10),
  NODE_TASK_TIMEOUT_MS: parseInt(process.env.BABYSITTER_NODE_TASK_TIMEOUT ?? "900000", 10),
} as const

interface IterateResult {
  status: string
  completionProof?: string
  error?: string
}

interface CheckResult {
  found: boolean
  shouldContinue: boolean
  reason?: string
}

interface TaskEntry {
  effectId: string
  kind: string
  title: string
  status: string
}

interface TaskListResult {
  tasks: TaskEntry[]
}

async function babysitter(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("babysitter", args, {
    timeout: CONFIG.RUN_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
  })
  return stdout
}

async function opencodeRun(prompt: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "opencode",
      ["run", prompt, "--format", "json"],
      { timeout: CONFIG.NODE_TASK_TIMEOUT_MS, maxBuffer: 50 * 1024 * 1024 },
    )
    return stdout
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string }
    console.error(`opencode run error: ${e.stderr ?? "unknown"}`)
    return e.stdout ?? ""
  }
}

/**
 * Detect runaway behavior: if multiple iterations complete in under
 * CONFIG.MIN_ITERATION_INTERVAL_MS each, the agent is likely looping
 * without making progress.
 */
function isRunaway(
  lastTime: number | undefined,
  fastCount: number,
): { runaway: boolean; fastCount: number } {
  if (!lastTime) return { runaway: false, fastCount: 0 }
  const elapsed = Date.now() - lastTime
  if (elapsed < CONFIG.MIN_ITERATION_INTERVAL_MS) {
    const newCount = fastCount + 1
    return { runaway: newCount >= CONFIG.MAX_FAST_ITERATIONS, fastCount: newCount }
  }
  return { runaway: false, fastCount: 0 }
}

function buildPrompt(
  iteration: number,
  runDir: string,
  status: string,
  tasks: TaskEntry[],
): string {
  const taskDescriptions = tasks
    .map(t => `- Effect ${t.effectId}: kind=${t.kind}, title="${t.title}"`)
    .join("\n")

  // Separate breakpoint tasks for special instructions
  const breakpointTasks = tasks.filter(t => t.kind === "breakpoint")
  const regularTasks = tasks.filter(t => t.kind !== "breakpoint")

  let prompt = `You are executing babysitter orchestration iteration ${iteration}.
Run directory: ${runDir}
Run status: ${status}

Pending tasks:
${taskDescriptions}
`

  if (regularTasks.length > 0) {
    prompt += `
For EACH regular pending task above:
1. Run: babysitter task:show ${runDir} EFFECT_ID --json
2. Execute the task based on its kind and arguments
3. Write the result to: ${runDir}/tasks/EFFECT_ID/output.json
4. Post the result: babysitter task:post ${runDir} EFFECT_ID --status ok --value ${runDir}/tasks/EFFECT_ID/output.json --json
`
  }

  if (breakpointTasks.length > 0) {
    prompt += `
BREAKPOINT TASKS (require resolution):
${breakpointTasks.map(t => `- ${t.effectId}: "${t.title}"`).join("\n")}

For each breakpoint, auto-resolve with approval:
1. Write: echo '{"approved":true,"reason":"Auto-approved in CLI mode"}' > ${runDir}/tasks/EFFECT_ID/output.json
2. Post: babysitter task:post ${runDir} EFFECT_ID --status ok --value ${runDir}/tasks/EFFECT_ID/output.json --json
`
  }

  prompt += `\nExecute all pending tasks and post all results. Output "TASKS_COMPLETE" when done.`
  return prompt
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  function getArg(flag: string): string {
    const idx = args.indexOf(flag)
    if (idx === -1 || idx + 1 >= args.length) {
      throw new Error(`Missing required argument: ${flag}`)
    }
    return args[idx + 1]
  }

  const processId = getArg("--process-id")
  const entry = getArg("--entry")
  const inputsFile = getArg("--inputs")
  const prompt = getArg("--prompt")

  const sessionId = `opencode-${Date.now()}-${randomBytes(4).toString("hex")}`
  const stateDir = ".a5c/state"
  mkdirSync(stateDir, { recursive: true })

  // 1. Initialize session
  await babysitter([
    "session:init", "--session-id", sessionId,
    "--state-dir", stateDir, "--json",
  ])

  // 2. Create run
  const createOutput = await babysitter([
    "run:create", "--process-id", processId, "--entry", entry,
    "--inputs", inputsFile, "--prompt", prompt, "--json",
  ])
  const { runId } = JSON.parse(createOutput)
  const runDir = `.a5c/runs/${runId}`

  // 3. Bind session
  await babysitter([
    "session:associate", "--session-id", sessionId,
    "--run-id", runId, "--state-dir", stateDir, "--json",
  ])

  console.log(`Session: ${sessionId}, Run: ${runId}`)

  // 4. Orchestration loop
  let iteration = 0
  let lastIterationTime: number | undefined
  let fastCount = 0

  while (iteration < CONFIG.MAX_ITERATIONS) {
    iteration++
    console.log(`\n--- Iteration ${iteration} ---`)

    // Runaway detection
    const runawayCheck = isRunaway(lastIterationTime, fastCount)
    fastCount = runawayCheck.fastCount
    if (runawayCheck.runaway) {
      console.error(
        `Runaway detected: ${fastCount} consecutive iterations ` +
        `under ${CONFIG.MIN_ITERATION_INTERVAL_MS}ms. Stopping.`
      )
      break
    }
    lastIterationTime = Date.now()

    // Check guards
    const guardOutput = await babysitter([
      "session:check-iteration", "--session-id", sessionId,
      "--state-dir", stateDir, "--json",
    ])
    const guard: CheckResult = JSON.parse(guardOutput)
    if (!guard.shouldContinue) {
      console.log(`Stopping: ${guard.reason}`)
      break
    }

    // Iterate
    const iterOutput = await babysitter(["run:iterate", runDir, "--json"])
    const iterResult: IterateResult = JSON.parse(iterOutput)

    if (iterResult.status === "completed") {
      console.log(`Run completed. Proof: ${iterResult.completionProof}`)
      break
    }
    if (iterResult.status === "failed") {
      console.error(`Run failed: ${iterResult.error ?? "unknown"}`)
      process.exitCode = 1
      break
    }

    // List pending tasks
    const taskOutput = await babysitter([
      "task:list", runDir, "--pending", "--json",
    ])
    const taskList: TaskListResult = JSON.parse(taskOutput)
    if (taskList.tasks.length === 0) {
      console.log("No pending tasks.")
      continue
    }

    // Build and execute via OpenCode
    const iterPrompt = buildPrompt(
      iteration, runDir, iterResult.status, taskList.tasks,
    )
    console.log(`Delegating ${taskList.tasks.length} tasks to OpenCode...`)
    const output = await opencodeRun(iterPrompt)
    console.log(`OpenCode output length: ${output.length} chars`)
  }

  // Cleanup
  try { rmSync(`${stateDir}/${sessionId}.md`, { force: true }) } catch { /* */ }
  console.log("\nOrchestration complete.")
}

main().catch((err) => {
  console.error(`Fatal error: ${String(err)}`)
  process.exitCode = 1
})
```

### Task Kind Handling

| Task Kind | Strategy A (Plugin) | Strategy B (Wrapper) |
|-----------|---------------------|---------------------|
| `node` | Agent uses shell tool to run Node.js script. Plugin tool can also execute directly. | OpenCode shell tool runs Node.js script per prompt instructions. |
| `breakpoint` | Plugin detects breakpoint in task list, sets `breakpointPending` state, alerts user via `client.app.log()`. Agent uses `babysitter_breakpoint_resolve` tool. In TUI mode, user can approve interactively. | Prompt instructs agent to auto-resolve breakpoints with approval. Cannot prompt user interactively. |
| `sleep` | Plugin checks time condition in stop hook. Resume when time elapsed. | Wrapper checks time condition in loop. Sleep or skip iteration. |
| `orchestrator_task` | Agent executes as sub-task within same session. | Agent executes within opencode run invocation. |
| `agent` | Create new session via `client.session.create()` + `client.session.prompt()`. | Spawn nested `opencode run` invocation. |

### Guard Summary

| Guard | Implementation | Threshold | Config Key |
|-------|---------------|-----------|------------|
| Max iterations | `session:check-iteration` CLI | 256 | `BABYSITTER_MAX_ITERATIONS` |
| Runaway velocity | `isRunaway()` function | 5 consecutive iterations under 2000ms each | `BABYSITTER_MAX_FAST_ITERS` / `BABYSITTER_MIN_ITERATION_MS` |
| Run timeout | `BABYSITTER_TIMEOUT` env var | 120000ms (2 minutes) | `BABYSITTER_TIMEOUT` |
| Hook timeout | `BABYSITTER_HOOK_TIMEOUT` env var | 30000ms (30 seconds) | `BABYSITTER_HOOK_TIMEOUT` |

---

## 5. Skills Porting

Babysitter skills (located in `plugins/babysitter/skills/`) can be exposed
to OpenCode users through custom tools and system prompt injection.

### Exposing Skills as OpenCode Custom Tools

```typescript
import { type Plugin, tool } from "@opencode-ai/plugin"
import { readFileSync, readdirSync, existsSync } from "node:fs"
import { join } from "node:path"

export const BabysitterSkillsPlugin: Plugin = async ({ $, client, directory }) => {
  const skillsDir = join(directory, "plugins/babysitter/skills")

  // Discover available skills
  function discoverSkills(): Array<{ name: string; description: string; skillMd: string }> {
    if (!existsSync(skillsDir)) return []
    return readdirSync(skillsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => {
        const skillMdPath = join(skillsDir, d.name, "SKILL.md")
        if (!existsSync(skillMdPath)) return null
        const content = readFileSync(skillMdPath, "utf-8")
        const descMatch = content.match(/^#\s+(.+)/m)
        return {
          name: d.name,
          description: descMatch?.[1] ?? d.name,
          skillMd: content,
        }
      })
      .filter(Boolean) as Array<{ name: string; description: string; skillMd: string }>
  }

  const skills = discoverSkills()

  return {
    tool: {
      babysitter_skill_list: tool({
        description: "List available babysitter skills",
        args: {},
        async execute() {
          return JSON.stringify(skills.map(s => ({
            name: s.name,
            description: s.description,
          })))
        },
      }),

      babysitter_skill_fetch: tool({
        description: "Fetch the full SKILL.md content for a babysitter skill",
        args: {
          skillName: tool.schema.string(),
        },
        async execute(args) {
          const skill = skills.find(s => s.name === args.skillName)
          if (!skill) return JSON.stringify({ error: `Skill not found: ${args.skillName}` })
          return skill.skillMd
        },
      }),

      babysitter_skill_run: tool({
        description: "Execute a babysitter skill by name with the given prompt",
        args: {
          skillName: tool.schema.string(),
          prompt: tool.schema.string(),
          processId: tool.schema.string().optional(),
        },
        async execute(args) {
          const skill = skills.find(s => s.name === args.skillName)
          if (!skill) return JSON.stringify({ error: `Skill not found: ${args.skillName}` })

          // Discover skill entry point
          const discoverResult = await $`babysitter skill:discover \
            --skill-dir ${join(skillsDir, args.skillName)} \
            --json`.quiet()

          if (discoverResult.exitCode !== 0) {
            return JSON.stringify({ error: "Failed to discover skill" })
          }

          const skillInfo = JSON.parse(discoverResult.stdout.toString())

          // Create a run using the skill's process
          const runResult = await $`babysitter run:create \
            --process-id ${args.processId ?? args.skillName} \
            --entry ${skillInfo.entrypoint} \
            --prompt ${args.prompt} \
            --json`.quiet()

          return runResult.stdout.toString()
        },
      }),
    },

    // Inject skill awareness into system prompt
    "experimental.chat.system.transform": async (_input, output) => {
      if (skills.length > 0) {
        const skillList = skills
          .map(s => `- **${s.name}**: ${s.description}`)
          .join("\n")
        output.system.push(
          `<babysitter-skills>\nAvailable babysitter skills:\n${skillList}\n` +
          `Use babysitter_skill_list and babysitter_skill_run tools to execute them.\n</babysitter-skills>`
        )
      }
    },
  }
}
```

### Porting a Skill: Before and After

**Claude Code (original -- hook-based):**

```jsonc
// .claude/settings.json
{
  "hooks": {
    "PostToolUse": [
      { "command": "babysitter session:check-iteration ..." }
    ]
  }
}
```

**OpenCode (ported -- plugin-based):**

```typescript
// .opencode/plugins/babysitter-skill.ts
import { type Plugin, tool } from "@opencode-ai/plugin"

export const MySkillPlugin: Plugin = async ({ $, client }) => {
  return {
    tool: {
      my_skill_tool: tool({
        description: "Execute the skill",
        args: { prompt: tool.schema.string() },
        async execute(args) {
          const result = await $`babysitter run:create \
            --process-id my-skill \
            --entry ./process.js#process \
            --prompt ${args.prompt} --json`.quiet()
          return result.stdout.toString()
        },
      }),
    },
    "tool.execute.after": async (input) => {
      // Equivalent to PostToolUse hook
      if (input.tool === "my_skill_tool") {
        await $`babysitter session:check-iteration ...`.quiet()
      }
    },
  }
}
```

---

## 6. OpenCode-Specific Considerations

### 6.1 Native Stop Hook Support

OpenCode is one of the few harnesses that provides a native stop hook capable
of blocking agent exit and injecting continuation context. This is the single
most important architectural advantage for babysitter integration.

The stop hook receives the session ID and can send new prompts via
`client.session.prompt()`. This eliminates the need for external wrapper
scripts in most cases.

### 6.2 Plugin Directory Structure

Plugins load from four locations (in order):

1. Global config dir: `~/.config/opencode/plugins/`
2. Project config dir: `.opencode/plugins/`
3. npm packages specified in `opencode.json`
4. Local `package.json` dependencies (auto-installed via `bun install`)

For babysitter integration, place the plugin in `.opencode/plugins/`:

```
.opencode/
  plugins/
    babysitter.ts          # Main orchestration plugin
    babysitter-skills.ts   # Skills discovery plugin (optional)
  package.json             # Dependencies (if any)
```

### 6.3 Context Compaction

OpenCode compacts the context window when it grows too large. The
`experimental.session.compacting` hook allows preserving babysitter state:

```typescript
"experimental.session.compacting": async (_input, output) => {
  const state = sessions.get(currentSessionId)
  if (state) {
    output.context.push(
      `<babysitter-state>` +
      `Session: ${state.sessionId}, Run: ${state.runId}, ` +
      `Iteration: ${state.iteration}, RunDir: ${state.runDir}` +
      `</babysitter-state>`
    )
  }
}
```

### 6.4 Server Mode for CI/CD

In headless environments, use `opencode serve` + the SDK client:

```typescript
import { createOpencodeClient } from "@opencode-ai/sdk"

const client = createOpencodeClient({ baseUrl: "http://localhost:4096" })

// Create session
const session = await client.session.create({ body: { title: "Babysitter run" } })

// Send prompt
const result = await client.session.prompt({
  path: { id: session.data.id },
  body: { parts: [{ type: "text", text: "Execute the babysitter process..." }] },
})

// Monitor via events
const events = await client.event.subscribe()
for await (const event of events.stream) {
  if (event.type === "session.idle") {
    // Check if orchestration is complete
  }
}
```

### 6.5 Structured Output for Task Results

OpenCode supports structured output via JSON schema. This can ensure task
results conform to expected shapes:

```typescript
const result = await client.session.prompt({
  path: { id: sessionId },
  body: {
    parts: [{ type: "text", text: "Execute and return the task result" }],
    format: {
      type: "json_schema",
      schema: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["ok", "error"] },
          value: {},
        },
        required: ["status", "value"],
      },
    },
  },
})

const taskResult = result.data.info.structured_output
```

### 6.6 Permissions and Tool Approval

OpenCode has a permission system for tool execution. The plugin can
auto-approve babysitter CLI calls:

```typescript
event: async ({ event }) => {
  if (event.type === "permission.asked") {
    const toolName = event.properties.tool
    if (toolName?.startsWith("babysitter_")) {
      // Auto-approve babysitter tools
      // (Implementation depends on permission API availability)
    }
  }
}
```

### 6.7 Logging

Use `client.app.log()` for structured logging visible in the OpenCode UI:

```typescript
await client.app.log({
  body: {
    level: "info",  // debug | info | warn | error
    message: "Babysitter iteration 5 completed, 3 tasks pending"
  }
})
```

---

## 7. Example Code

### 7.1 Complete Babysitter Plugin for OpenCode (Strategy A)

See [Section 4a](#4a-strategy-a----plugin-with-stop-hook) for the full
integrated plugin implementation. It includes:

- CLI installation verification
- `SessionState` interface with all dynamic properties declared
- Session lifecycle management (create, delete, persist, restore)
- Run creation and session binding via `babysitter_session_init` tool
- Stop-hook orchestration loop with iteration guards and runaway detection
- Custom tools: `babysitter_task_show`, `babysitter_task_post`,
  `babysitter_task_list`, `babysitter_run_status`, `babysitter_breakpoint_resolve`
- Breakpoint handling with `breakpointPending` state tracking
- Context compaction preservation
- System prompt injection for babysitter awareness
- Error handling with structured error responses from all tools
- Configurable constants via environment variables

### 7.2 opencode.json Configuration

```jsonc
{
  // Register babysitter as an npm plugin (alternative to local file)
  "plugin": [
    // "@a5c-ai/babysitter-opencode-plugin"  // when published
  ]

  // Or use local plugins in .opencode/plugins/ (auto-discovered)
}
```

### 7.3 Plugin package.json (for dependencies)

```json
{
  "name": "babysitter-opencode-plugins",
  "private": true,
  "dependencies": {
    "@a5c-ai/babysitter-sdk": "latest"
  }
}
```

Place this in `.opencode/package.json`. OpenCode runs `bun install` at startup
to install dependencies.

---

## 8. E2E Verification

This section provides a complete end-to-end verification example that exercises
the babysitter orchestration loop through OpenCode.

### 8.1 Minimal Process Definition for Testing

Create a simple process that requests a single task and verifies it completes:

```typescript
// e2e-test/process.ts
// A minimal babysitter process that requests one task and returns its result.

import { defineTask } from "@a5c-ai/babysitter-sdk"

const greetTask = defineTask<{ name: string }, { greeting: string }>(
  "greet",
  async (args) => {
    return { greeting: `Hello, ${args.name}!` }
  },
  {
    kind: "node",
    title: "Generate greeting",
  },
)

export async function process(
  inputs: { name: string },
  ctx: { task: typeof greetTask.dispatch },
): Promise<{ result: string }> {
  const result = await ctx.task(greetTask, { name: inputs.name })
  return { result: result.greeting }
}
```

### 8.2 Test Inputs

```json
{
  "name": "OpenCode E2E Test"
}
```

Save as `e2e-test/inputs.json`.

### 8.3 E2E Test Script

```typescript
// e2e-test/verify.ts
// Run with: npx tsx e2e-test/verify.ts

import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdirSync, writeFileSync } from "node:fs"

const exec = promisify(execFile)

async function babysitter(args: string[]): Promise<string> {
  const { stdout } = await exec("babysitter", args, { timeout: 30_000 })
  return stdout.trim()
}

async function verify(): Promise<void> {
  const stateDir = ".a5c/e2e-state"
  mkdirSync(stateDir, { recursive: true })

  console.log("Step 1: Initialize session")
  const sessionId = `e2e-${Date.now()}`
  await babysitter([
    "session:init", "--session-id", sessionId,
    "--state-dir", stateDir, "--json",
  ])

  console.log("Step 2: Create run")
  const createOut = await babysitter([
    "run:create",
    "--process-id", "e2e-greet",
    "--entry", "./e2e-test/process.ts#process",
    "--inputs", "./e2e-test/inputs.json",
    "--prompt", "E2E verification",
    "--json",
  ])
  const { runId } = JSON.parse(createOut)
  const runDir = `.a5c/runs/${runId}`
  console.log(`  Run ID: ${runId}`)

  console.log("Step 3: Associate session")
  await babysitter([
    "session:associate", "--session-id", sessionId,
    "--run-id", runId, "--state-dir", stateDir, "--json",
  ])

  console.log("Step 4: First iteration (discovers pending task)")
  const iterOut = await babysitter(["run:iterate", runDir, "--json"])
  const iter = JSON.parse(iterOut)
  console.log(`  Status: ${iter.status}`)

  console.log("Step 5: List pending tasks")
  const taskOut = await babysitter(["task:list", runDir, "--pending", "--json"])
  const { tasks } = JSON.parse(taskOut)
  console.log(`  Pending tasks: ${tasks.length}`)

  if (tasks.length === 0) {
    console.error("FAIL: Expected at least one pending task")
    process.exitCode = 1
    return
  }

  const task = tasks[0]
  console.log(`  Task: ${task.effectId} (${task.kind}) - ${task.title}`)

  console.log("Step 6: Show task definition")
  const showOut = await babysitter(["task:show", runDir, task.effectId, "--json"])
  const taskDef = JSON.parse(showOut)
  console.log(`  Args: ${JSON.stringify(taskDef.args)}`)

  console.log("Step 7: Post task result")
  const resultFile = `${runDir}/tasks/${task.effectId}/output.json`
  mkdirSync(`${runDir}/tasks/${task.effectId}`, { recursive: true })
  writeFileSync(resultFile, JSON.stringify({ greeting: "Hello, OpenCode E2E Test!" }))
  await babysitter([
    "task:post", runDir, task.effectId,
    "--status", "ok",
    "--value", resultFile,
    "--json",
  ])

  console.log("Step 8: Second iteration (should complete)")
  const iter2Out = await babysitter(["run:iterate", runDir, "--json"])
  const iter2 = JSON.parse(iter2Out)
  console.log(`  Status: ${iter2.status}`)

  if (iter2.status === "completed") {
    console.log(`  Completion proof: ${iter2.completionProof}`)
    console.log("\nPASS: E2E verification succeeded")
  } else {
    console.error(`FAIL: Expected completed, got ${iter2.status}`)
    process.exitCode = 1
  }

  console.log("\nStep 9: Verify run status")
  const statusOut = await babysitter(["run:status", runDir, "--json"])
  console.log(`  Final status: ${JSON.parse(statusOut).status}`)
}

verify().catch((err) => {
  console.error(`E2E verification error: ${String(err)}`)
  process.exitCode = 1
})
```

### 8.4 Running the E2E Test

```bash
# From the project root:
npx tsx e2e-test/verify.ts

# Expected output:
# Step 1: Initialize session
# Step 2: Create run
#   Run ID: <ulid>
# Step 3: Associate session
# Step 4: First iteration (discovers pending task)
#   Status: waiting
# Step 5: List pending tasks
#   Pending tasks: 1
#   Task: <effectId> (node) - Generate greeting
# Step 6: Show task definition
#   Args: {"name":"OpenCode E2E Test"}
# Step 7: Post task result
# Step 8: Second iteration (should complete)
#   Status: completed
#   Completion proof: <hash>
#
# PASS: E2E verification succeeded
#
# Step 9: Verify run status
#   Final status: completed
```

---

## 9. Production Deployment

### 9.1 Publishing the Plugin as an npm Package

```bash
# Directory structure for the published package:
babysitter-opencode-plugin/
  package.json
  src/
    index.ts          # Re-exports BabysitterOrchestrator
    plugin.ts         # Full plugin from Section 4a
    skills.ts         # Skills plugin from Section 5
    config.ts         # Shared CONFIG object
  dist/               # Compiled output
  README.md
```

**package.json:**

```json
{
  "name": "@a5c-ai/babysitter-opencode-plugin",
  "version": "0.1.0",
  "description": "Babysitter SDK orchestration plugin for OpenCode",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": ["dist"],
  "scripts": {
    "build": "tsc",
    "prepublishOnly": "npm run build"
  },
  "peerDependencies": {
    "@opencode-ai/plugin": ">=0.1.0"
  },
  "dependencies": {
    "@a5c-ai/babysitter-sdk": ">=0.0.170"
  },
  "keywords": ["opencode", "babysitter", "orchestration", "plugin"],
  "license": "MIT"
}
```

### 9.2 Registering in opencode.json

Once published, users add the plugin to their project configuration:

```jsonc
// opencode.json
{
  "plugin": [
    "@a5c-ai/babysitter-opencode-plugin"
  ]
}
```

### 9.3 Global Installation

For users who want babysitter orchestration in all OpenCode projects:

```bash
# Install globally
npm install -g @a5c-ai/babysitter-opencode-plugin

# Add to global OpenCode config
# ~/.config/opencode/opencode.json
{
  "plugin": [
    "@a5c-ai/babysitter-opencode-plugin"
  ]
}
```

### 9.4 CI/CD Integration

For automated pipelines, use Strategy B (external wrapper) or server mode:

```yaml
# .github/workflows/babysitter-ci.yml
name: Babysitter Orchestration
on: [push]
jobs:
  orchestrate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
      - run: npm install -g @a5c-ai/babysitter-sdk opencode
      - run: |
          opencode serve &
          sleep 2
          npx tsx babysitter-opencode-orchestrator.ts \
            --process-id my-process \
            --entry ./process.js#process \
            --inputs ./inputs.json \
            --prompt "CI run"
```

### 9.5 Version Compatibility

| Babysitter SDK | OpenCode | Plugin API | Status |
|---------------|----------|------------|--------|
| >= 0.0.170 | >= 0.1.0 | stop, event, tool | Stable |
| >= 0.0.170 | >= 0.1.0 | experimental.* | May change |

---

## 10. Troubleshooting

### Common Errors and Solutions

#### `babysitter: command not found`

**Cause:** The babysitter CLI is not installed or not in the PATH.

**Solution:**
```bash
# Check if installed
which babysitter || echo "Not found"

# Install globally
npm install -g @a5c-ai/babysitter-sdk

# Or use npx in the plugin
const result = await $`npx -y @a5c-ai/babysitter-sdk babysitter version --json`.quiet()
```

#### `ENOENT: .a5c/runs/<runId>/run.json`

**Cause:** The run directory does not exist. The run was never created, or the
`BABYSITTER_RUNS_DIR` environment variable points to a different location.

**Solution:**
```bash
# Verify BABYSITTER_RUNS_DIR
echo $BABYSITTER_RUNS_DIR  # Should be .a5c/runs or unset

# List existing runs
ls .a5c/runs/

# Recreate the run if needed
babysitter run:create --process-id my-process --entry ./process.js#process --prompt "..." --json
```

#### `Run lock held by another process`

**Cause:** A previous iteration crashed without releasing the lock, or two
instances are running against the same run directory.

**Solution:**
```bash
# Check who holds the lock
cat .a5c/runs/<runId>/run.lock

# If the PID is dead, remove the lock
rm .a5c/runs/<runId>/run.lock

# Or use repair-journal to fix inconsistencies
babysitter run:repair-journal .a5c/runs/<runId>
```

#### `session:check-iteration returns shouldContinue: false immediately`

**Cause:** The session state file is missing or corrupted, or the session was
never initialized.

**Solution:**
```bash
# Verify session state exists
ls .a5c/state/

# Re-initialize the session
babysitter session:init --session-id <id> --state-dir .a5c/state --json

# Re-associate with the run
babysitter session:associate --session-id <id> --run-id <runId> --state-dir .a5c/state --json
```

#### `Runaway detection triggered` (false positive)

**Cause:** The agent is completing iterations legitimately but quickly (e.g.,
small tasks that resolve in under 2 seconds).

**Solution:** Increase the thresholds via environment variables:
```bash
export BABYSITTER_MIN_ITERATION_MS=500    # Lower the interval threshold
export BABYSITTER_MAX_FAST_ITERS=20       # Allow more fast iterations
```

#### Plugin not loading in OpenCode

**Cause:** Plugin file is not in the correct directory or has syntax errors.

**Solution:**
```bash
# Verify plugin location
ls .opencode/plugins/babysitter.ts

# Check for syntax errors
npx tsc --noEmit .opencode/plugins/babysitter.ts

# Check OpenCode logs
opencode --verbose  # Look for plugin loading messages
```

#### `task:post` returns `EFFECT_NOT_FOUND`

**Cause:** The effect ID does not match any pending effect in the run journal.

**Solution:**
```bash
# List all effects (not just pending)
babysitter task:list .a5c/runs/<runId> --json

# Show journal events
babysitter run:events .a5c/runs/<runId> --json

# Verify the effect ID matches exactly
babysitter task:show .a5c/runs/<runId> <effectId> --json
```

#### Breakpoint hangs indefinitely in CLI mode

**Cause:** Strategy B (external wrapper) has no interactive user for breakpoint
approval, and the prompt did not include auto-resolve instructions.

**Solution:** Ensure the prompt includes breakpoint auto-resolution logic (see
Section 4b `buildPrompt` implementation), or set a breakpoint timeout:

```bash
export BABYSITTER_HOOK_TIMEOUT=60000  # 60 seconds max for breakpoint resolution
```

---

## 11. Limitations and Workarounds

### 11.1 Plugin State Not Persisted Across Restarts

**Limitation:** Plugin in-memory state (the `sessions` Map) is lost if
OpenCode restarts. The babysitter run state on disk survives, but the plugin
loses the mapping between OpenCode session IDs and babysitter session IDs.

**Workaround:** The plugin in Section 4a writes a mapping file to
`.a5c/opencode-sessions.json` on each state change and restores it on init.
The babysitter session state files in `stateDir` are the source of truth.

### 11.2 Bun Shell API Differences

**Limitation:** The `$` shell API uses Bun's shell, which has minor differences
from bash (e.g., process substitution, some glob patterns).

**Workaround:** For complex commands, use `Bun.spawn()` or `child_process`
directly. For babysitter CLI calls, simple argument passing via `$` works
reliably.

### 11.3 Breakpoints in CLI Run Mode

**Limitation:** `opencode run` does not support interactive user prompts.
Breakpoints requiring human approval cannot be handled interactively.

**Workaround:** For CLI run mode (Strategy B), the `buildPrompt()` function
includes auto-resolve instructions that tell the agent to approve breakpoints
automatically. For TUI mode (Strategy A), the plugin sets `breakpointPending`
state and alerts the user via `client.app.log()`. The agent can then use the
`babysitter_breakpoint_resolve` tool to approve or reject.

### 11.4 No Native Sub-Agent Delegation

**Limitation:** OpenCode does not have a built-in multi-agent or sub-agent
system like some other harnesses.

**Workaround:** For `orchestrator_task` and `agent` effect kinds, create a new
session via `client.session.create()` and send the task prompt via
`client.session.prompt()`. Monitor completion via `session.idle` events. This
provides functional sub-agent behavior through session management.

### 11.5 Stop Hook Timing

**Limitation:** The stop hook fires when the agent decides to stop, not on
every turn boundary. If the agent makes multiple tool calls before stopping,
the stop hook only fires once at the end.

**Workaround:** This is actually acceptable for babysitter integration. The
agent should execute all pending tasks in a single turn, then the stop hook
checks if more work remains. If the agent partially completes tasks, the next
stop-hook invocation discovers remaining pending effects.

### 11.6 Plugin API Stability

**Limitation:** Some OpenCode hooks are marked `experimental` (e.g.,
`experimental.chat.system.transform`, `experimental.session.compacting`). These
may change in future versions.

**Workaround:** Isolate experimental hook usage behind feature flags. The core
integration (stop hook, event handler, custom tools) uses stable APIs.

### 11.7 Integration Tier Achievability

| Tier | Achievability | Notes |
|------|--------------|-------|
| Tier 1 (Minimum Viable) | YES | Plugin stop hook provides native exit interception. |
| Tier 2 (Robust) | YES | All guards, breakpoints (TUI), iteration control. |
| Tier 3 (Full) | PARTIAL | Sub-agents via session creation. Some hooks experimental. |

---

## Appendix: CLI Quick Reference

| Command | Purpose | Section |
|---------|---------|---------|
| `babysitter version --json` | Verify CLI installation | 4a |
| `babysitter session:init` | Create baseline session state | 4a, 4b |
| `babysitter run:create` | Create a new run | 4a, 4b |
| `babysitter session:associate` | Bind session to run | 4a, 4b |
| `babysitter run:iterate RUNDIR --json` | Advance orchestration | 4a, 4b |
| `babysitter run:status RUNDIR --json` | Read run status and proof | 4a, 4b |
| `babysitter task:list RUNDIR --pending --json` | List pending effects | 4a, 4b |
| `babysitter task:show RUNDIR EFFECTID --json` | Read task definition | 4a, 4b |
| `babysitter task:post RUNDIR EFFECTID --status S --value F --json` | Post result | 4a, 4b |
| `babysitter session:check-iteration` | Check iteration guards | 4a, 4b |
| `babysitter run:repair-journal RUNDIR` | Fix journal inconsistencies | 10 |
| `babysitter skill:discover --skill-dir DIR --json` | Discover skill entry point | 5 |
| `opencode run "prompt"` | Non-interactive OpenCode execution | 4b |
| `opencode serve` | Start headless server | 6.4 |

---

## Appendix: Verified OpenCode APIs

The following APIs were verified against the official OpenCode documentation
as of March 2026.

### Plugin Hooks (Verified)

| Hook | Status | Source |
|------|--------|--------|
| `stop` | Verified | [Plugin docs](https://opencode.ai/docs/plugins/), [Plugin guide gist](https://gist.github.com/johnlindquist/0adf1032b4e84942f3e1050aba3c5e4a) |
| `event` (session.idle, session.created, etc.) | Verified | [Plugin docs](https://opencode.ai/docs/plugins/) |
| `tool.execute.before` / `tool.execute.after` | Verified | [Plugin docs](https://opencode.ai/docs/plugins/) |
| `experimental.chat.system.transform` | Verified (experimental) | [Plugin guide gist](https://gist.github.com/johnlindquist/0adf1032b4e84942f3e1050aba3c5e4a) |
| `experimental.session.compacting` | Verified (experimental) | [Plugin docs](https://opencode.ai/docs/plugins/) |
| Custom tools via `tool()` | Verified | [Plugin docs](https://opencode.ai/docs/plugins/) |

### SDK Client Methods (Verified)

| Method | Status | Source |
|--------|--------|--------|
| `client.session.prompt({ path, body })` | Verified | [SDK docs](https://opencode.ai/docs/sdk/) |
| `client.session.create({ body })` | Verified | [SDK docs](https://opencode.ai/docs/sdk/) |
| `client.session.list()` | Verified | [SDK docs](https://opencode.ai/docs/sdk/) |
| `client.session.get({ path })` | Verified | [SDK docs](https://opencode.ai/docs/sdk/) |
| `client.session.delete({ path })` | Verified | [SDK docs](https://opencode.ai/docs/sdk/) |
| `client.session.abort({ path })` | Verified | [SDK docs](https://opencode.ai/docs/sdk/) |
| `client.session.messages({ path })` | Verified | [SDK docs](https://opencode.ai/docs/sdk/) |
| `client.event.subscribe()` | Verified | [SDK docs](https://opencode.ai/docs/sdk/) |
| `client.app.log({ body })` | Verified | [SDK docs](https://opencode.ai/docs/sdk/) |

### Plugin Context Properties (Verified)

| Property | Status | Source |
|----------|--------|--------|
| `client` | Verified | [SDK docs](https://opencode.ai/docs/sdk/), [Plugin docs](https://opencode.ai/docs/plugins/) |
| `$` (Bun shell) | Verified | [Plugin docs](https://opencode.ai/docs/plugins/) |
| `directory` | Verified | [Plugin docs](https://opencode.ai/docs/plugins/) |
| `project` | Verified | [Plugin docs](https://opencode.ai/docs/plugins/) |
| `worktree` | Verified | [Plugin docs](https://opencode.ai/docs/plugins/) |

---

## Sources

- [OpenCode GitHub Repository](https://github.com/opencode-ai/opencode)
- [OpenCode Plugin Documentation](https://opencode.ai/docs/plugins/)
- [OpenCode SDK Documentation](https://opencode.ai/docs/sdk/)
- [OpenCode Server Documentation](https://opencode.ai/docs/server/)
- [OpenCode CLI Documentation](https://opencode.ai/docs/cli/)
- [OpenCode Plugins Guide (Gist)](https://gist.github.com/johnlindquist/0adf1032b4e84942f3e1050aba3c5e4a)
- [Awesome OpenCode](https://github.com/awesome-opencode/awesome-opencode)
