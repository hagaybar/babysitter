# OpenClaw Harness Integration Guide for Babysitter SDK

A complete integration guide for embedding the babysitter SDK orchestration loop
into the OpenClaw Gateway. OpenClaw is a Node.js daemon for personal AI that routes
messages from multiple channels (WhatsApp, Telegram, Slack, etc.) through isolated
agent sessions backed by SQLite persistence.

For the harness-agnostic reference, see
[Generic Harness Guide](../generic-harness-guide.md). For the canonical reference
implementation, see [Claude Code Integration](../claude-code-integration.md).

---

## Table of Contents

0. [Quick Start (5 minutes)](#0-quick-start-5-minutes)
1. [Prerequisites](#1-prerequisites)
2. [Core Integration Points](#2-core-integration-points)
   - [2a. SDK Installation via OpenClaw Plugin](#2a-sdk-installation-via-openclaw-plugin)
   - [2b. Session Initialization via `before_agent_start` Hook](#2b-session-initialization-via-before_agent_start-hook)
   - [2c. Run Creation and Session Binding](#2c-run-creation-and-session-binding)
   - [2d. The Orchestration Loop Driver](#2d-the-orchestration-loop-driver)
   - [2e. Effect Execution](#2e-effect-execution)
   - [2f. Result Posting](#2f-result-posting)
   - [2g. Iteration Guards](#2g-iteration-guards)
3. [Harness Capability Matrix](#3-harness-capability-matrix)
4. [Session State Contract](#4-session-state-contract)
5. [Hook Equivalence Table](#5-hook-equivalence-table)
6. [Version Compatibility Matrix](#6-version-compatibility-matrix)
7. [Testing the Integration](#7-testing-the-integration)
8. [Reference Implementation](#8-reference-implementation)
9. [Appendix A: HarnessAdapter (SDK-Internal)](#appendix-a-harnessadapter-sdk-internal)
10. [Appendix B: Complete CLI Command Reference](#appendix-b-complete-cli-command-reference)
11. [Appendix C: OpenClaw vs Claude Code Comparison](#appendix-c-openclaw-vs-claude-code-comparison)

---

## Architecture Overview

```
+---------------------------------------------------------------------+
|                      OpenClaw Gateway (Node.js Daemon)               |
|                                                                     |
|  +-----------------+  +--------------------+  +------------------+  |
|  | Channel Router  |  | Plugin Registry    |  | Session Manager  |  |
|  | (WhatsApp, TG,  |  | (npm packages w/   |  | (SQLite-backed,  |  |
|  |  Slack, etc.)   |  |  openclaw field)   |  |  per-agent)      |  |
|  +--------+--------+  +---------+----------+  +--------+---------+  |
|           |                     |                      |            |
+---------------------------------------------------------------------+
            |                     |                      |
            v                     v                      v
   +-------------------+  +------------------+  +------------------+
   | Babysitter Plugin |  | OpenClawPluginApi|  | Agent Sessions   |
   | (npm package)     |  | - registerHook   |  | - isolated ctx   |
   |                   |  | - registerCommand|  | - multi-agent    |
   | before_agent_start|  | - registerService|  | - channel-routed |
   | agent_end         |  +------------------+  +------------------+
   | tool_result_persist                                |
   +--------+----------+                                v
            |                                  +------------------+
            v                                  | Run Directory    |
   +-------------------+                       | .a5c/runs/{id}/  |
   | babysitter CLI    |                       |   journal/       |
   | (SDK npm package) |                       |   tasks/         |
   |                   |                       |   state/         |
   | session:init      |                       +------------------+
   | run:create        |
   | session:associate |
   | run:iterate       |
   | task:list         |
   | task:post         |
   | session:check-    |
   |   iteration       |
   +-------------------+
```

### End-to-End Data Flow

```
Inbound message arrives on channel (WhatsApp, Telegram, etc.)
        |
        v
  Gateway routes to agent session (SQLite-backed, per-sender)
        |
        v
  [before_agent_start hook] --> Babysitter plugin
        |                           |
        v                           v
  Session state created      babysitter session:init
  (or resumed)               creates baseline state file
        |
        v
  Agent processes message, user invokes babysit skill
        |
        v
  Plugin creates process, calls run:create + session:associate
        |
        v
  Plugin calls run:iterate, executes effects, posts results
        |
        v
  Agent completes turn --> [agent_end hook]
        |
        v
  Babysitter plugin evaluates orchestration state
        |
        +--[run incomplete]--> Re-inject context via sessions_send
        |                      Agent receives new message, continues
        |                      (back to run:iterate)
        |
        +--[run complete, proof matched]--> Allow session to end
                                           Cleanup state file
```

### OpenClaw API Verification Status

> **Important:** The OpenClaw plugin API is documented at
> [docs.openclaw.ai/tools/plugin](https://docs.openclaw.ai/tools/plugin). The
> following API surface has been verified against official documentation and
> the [openclaw/openclaw](https://github.com/openclaw/openclaw) source:
>
> | API | Status | Notes |
> |-----|--------|-------|
> | `api.registerHook(name, handler, meta)` | **Verified** | Registers event hooks |
> | `api.registerCommand(cmd)` | **Verified** | Registers slash commands |
> | `api.registerService(svc)` | **Verified** | Registers background services |
> | `api.registerGatewayMethod(name, fn)` | **Verified** | Registers Gateway RPC methods |
> | `api.registerProvider(provider)` | **Verified** | Registers auth providers |
> | `api.registerCli(fn, opts)` | **Verified** | Registers CLI commands |
> | `api.logger` | **Verified** | Logging interface |
> | `api.runtime.tts` | **Verified** | Text-to-speech helpers |
> | `sessions_send` (agent tool) | **Verified** | Sends messages to sessions; available as a sandbox-allowed tool |
> | `sessions_spawn` (agent tool) | **Verified** | Spawns sub-agent sessions; available as a sandbox-allowed tool |
>
> The following APIs used in this guide are **unverified** -- they represent
> plausible interfaces inferred from the Gateway WebSocket protocol and
> plugin patterns, but are not confirmed in official documentation. Each
> usage includes a fallback implementation using verified APIs.
>
> | API | Status | Fallback |
> |-----|--------|----------|
> | `api.sessions.send()` | **Unverified** | Use `api.registerGatewayMethod()` to invoke the `sessions_send` WS method |
> | `api.sessions.delegate()` | **Unverified** | Use `api.registerGatewayMethod()` to invoke `sessions_spawn` WS method |
> | `api.prompt()` | **Unverified** | Use `api.registerGatewayMethod()` to send a channel message and await reply |
> | `api.events.emit()` | **Unverified** | Use `api.registerHook()` to fire custom hooks |

---

## 0. Quick Start (5 minutes)

A minimal working example to verify the integration end-to-end before diving
into the full guide. This creates a session, runs a single-task process, and
confirms completion.

```bash
# 1. Install dependencies
npm install -g openclaw@latest @a5c-ai/babysitter-sdk@latest

# 2. Create a workspace
mkdir /tmp/babysitter-quickstart && cd /tmp/babysitter-quickstart
mkdir -p .a5c state

# 3. Create a minimal process file
cat > process.js << 'PROC'
exports.process = async function(inputs, ctx) {
  const result = await ctx.task('echo', { message: inputs.message });
  return { echoed: result };
};
PROC

# 4. Create inputs
echo '{"message":"hello from OpenClaw"}' > inputs.json

# 5. Initialize a session
babysitter session:init \
  --session-id quickstart-001 \
  --state-dir ./state \
  --json

# 6. Create a run and bind it to the session
RUN_ID=$(babysitter run:create \
  --process-id quickstart \
  --entry ./process.js#process \
  --inputs ./inputs.json \
  --prompt "Quick start test" \
  --json | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).runId))")

babysitter session:associate \
  --session-id quickstart-001 \
  --run-id "$RUN_ID" \
  --state-dir ./state \
  --json

# 7. Iterate to discover pending effects
babysitter run:iterate .a5c/runs/$RUN_ID --json

# 8. List pending tasks, execute, and post result
EFFECT_ID=$(babysitter task:list .a5c/runs/$RUN_ID --pending --json \
  | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).tasks[0].effectId))")

mkdir -p .a5c/runs/$RUN_ID/tasks/$EFFECT_ID
echo '{"message":"hello from OpenClaw"}' > .a5c/runs/$RUN_ID/tasks/$EFFECT_ID/output.json

babysitter task:post .a5c/runs/$RUN_ID $EFFECT_ID \
  --status ok \
  --value tasks/$EFFECT_ID/output.json \
  --json

# 9. Re-iterate to confirm completion
babysitter run:iterate .a5c/runs/$RUN_ID --json
# Expected: { "status": "completed", "completionProof": "..." }

echo "Quick start complete!"
```

If the final `run:iterate` returns `"status": "completed"`, the SDK integration
is working. Proceed to the full guide below for daemon-based orchestration,
hook registration, and multi-iteration loop setup.

---

## 1. Prerequisites

### OpenClaw-Specific Requirements

- [ ] **REQUIRED: OpenClaw Gateway v0.40+** -- Daemon must be running. Install via
  `npm install -g openclaw@latest` then `openclaw onboard --install-daemon`.

- [ ] **REQUIRED: Node.js >= 22** -- OpenClaw requires Node 22+. The babysitter SDK
  requires Node >= 18, so the OpenClaw requirement subsumes it.

- [ ] **REQUIRED: Plugin registration** -- The babysitter plugin must be registered
  as an npm package with the `openclaw` field in `package.json` and loaded by the
  Gateway.

- [ ] **REQUIRED: Hook access** -- The plugin must register `before_agent_start` and
  `agent_end` hooks via `api.registerHook()`. These are the primary orchestration
  control points.

- [ ] **REQUIRED: Sessions API access** -- The plugin must be able to send messages
  back into the agent session. The verified mechanism is via the Gateway's
  `sessions_send` WebSocket method (see fallback pattern in Section 2d).

- [ ] **REQUIRED: File system access** -- Read/write to the workspace directory for
  run directories (`.a5c/runs/`) and session state files.

- [ ] **RECOMMENDED: `tool_result_persist` hook** -- Enables interception of tool
  results for completion proof scanning without transcript parsing.

- [ ] **RECOMMENDED: MCP tool registration** -- Expose babysitter operations as MCP
  tools via `@modelcontextprotocol/sdk` for native agent integration.

### Environment Setup

```bash
# Install OpenClaw globally
npm install -g openclaw@latest

# Install the babysitter SDK
npm install -g @a5c-ai/babysitter-sdk@latest

# Verify both CLIs
openclaw --version
babysitter version --json
```

### Configuration Files

OpenClaw uses two configuration layers:

| File | Scope | Purpose |
|------|-------|---------|
| `openclaw.json` | Project/workspace | Channel routing, plugin registration, workspace settings |
| `~/.openclaw/openclaw.json` | Global | Gateway config, default model, daemon settings |

---

## 2. Core Integration Points

### 2a. SDK Installation via OpenClaw Plugin

**Goal:** Package the babysitter SDK as an OpenClaw plugin so the Gateway loads it
automatically on startup.

#### Plugin Package Structure

```
@a5c-ai/openclaw-babysitter/
  package.json          # OpenClaw plugin manifest
  tsconfig.json         # TypeScript config
  src/
    index.ts            # Plugin entry point (OpenClawPluginApi consumer)
    hooks.ts            # Hook handlers (before_agent_start, agent_end, etc.)
    guards.ts           # Consolidated iteration guard logic
    effects.ts          # Effect execution logic
    sessions.ts         # Session messaging abstraction (with fallback)
    mcp-tools.ts        # MCP tool definitions (optional)
  skills/
    babysit/
      SKILL.md          # Skill definition with YAML frontmatter
      state/            # Session state files
      process/          # Process definitions
```

#### package.json with `openclaw` Field

```json
{
  "name": "@a5c-ai/openclaw-babysitter",
  "version": "1.0.0",
  "description": "Babysitter SDK orchestration plugin for OpenClaw Gateway",
  "license": "MIT",
  "openclaw": {
    "name": "babysitter",
    "displayName": "Babysitter Orchestrator",
    "description": "Multi-iteration process orchestration for OpenClaw agents",
    "hooks": [
      "before_agent_start",
      "agent_end",
      "tool_result_persist"
    ],
    "skills": [
      {
        "name": "babysitter",
        "file": "skills/babysit/SKILL.md"
      }
    ]
  },
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "clean": "rimraf dist",
    "lint": "eslint \"src/**/*.ts\" --max-warnings=0",
    "prepublishOnly": "npm run build"
  },
  "dependencies": {
    "@a5c-ai/babysitter-sdk": "^0.0.170",
    "@modelcontextprotocol/sdk": "^1.12.1"
  },
  "devDependencies": {
    "@types/node": "^22.15.0",
    "eslint": "^9.28.0",
    "openclaw": "^0.40.0",
    "rimraf": "^6.0.1",
    "typescript": "^5.8.3"
  },
  "peerDependencies": {
    "openclaw": ">=0.40.0"
  },
  "engines": {
    "node": ">=22.0.0"
  }
}
```

#### Plugin Entry Point

```typescript
// src/index.ts
import type { OpenClawPluginApi } from 'openclaw';
import { registerHooks } from './hooks.js';
import { registerMcpTools } from './mcp-tools.js';

export default function activate(api: OpenClawPluginApi): void {
  const pluginRoot = api.pluginRoot;
  const stateDir = `${pluginRoot}/skills/babysit/state`;

  // Register lifecycle hooks
  registerHooks(api, { pluginRoot, stateDir });

  // Optionally expose babysitter operations as MCP tools
  registerMcpTools(api, { pluginRoot, stateDir });
}
```

#### Skill Definition (SKILL.md)

```markdown
---
name: babysitter
description: Multi-iteration process orchestration
version: 1.0.0
registry: clawhub
tags:
  - orchestration
  - process
  - automation
---

# Babysitter Orchestration Skill

When the user asks you to babysit a task, follow the orchestration loop:

1. Create a run with `babysitter run:create`
2. Bind the session with `babysitter session:associate`
3. Iterate with `babysitter run:iterate`
4. Execute pending effects
5. Post results with `babysitter task:post`
6. When complete, output the completion proof in `<promise>` tags
```

#### SDK Installation Verification

```typescript
// src/install.ts
import { execSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SDK_VERSION = '0.0.170';

export function ensureBabysitterCli(pluginRoot: string): string {
  const markerFile = path.join(pluginRoot, '.babysitter-install-attempted');

  // Check if already on PATH
  try {
    execSync('babysitter version --json', { stdio: 'pipe' });
    return 'babysitter';
  } catch {
    // Not found, continue
  }

  if (!existsSync(markerFile)) {
    try {
      execSync(`npm install -g @a5c-ai/babysitter-sdk@${SDK_VERSION}`, {
        stdio: 'pipe',
      });
    } catch {
      try {
        execSync(
          `npm install -g @a5c-ai/babysitter-sdk@${SDK_VERSION} --prefix $HOME/.local`,
          { stdio: 'pipe' }
        );
      } catch {
        // Fall through to npx
      }
    }
    writeFileSync(markerFile, 'attempted');
  }

  // Verify again after install
  try {
    execSync('babysitter version --json', { stdio: 'pipe' });
    return 'babysitter';
  } catch {
    // Final fallback: npx
    return `npx -y @a5c-ai/babysitter-sdk@${SDK_VERSION} babysitter`;
  }
}
```

---

### 2b. Session Initialization via `before_agent_start` Hook

**Goal:** Create a baseline session state file each time an agent session starts so
the orchestration loop can track iterations from the outset.

#### OpenClaw Hook Registration

```typescript
// src/hooks.ts
import type { OpenClawPluginApi } from 'openclaw';
import { execSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { ensureBabysitterCli } from './install.js';
import { evaluateAndContinue } from './guards.js';
import { handleToolResultPersist } from './effects.js';

interface HookConfig {
  pluginRoot: string;
  stateDir: string;
}

export function registerHooks(
  api: OpenClawPluginApi,
  config: HookConfig
): void {
  const { stateDir } = config;
  const cli = ensureBabysitterCli(config.pluginRoot);

  // --- before_agent_start: Initialize session state ---
  api.registerHook('before_agent_start', async (context) => {
    const sessionId = context.session.id;
    const stateFile = `${stateDir}/${sessionId}.md`;

    mkdirSync(stateDir, { recursive: true });

    // Idempotent: do not overwrite existing state (survives daemon restarts)
    if (existsSync(stateFile)) {
      api.logger.debug('babysitter: resuming existing session state', {
        sessionId,
      });
      return;
    }

    try {
      const result = execSync(
        `${cli} session:init` +
        ` --session-id "${sessionId}"` +
        ` --state-dir "${stateDir}"` +
        ` --json`,
        { encoding: 'utf-8', timeout: 10_000 }
      );
      const parsed = JSON.parse(result);
      api.logger.debug('babysitter session:init', { sessionId, result: parsed });
    } catch (err) {
      api.logger.warn('babysitter session:init failed', { sessionId, error: err });
    }
  }, { name: 'babysitter:session-init', description: 'Initialize babysitter session state' });

  // --- agent_end: Evaluate orchestration state ---
  api.registerHook('agent_end', async (context) => {
    await evaluateAndContinue(api, cli, config, context);
  }, { name: 'babysitter:agent-end', description: 'Evaluate orchestration state and continue if needed' });

  // --- tool_result_persist: Scan for completion proof ---
  api.registerHook('tool_result_persist', async (context) => {
    await handleToolResultPersist(api, config, context);
  }, { name: 'babysitter:tool-result', description: 'Scan tool results for completion proof' });
}
```

#### What `session:init` Creates

A session state file at `{stateDir}/{sessionId}.md`. See
[Section 4: Session State Contract](#4-session-state-contract) for the full
field reference and state transition diagram.

#### OpenClaw Session ID Mapping

OpenClaw provides session identifiers through its session manager. The mapping:

| OpenClaw Concept | Babysitter Concept | Notes |
|-----------------|-------------------|-------|
| `context.session.id` | `--session-id` | Unique per sender/channel/agent combination |
| `context.session.workspace` | Run directory root | `.a5c/runs/` within the workspace |
| `context.agent.id` | (metadata) | Stored in run metadata for multi-agent routing |

---

### 2c. Run Creation and Session Binding

**Goal:** Create a babysitter run and bind it to the current OpenClaw session when
the user requests orchestrated execution.

#### Run Creation Function

```typescript
// src/orchestration.ts
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

interface CreateRunOptions {
  cli: string;
  processId: string;
  entryPoint: string;
  inputs: Record<string, unknown>;
  prompt: string;
  sessionId: string;
  stateDir: string;
  workspaceDir: string;
}

interface RunInfo {
  runId: string;
  runDir: string;
}

export function createAndBindRun(options: CreateRunOptions): RunInfo {
  const {
    cli, processId, entryPoint, inputs,
    prompt, sessionId, stateDir, workspaceDir,
  } = options;

  // Write inputs to a temporary file
  const inputsFile = path.join(workspaceDir, '.a5c', 'tmp-inputs.json');
  writeFileSync(inputsFile, JSON.stringify(inputs));

  // Step 1: Create the run
  const createResult = execSync(
    `${cli} run:create` +
    ` --process-id "${processId}"` +
    ` --entry "${entryPoint}"` +
    ` --inputs "${inputsFile}"` +
    ` --prompt "${prompt.replace(/"/g, '\\"')}"` +
    ` --json`,
    { encoding: 'utf-8', cwd: workspaceDir, timeout: 30_000 }
  );
  const { runId } = JSON.parse(createResult);
  const runDir = path.join('.a5c', 'runs', runId);

  // Step 2: Bind session to run
  execSync(
    `${cli} session:associate` +
    ` --session-id "${sessionId}"` +
    ` --run-id "${runId}"` +
    ` --state-dir "${stateDir}"` +
    ` --json`,
    { encoding: 'utf-8', cwd: workspaceDir, timeout: 10_000 }
  );

  return { runId, runDir };
}
```

#### Re-entrant Run Prevention

If a session is already bound to a different run, `session:associate` will fail.
The OpenClaw plugin should handle this by:

1. Checking for an existing `run_id` in the session state file
2. If the existing run is complete (check via `run:status`), cleaning up the state
   file and proceeding
3. If the existing run is still active, returning an error to the agent

```typescript
import { readFileSync, existsSync } from 'node:fs';

function checkExistingRun(
  cli: string,
  stateDir: string,
  sessionId: string,
  workspaceDir: string
): string | null {
  const stateFile = path.join(stateDir, `${sessionId}.md`);
  if (!existsSync(stateFile)) return null;

  const content = readFileSync(stateFile, 'utf-8');
  const match = content.match(/run_id:\s*"([^"]+)"/);
  if (!match || !match[1]) return null;

  const existingRunId = match[1];
  try {
    const statusResult = execSync(
      `${cli} run:status .a5c/runs/${existingRunId} --json`,
      { encoding: 'utf-8', cwd: workspaceDir, timeout: 10_000 }
    );
    const status = JSON.parse(statusResult);
    if (status.status === 'completed' || status.status === 'failed') {
      // Old run is done, safe to rebind
      return null;
    }
    return existingRunId; // Still active
  } catch {
    return null; // Run directory missing, safe to rebind
  }
}
```

---

> **CRITICAL: Unverified APIs ahead.** Sections 2d through 2g use several
> OpenClaw APIs that have **not been verified** against official documentation.
> Specifically: `api.sessions.send()`, `api.sessions.delegate()`,
> `api.prompt()`, and `api.events.emit()` are inferred from the Gateway
> WebSocket protocol and plugin patterns. Every usage below includes a
> fallback implementation using **only verified APIs** (`api.registerHook()`,
> `api.registerGatewayMethod()`, `api.registerCommand()`, `sessions_send`,
> `sessions_spawn`). If you encounter `TypeError: ... is not a function` at
> runtime, switch to the fallback path. See the
> [API Verification Status](#openclaw-api-verification-status) table in the
> Architecture Overview for the complete verified/unverified breakdown.

### 2d. The Orchestration Loop Driver

**Goal:** Convert OpenClaw's agent turn model into a multi-iteration orchestration
loop by intercepting the `agent_end` hook and re-injecting context via the
Gateway's session messaging.

This is the most critical and complex integration point.

#### Architecture: Daemon-Based Loop

Unlike Claude Code's single-process stop hook, OpenClaw runs as a long-lived daemon.
The orchestration loop is driven by the `agent_end` hook combined with the Gateway's
session messaging for context re-injection.

```
+------------------------------------------------------------------+
|                 OPENCLAW ORCHESTRATION LOOP                        |
|                                                                  |
|  Agent processes inbound message                                  |
|       |                                                          |
|       v                                                          |
|  Agent completes turn (agent_end fires)                           |
|       |                                                          |
|       v                                                          |
|  +--[evaluateAndContinue()]-+                                     |
|  |                          |                                     |
|  |  1. checkGuards()        |   (consolidated guard logic,        |
|  |     - no state file      |    see Section 2g)                  |
|  |     - max iterations     |                                     |
|  |     - runaway speed      |                                     |
|  |     - no run bound       |                                     |
|  |                          |                                     |
|  |  2. loadRunStatus()      |                                     |
|  |                          |                                     |
|  |  3. checkCompletion()    |                                     |
|  |                          |                                     |
|  |  4. advanceIteration()   |                                     |
|  |                          |                                     |
|  |  5. reinjectContext()    |                                     |
|  +----+-----------+---------+                                     |
|       |           |                                                |
|  [DONE]      [CONTINUE]                                           |
|       |           |                                                |
|       v           v                                                |
|  Cleanup    Send message via sendSessionMessage()                 |
|  state      (uses Gateway WS method or api.sessions.send)        |
|  file           |                                                  |
|                 v                                                  |
|            Agent receives new message                              |
|            (back to top)                                           |
|                                                                  |
+------------------------------------------------------------------+
```

#### Session Messaging Abstraction

The `sessions.send()` method is **unverified** in official OpenClaw plugin
documentation. The following abstraction provides a fallback using the verified
Gateway WebSocket protocol (`sessions_send` method).

```typescript
// src/sessions.ts
import type { OpenClawPluginApi } from 'openclaw';

interface SessionMessage {
  role: 'system' | 'user';
  content: string;
  metadata?: Record<string, unknown>;
}

type GatewayMethod = 'sessions_send' | 'sessions_spawn';

/**
 * Unified Gateway method invoker. Probes for the direct (unverified) API
 * first, then falls back to the verified Gateway RPC path, then to a
 * CLI/HTTP fallback. All session-related communication flows through this
 * single function to avoid duplicated probe logic.
 *
 * @param api        - OpenClaw plugin API handle
 * @param method     - Gateway WS method name (sessions_send | sessions_spawn)
 * @param payload    - Method-specific payload
 * @returns          - The result from the Gateway method, or an error object
 */
async function invokeGatewayMethod(
  api: OpenClawPluginApi,
  method: GatewayMethod,
  payload: Record<string, unknown>
): Promise<unknown> {
  // Attempt 1: Direct sessions API (unverified -- may not exist)
  const apiAny = api as Record<string, unknown>;
  if (typeof apiAny.sessions === 'object' && apiAny.sessions !== null) {
    const sessions = apiAny.sessions as Record<string, unknown>;
    const directMethod = method === 'sessions_send' ? 'send' : 'delegate';
    if (typeof sessions[directMethod] === 'function') {
      return await (sessions[directMethod] as Function)(payload);
    }
  }

  // Attempt 2: Gateway RPC via runtime.callGatewayMethod (verified pattern)
  if (typeof apiAny.runtime === 'object' && apiAny.runtime !== null) {
    const runtime = apiAny.runtime as Record<string, unknown>;
    if (typeof runtime.callGatewayMethod === 'function') {
      return await (runtime.callGatewayMethod as Function)(method, payload);
    }
  }

  // Attempt 3: CLI/HTTP fallback via the Gateway REST API
  const { execSync } = await import('node:child_process');
  const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL ?? 'http://127.0.0.1:18789';
  const endpoint = method === 'sessions_send'
    ? `${gatewayUrl}/api/sessions/${payload.sessionId}/send`
    : `${gatewayUrl}/api/sessions/spawn`;
  const result = execSync(
    `curl -s -X POST "${endpoint}" ` +
    `-H "Content-Type: application/json" ` +
    `-d '${JSON.stringify(payload).replace(/'/g, "'\\''")}'`,
    { encoding: 'utf-8', timeout: 10_000 }
  );
  try {
    return JSON.parse(result);
  } catch {
    return { raw: result };
  }
}

/**
 * Send a message to an agent session. Routes through the unified
 * invokeGatewayMethod() dispatcher.
 */
export async function sendSessionMessage(
  api: OpenClawPluginApi,
  sessionId: string,
  message: SessionMessage
): Promise<void> {
  await invokeGatewayMethod(api, 'sessions_send', {
    sessionId,
    message: { role: message.role, content: message.content },
    metadata: message.metadata,
  });
}

/**
 * Spawn a sub-agent session for delegation. Routes through the unified
 * invokeGatewayMethod() dispatcher.
 */
export async function spawnDelegateSession(
  api: OpenClawPluginApi,
  options: { agentId: string; message: string; timeout: number }
): Promise<{ output?: unknown; error?: string }> {
  const result = await invokeGatewayMethod(api, 'sessions_spawn', {
    agentId: options.agentId,
    message: options.message,
    timeout: options.timeout,
  });
  if (result && typeof result === 'object' && 'error' in result) {
    return result as { error: string };
  }
  return { output: result };
}
```

#### The `agent_end` Handler (Decomposed)

The orchestration evaluation is split into focused functions for readability
and testability:

```typescript
// src/guards.ts
import type { OpenClawPluginApi } from 'openclaw';
import { execSync } from 'node:child_process';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { sendSessionMessage } from './sessions.js';

interface HookConfig {
  pluginRoot: string;
  stateDir: string;
}

interface AgentEndContext {
  session: {
    id: string;
    lastAssistantMessage?: string;
  };
  agent: { id: string };
}

// --- Session state types ---
// CANONICAL REFERENCE: See Section 4 "Session State Contract" for the
// authoritative field definitions, types, defaults, and state transitions.
// This interface MUST stay in sync with that table.

interface SessionState {
  active: boolean;
  iteration: number;
  maxIterations: number;
  runId: string;
  startedAt: string;
  lastIterationAt: string;
  iterationTimes: number[];
  prompt: string;
  _lastPromiseValue?: string;
}

interface GuardResult {
  shouldContinue: boolean;
  reason?: string;
}

// --- Consolidated guard logic (single implementation) ---

function checkGuards(state: SessionState): GuardResult {
  // Guard 1: Max iterations
  if (state.iteration >= state.maxIterations) {
    return { shouldContinue: false, reason: 'max_iterations' };
  }

  // Guard 2: Runaway loop detection
  if (state.iteration >= 5 && state.iterationTimes.length >= 3) {
    const avg =
      state.iterationTimes.reduce((a, b) => a + b, 0) /
      state.iterationTimes.length;
    if (avg <= 15) {
      return { shouldContinue: false, reason: 'runaway_loop' };
    }
  }

  // Guard 3: No run bound
  if (!state.runId) {
    return { shouldContinue: false, reason: 'no_run_bound' };
  }

  return { shouldContinue: true };
}

// --- Run status loading ---

function loadRunStatus(
  cli: string,
  runId: string
): Record<string, unknown> | null {
  try {
    const statusResult = execSync(
      `${cli} run:status .a5c/runs/${runId} --json`,
      { encoding: 'utf-8', timeout: 30_000 }
    );
    return JSON.parse(statusResult);
  } catch {
    return null;
  }
}

// --- Completion proof checking ---

function checkCompletionProof(
  runStatus: Record<string, unknown>,
  lastAssistantMessage: string
): boolean {
  if (runStatus.status !== 'completed') return false;

  const proof = runStatus.completionProof as string;
  const promiseValue = extractPromiseTag(lastAssistantMessage);
  return !!(promiseValue && promiseValue === proof);
}

// --- Iteration advancement ---

function advanceIteration(
  stateFile: string,
  state: SessionState
): { newIteration: number } {
  const newIteration = state.iteration + 1;
  updateSessionState(stateFile, {
    iteration: newIteration,
    lastIterationAt: new Date().toISOString(),
    iterationTimes: updateIterationTimes(
      state.iterationTimes,
      state.lastIterationAt,
      new Date().toISOString()
    ),
  });
  return { newIteration };
}

// --- Top-level orchestration evaluator ---

export async function evaluateAndContinue(
  api: OpenClawPluginApi,
  cli: string,
  config: HookConfig,
  context: AgentEndContext
): Promise<void> {
  const { stateDir } = config;
  const sessionId = context.session.id;
  const stateFile = `${stateDir}/${sessionId}.md`;

  // No state file means no active loop
  if (!existsSync(stateFile)) return;

  const state = parseSessionState(stateFile);
  const guardResult = checkGuards(state);

  if (!guardResult.shouldContinue) {
    cleanupStateFile(stateFile);
    api.logger.info('babysitter: stopping', {
      sessionId,
      reason: guardResult.reason,
    });
    return;
  }

  // Load run status
  const runStatus = loadRunStatus(cli, state.runId);
  if (!runStatus) {
    cleanupStateFile(stateFile);
    api.logger.warn('babysitter: run status unreadable', {
      sessionId,
      runId: state.runId,
    });
    return;
  }

  // Check completion proof
  if (checkCompletionProof(runStatus, context.session.lastAssistantMessage ?? '')) {
    cleanupStateFile(stateFile);
    api.logger.info('babysitter: completion proof matched', { sessionId });
    return;
  }

  // Advance iteration and re-inject context
  const { newIteration } = advanceIteration(stateFile, state);
  const iterationMessage = buildIterationMessage(runStatus, state, newIteration);

  await sendSessionMessage(api, sessionId, {
    role: 'system',
    content: iterationMessage,
    metadata: {
      source: 'babysitter',
      iteration: newIteration,
      maxIterations: state.maxIterations,
      runId: state.runId,
    },
  });
}
```

#### Context Re-injection

The `sendSessionMessage()` abstraction (see `src/sessions.ts` above) is the
mechanism for re-injecting orchestration context. This is the daemon-based
equivalent of Claude Code's stop hook `block` decision with a `reason` field.

| Claude Code Concept | OpenClaw Equivalent |
|--------------------|--------------------|
| Stop hook `block` decision | `agent_end` hook + `sendSessionMessage()` |
| Stop hook `approve` decision | `agent_end` hook returns without re-injection |
| `reason` field (context) | `content` field of the session message |
| `systemMessage` | `metadata` field on the session message |

#### Building the Iteration Message

```typescript
function buildIterationMessage(
  runStatus: Record<string, unknown>,
  state: SessionState,
  iteration: number
): string {
  let instructions: string;

  switch (runStatus.status) {
    case 'completed':
      instructions =
        "Run completed! To finish: call 'babysitter run:status " +
        `.a5c/runs/${state.runId} --json', extract 'completionProof', ` +
        'output in <promise>SECRET</promise> tags.';
      break;
    case 'waiting':
      instructions =
        `Waiting on pending effects. Check pending tasks with ` +
        `'babysitter task:list .a5c/runs/${state.runId} --pending --json', ` +
        `execute them, then call 'babysitter run:iterate .a5c/runs/${state.runId} --json'.`;
      break;
    case 'failed':
      instructions =
        'Run failed. Inspect the error, fix the run/journal/process and proceed.';
      break;
    default:
      instructions =
        `Continue orchestration: 'babysitter run:iterate .a5c/runs/${state.runId} --json'.`;
      break;
  }

  return `Babysitter iteration ${iteration}/${state.maxIterations} [${runStatus.status}]\n\n` +
    `${instructions}\n\n${state.prompt}`;
}
```

#### Detecting the Completion Proof

```typescript
function extractPromiseTag(text: string): string | null {
  const match = text.match(/<promise>([\s\S]*?)<\/promise>/);
  if (!match) return null;
  return match[1].trim().replace(/\s+/g, ' ');
}
```

The `tool_result_persist` hook provides an alternative proof detection path. When
the agent outputs a tool result containing the `<promise>` tag, the hook can
intercept it:

```typescript
async function handleToolResultPersist(
  api: OpenClawPluginApi,
  config: HookConfig,
  context: ToolResultContext
): Promise<void> {
  const { stateDir } = config;
  const sessionId = context.session.id;
  const stateFile = `${stateDir}/${sessionId}.md`;

  if (!existsSync(stateFile)) return;

  // Scan tool result content for <promise> tags
  const content =
    typeof context.result === 'string'
      ? context.result
      : JSON.stringify(context.result);
  const promiseValue = extractPromiseTag(content);

  if (promiseValue) {
    // Store for the next agent_end evaluation
    const state = parseSessionState(stateFile);
    updateSessionState(stateFile, {
      ...state,
      _lastPromiseValue: promiseValue,
    });
  }
}
```

---

### 2e. Effect Execution

**Goal:** Execute the pending tasks that the babysitter run has requested, then post
their results.

#### The Effect Execution Cycle

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
  Returns: { tasks: [{ effectId, kind, status, title, label }] }
        |
        v
  For each pending task:
        |
        +--[kind = "node"]----------> Execute Node.js script
        |                             (runs in Gateway process or spawned child)
        |
        +--[kind = "breakpoint"]----> Present to user via channel message
        |                             Wait for explicit approve/reject reply
        |                             NEVER auto-approve
        |
        +--[kind = "sleep"]---------> Schedule wake-up via Gateway cron
        |                             or setTimeout in the daemon
        |
        +--[kind = "orchestrator_  -> Delegate to another agent session
        |    task"]                   via spawnDelegateSession()
        |
        +--[kind = "agent"]---------> Spawn sub-agent session
        |                             via Gateway multi-agent routing
        |
        +--[custom kind]------------> Handle per plugin capabilities
        |
        v
  Post result via task:post (Section 2f)
```

#### Effect Executor

```typescript
// src/effects.ts
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnDelegateSession } from './sessions.js';

interface PendingTask {
  effectId: string;
  kind: string;
  status: string;
  title: string;
  label?: string;
}

interface EffectResult {
  status: 'ok' | 'error';
  value: unknown;
}

export async function executeEffects(
  api: OpenClawPluginApi,
  cli: string,
  runId: string,
  workspaceDir: string
): Promise<{ completed: boolean; proof?: string }> {
  const runDir = path.join('.a5c', 'runs', runId);
  const absRunDir = path.join(workspaceDir, runDir);

  // Step 1: Iterate to advance the run and discover pending effects
  const iterResult = execSync(
    `${cli} run:iterate ${runDir} --json`,
    { encoding: 'utf-8', cwd: workspaceDir, timeout: 60_000 }
  );
  const iterData = JSON.parse(iterResult);

  if (iterData.status === 'completed') {
    return { completed: true, proof: iterData.completionProof };
  }

  if (iterData.status === 'failed') {
    api.logger.error('babysitter: run failed', { runId, error: iterData });
    return { completed: false };
  }

  // Step 2: List pending tasks
  const listResult = execSync(
    `${cli} task:list ${runDir} --pending --json`,
    { encoding: 'utf-8', cwd: workspaceDir, timeout: 10_000 }
  );
  const tasks: PendingTask[] = JSON.parse(listResult).tasks;

  // Step 3: Execute each pending task
  for (const task of tasks) {
    const taskDir = path.join(absRunDir, 'tasks', task.effectId);
    let result: EffectResult;

    try {
      switch (task.kind) {
        case 'node':
          result = await executeNodeTask(cli, taskDir, workspaceDir);
          break;
        case 'breakpoint':
          result = await handleBreakpoint(api, taskDir);
          break;
        case 'sleep':
          result = await handleSleep(taskDir);
          break;
        case 'orchestrator_task':
          result = await delegateToAgent(api, taskDir);
          break;
        default:
          result = {
            status: 'error',
            value: { error: `Unknown task kind: ${task.kind}` },
          };
      }
    } catch (err) {
      result = {
        status: 'error',
        value: { error: String(err) },
      };
    }

    // Step 4: Post result
    postResult(cli, runDir, task.effectId, result, workspaceDir);
  }

  return { completed: false };
}

async function executeNodeTask(
  cli: string,
  taskDir: string,
  workspaceDir: string
): Promise<EffectResult> {
  const taskDef = JSON.parse(
    readFileSync(path.join(taskDir, 'task.json'), 'utf-8')
  );

  try {
    // Node tasks are executed as child processes
    const output = execSync(
      `node -e "${taskDef.args?.script?.replace(/"/g, '\\"') ?? ''}"`,
      {
        encoding: 'utf-8',
        cwd: workspaceDir,
        timeout: 900_000, // BABYSITTER_NODE_TASK_TIMEOUT (15 min)
      }
    );
    return { status: 'ok', value: { output } };
  } catch (err: unknown) {
    const error = err as { message?: string; stderr?: string };
    return {
      status: 'error',
      value: { error: error.message, stderr: error.stderr },
    };
  }
}

async function handleBreakpoint(
  api: OpenClawPluginApi,
  taskDir: string
): Promise<EffectResult> {
  const taskDef = JSON.parse(
    readFileSync(path.join(taskDir, 'task.json'), 'utf-8')
  );
  const question = taskDef.args?.question ?? 'Approve this step?';

  // NOTE: api.prompt() is UNVERIFIED in official OpenClaw plugin docs.
  // Fallback: send a channel message via sendSessionMessage() and
  // poll for a reply, or use api.registerCommand() to handle an
  // /approve slash command.
  let response: { text: string; dismissed?: boolean } | null = null;

  if (typeof (api as Record<string, unknown>).prompt === 'function') {
    response = await (api as Record<string, unknown> as { prompt: Function }).prompt(question, {
      options: ['Approve', 'Reject'],
      timeout: 600_000, // 10 minute timeout
    });
  } else {
    // Fallback: log and reject. In production, implement an async
    // approval flow via api.registerCommand('approve', ...).
    api.logger.warn(
      'babysitter: api.prompt() not available; breakpoint auto-rejected. ' +
      'Implement /approve command for interactive breakpoints.',
      { question }
    );
    return {
      status: 'ok',
      value: { approved: false, reason: 'api.prompt() unavailable; auto-rejected' },
    };
  }

  if (!response || response.dismissed) {
    // Never auto-approve. Treat ambiguous responses as rejection.
    return {
      status: 'ok',
      value: { approved: false, reason: 'No explicit approval received' },
    };
  }

  return {
    status: 'ok',
    value: {
      approved: response.text.toLowerCase().includes('approve'),
      reason: response.text,
    },
  };
}

async function handleSleep(taskDir: string): Promise<EffectResult> {
  const taskDef = JSON.parse(
    readFileSync(path.join(taskDir, 'task.json'), 'utf-8')
  );
  const sleepUntil = new Date(taskDef.args?.until ?? Date.now());
  const now = Date.now();

  if (sleepUntil.getTime() > now) {
    // Sleep not yet satisfied -- return pending
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(sleepUntil.getTime() - now, 60_000))
    );
  }

  return { status: 'ok', value: { wokeAt: new Date().toISOString() } };
}

async function delegateToAgent(
  api: OpenClawPluginApi,
  taskDir: string
): Promise<EffectResult> {
  const taskDef = JSON.parse(
    readFileSync(path.join(taskDir, 'task.json'), 'utf-8')
  );

  // Uses the sessions abstraction with fallback (see src/sessions.ts)
  const result = await spawnDelegateSession(api, {
    agentId: taskDef.args?.agentId ?? 'default',
    message: taskDef.args?.prompt ?? '',
    timeout: taskDef.args?.timeout ?? 300_000,
  });

  return {
    status: result.error ? 'error' : 'ok',
    value: result.error ? { error: result.error } : result.output,
  };
}
```

---

### 2f. Result Posting

**Goal:** Record effect execution results back into the run journal.

Always post results through the CLI. Never write `result.json` directly.

```typescript
function postResult(
  cli: string,
  runDir: string,
  effectId: string,
  result: EffectResult,
  workspaceDir: string
): void {
  const taskDir = path.join(workspaceDir, runDir, 'tasks', effectId);
  const valueFile = path.join(taskDir, 'output.json');

  // Write result value to temporary file
  writeFileSync(valueFile, JSON.stringify(result.value));

  // Post through CLI (writes result.json + journal event + cache update)
  execSync(
    `${cli} task:post ${runDir} ${effectId}` +
    ` --status ${result.status}` +
    ` --value ${path.join('tasks', effectId, 'output.json')}` +
    ` --json`,
    { encoding: 'utf-8', cwd: workspaceDir, timeout: 30_000 }
  );
}
```

#### CLI Command Reference

```bash
# Success case
babysitter task:post .a5c/runs/{runId} {effectId} \
  --status ok \
  --value tasks/{effectId}/output.json \
  --json

# Error case
babysitter task:post .a5c/runs/{runId} {effectId} \
  --status error \
  --value tasks/{effectId}/error.json \
  --json
```

The `task:post` command handles:
1. Writing `result.json` with the correct schema version
2. Appending an `EFFECT_RESOLVED` event to the journal
3. Updating the state cache

---

### 2g. Iteration Guards

**Goal:** Prevent infinite loops and detect runaway behavior.

All guard logic is consolidated in the `checkGuards()` function in
`src/guards.ts` (Section 2d). This single implementation is used by both:

- The `agent_end` handler (`evaluateAndContinue()`)
- The CLI-based guard check (`session:check-iteration`)

#### CLI-Based Guard Check

```bash
babysitter session:check-iteration \
  --session-id {sessionId} \
  --state-dir {stateDir} \
  --json
```

The CLI command uses the same guard algorithm as the plugin. Use it for
external monitoring or testing.

#### Guard Rules

**1. Max Iterations Guard**

```
IF iteration >= maxIterations (default 256):
    STOP -- clean up state file, do not re-inject
```

**2. Runaway Speed Guard**

```
IF iteration >= 5:
    avgDuration = average(last 3 iteration durations)
    IF avgDuration <= 15 seconds:
        STOP -- iterations too fast, likely a runaway loop
```

#### OpenClaw-Specific Consideration: Daemon Uptime

Because OpenClaw runs as a long-lived daemon (unlike ephemeral CLI sessions),
iteration state persists naturally across agent turns. However, daemon restarts
will clear in-memory state. The file-based session state (`{sessionId}.md`) is
the source of truth and survives daemon restarts. On startup, the
`before_agent_start` hook re-reads the existing state file if present rather
than overwriting it (see Section 2b).

---

## 3. Harness Capability Matrix

### OpenClaw Capability Assessment

```
+---------------------------+----------+-----------+-------------------------------+
| Capability                | Required | Available | OpenClaw Mechanism            |
+---------------------------+----------+-----------+-------------------------------+
| Shell command execution   | YES      | YES       | Node.js child_process / exec  |
| Exit/stop interception    | YES      | YES       | agent_end hook                |
| Context re-injection      | YES      | YES       | Gateway sessions_send method  |
| Session identity          | YES      | YES       | context.session.id (Gateway)  |
| File system read/write    | YES      | YES       | Node.js fs (workspace dir)    |
| Transcript access         | NO *     | PARTIAL   | tool_result_persist hook +    |
|                           |          |           | lastAssistantMessage          |
| Lifecycle hooks           | NO       | YES       | api.registerHook() [verified] |
| Persistent environment    | NO       | YES       | Gateway daemon keeps state    |
| Interactive user prompts  | NO       | UNCERTAIN | api.prompt() [unverified];    |
|                           |          |           | fallback: registerCommand()   |
| Sub-agent delegation      | NO       | YES       | sessions_spawn WS method      |
|                           |          |           | [verified]                    |
| MCP tool integration      | NO       | YES       | @modelcontextprotocol/sdk     |
|                           |          |           | stdio + HTTP                  |
+---------------------------+----------+-----------+-------------------------------+
```

### Integration Tier Assessment

OpenClaw's daemon architecture and rich plugin API support **Tier 3 (Full
Integration)** from the outset:

| Tier | Status | Notes |
|------|--------|-------|
| Tier 1: Minimum Viable | Fully supported | All required capabilities available |
| Tier 2: Robust | Fully supported | Runaway detection, breakpoints via channel prompts, sleep via daemon scheduling |
| Tier 3: Full | Fully supported | Multi-agent delegation, MCP tools, quality scoring, full hook lifecycle |

### OpenClaw Advantages Over Other Harnesses

1. **Long-lived daemon** -- No per-session CLI startup cost. State persists naturally.
2. **Multi-channel** -- Breakpoint approvals can arrive via WhatsApp, Slack, etc.
3. **Multi-agent routing** -- `orchestrator_task` effects can delegate to other
   agents natively via the Gateway's `sessions_spawn` method.
4. **SQLite persistence** -- Session history survives crashes without extra work.
5. **MCP native** -- Babysitter operations can be exposed as MCP tools for direct
   agent invocation.

---

## 4. Session State Contract

> **This is the single canonical reference** for session state fields. All code
> in this guide (the `SessionState` interface in Section 2d, the guard logic in
> Section 2g, and the smoke tests in Section 7) derives from this table.
> If you change a field name, type, or default here, update every reference.

### File Format

Session state files use Markdown with YAML frontmatter, identical to the generic
contract.

**Path convention:** `{pluginRoot}/skills/babysit/state/{sessionId}.md`

#### OpenClaw Session ID Format

OpenClaw session IDs follow the pattern: `{channelType}-{senderId}-{agentId}` or
a Gateway-assigned UUID. The session manager ensures uniqueness per sender/channel/
agent combination.

#### Example

```markdown
---
active: true
iteration: 3
max_iterations: 256
run_id: "my-run-abc123"
started_at: "2026-03-02T10:00:00Z"
last_iteration_at: "2026-03-02T10:05:30Z"
iteration_times: 45,62,58
---

Build a REST API with authentication and rate limiting for the user service.
```

### Required Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `active` | boolean | `true` | Whether the orchestration loop is active |
| `iteration` | number | `1` | Current iteration (1-based) |
| `max_iterations` | number | `256` | Maximum iterations (0 = unlimited) |
| `run_id` | string | `""` | Bound run ID (empty before run:create) |
| `started_at` | string (ISO 8601) | now | Session start timestamp |
| `last_iteration_at` | string (ISO 8601) | now | Last iteration timestamp |
| `iteration_times` | string (CSV) | (empty) | Last 3 iteration durations in seconds |

### State Transitions

```
    CREATE                BIND               ITERATE (x N)        COMPLETE
  (session:init)    (session:associate)    (agent_end CONTINUE)  (agent_end DONE)
       |                   |                     |                    |
       v                   v                     v                    v
  +-----------+     +-----------+          +-----------+       +------------+
  |  BASELINE |     |   BOUND   |          |  ACTIVE   |       |  CLEANED   |
  |           |---->|           |--------->|           |------>|   UP       |
  | runId=""  |     | runId=X   |          | iter=N+1  |       | file       |
  | iter=1    |     | iter=1    |          | times=[.] |       | deleted    |
  +-----------+     +-----------+          +-----------+       +------------+
```

### Atomic Write Protocol

Same as the generic contract. Session state files are written atomically:

```typescript
import { writeFileSync, renameSync, unlinkSync } from 'node:fs';

function writeSessionFileAtomic(filePath: string, content: string): void {
  const tmpFile = `${filePath}.tmp.${process.pid}`;
  try {
    writeFileSync(tmpFile, content);
    renameSync(tmpFile, filePath);
  } catch (err) {
    try { unlinkSync(tmpFile); } catch { /* best effort */ }
    throw err;
  }
}
```

### Timing Calculation

```typescript
function updateIterationTimes(
  existingTimes: number[],
  lastIterationAt: string,
  currentTime: string
): number[] {
  const duration =
    (new Date(currentTime).getTime() - new Date(lastIterationAt).getTime()) /
    1000;
  if (duration <= 0) return existingTimes;
  return [...existingTimes, duration].slice(-3); // Keep last 3
}
```

---

## 5. Hook Equivalence Table

The babysitter SDK defines 13 native hook types. This table maps each to the
OpenClaw mechanism that implements equivalent functionality.

```
+---------------------+------+--------------------------------------------------+
| Babysitter Hook     | Tier | OpenClaw Equivalent                              |
+---------------------+------+--------------------------------------------------+
| session-start       |  1   | before_agent_start hook via registerHook().       |
|                     |      | Create baseline state file via session:init.      |
+---------------------+------+--------------------------------------------------+
| stop                |  1   | agent_end hook via registerHook().                |
|                     |      | Evaluate state, re-inject via                     |
|                     |      | sendSessionMessage() or allow session to end.     |
+---------------------+------+--------------------------------------------------+
| on-run-start        |  3   | Custom callback after run:create completes.       |
+---------------------+------+--------------------------------------------------+
| on-run-complete     |  3   | Detected when run:iterate returns completed.      |
|                     |      | Fire callback in the effect executor.             |
+---------------------+------+--------------------------------------------------+
| on-run-fail         |  3   | Detected when run:iterate returns failed.         |
|                     |      | Fire callback in the effect executor.             |
+---------------------+------+--------------------------------------------------+
| on-task-start       |  3   | Fire before each task execution in effects.ts.    |
|                     |      | Can also use tool_result_persist hook.             |
+---------------------+------+--------------------------------------------------+
| on-task-complete    |  3   | Fire after task:post completes in effects.ts.     |
+---------------------+------+--------------------------------------------------+
| on-step-dispatch    |  3   | Triggered during run:iterate when a new effect    |
|                     |      | is discovered. Emit via custom callback.          |
+---------------------+------+--------------------------------------------------+
| on-iteration-start  |  2   | Fire at the top of evaluateAndContinue() before   |
|                     |      | calling run:iterate.                              |
+---------------------+------+--------------------------------------------------+
| on-iteration-end    |  2   | Fire at the bottom of evaluateAndContinue()       |
|                     |      | after all effects are posted.                     |
+---------------------+------+--------------------------------------------------+
| on-breakpoint       |  2   | Detected when task:list returns a breakpoint.     |
|                     |      | Present to user via channel message.              |
|                     |      | [api.prompt() is unverified; see Section 2e]      |
+---------------------+------+--------------------------------------------------+
| on-score            |  3   | Fire when a quality score is posted.              |
|                     |      | Can use webhook hook for external reporting.      |
+---------------------+------+--------------------------------------------------+
| pre-commit          |  3   | Not directly available in OpenClaw. Implement     |
|                     |      | via Node.js git hooks in the workspace.           |
+---------------------+------+--------------------------------------------------+
| pre-branch          |  3   | Same as pre-commit: implement via workspace       |
|                     |      | git hooks.                                        |
+---------------------+------+--------------------------------------------------+
| post-planning       |  3   | Custom callback emitted after planning phase.     |
+---------------------+------+--------------------------------------------------+
```

### Hook Discovery Directories

For Tier 3 integration, hook scripts are searched in priority order:

```
1. Per-workspace:  {WORKSPACE}/.a5c/hooks/{hookType}/*.sh      (highest)
2. Per-user:       ~/.openclaw/hooks/{hookType}/*.sh            (medium)
3. Plugin:         {PLUGIN_ROOT}/hooks/{hookType}/*.sh          (lowest)
```

### OpenClaw-Specific Hooks

In addition to babysitter hooks, the OpenClaw plugin can leverage Gateway hooks:

| OpenClaw Hook | Purpose in Babysitter Context |
|--------------|-------------------------------|
| `before_agent_start` | Session init, state file creation |
| `agent_end` | Orchestration loop driver (CONTINUE/DONE) |
| `tool_result_persist` | Scan tool results for `<promise>` completion proof |
| Webhooks | External notifications on run completion, breakpoint pending |

---

## 6. Version Compatibility Matrix

This table documents the tested compatibility between OpenClaw Gateway versions,
Babysitter SDK versions, and Node.js runtimes.

| OpenClaw Gateway | Babysitter SDK | Node.js | Status | Notes |
|-----------------|---------------|---------|--------|-------|
| v0.40.x | >= 0.0.160 | 22.x | **Supported** | Minimum viable. `registerHook` API stable. |
| v0.41.x | >= 0.0.165 | 22.x | **Supported** | Adds `tool_result_persist` hook support. |
| v0.42.x | >= 0.0.170 | 22.x, 23.x | **Recommended** | Full plugin API, MCP tool registration, ClawHub skills. |
| v0.43.x (beta) | >= 0.0.170 | 22.x, 23.x | **Experimental** | New `sessions_delegate` API may replace `sessions_spawn`. |
| < v0.40.0 | any | any | **Unsupported** | Missing `registerHook` API; plugin system incompatible. |

**Key constraints:**

- **Node.js 22+** is required by OpenClaw. The Babysitter SDK itself requires
  Node >= 18, but the OpenClaw requirement takes precedence.
- **SDK version pinning:** The plugin `package.json` should pin to a specific
  minor range (e.g., `^0.0.170`) to avoid breaking changes during the pre-1.0
  development phase.
- **MCP protocol:** Requires `@modelcontextprotocol/sdk >= 1.12.1` for the
  `tools/call` handler pattern used in Section 8.

---

## 7. Testing the Integration

### Smoke Tests

The following tests cover the critical integration path. Each test builds on the
previous one, so they can be run sequentially as a single E2E validation.

#### Test 1: Plugin Loading and CLI Availability

```bash
# Verify OpenClaw loads the babysitter plugin
openclaw plugins list --json
# Expected: babysitter plugin appears with correct version

# Verify babysitter CLI is on PATH
babysitter version --json
# Expected: { "version": "x.y.z", "sdkVersion": "..." }
```

#### Test 2: Session Lifecycle (Init, Bind, Iterate, Guard)

```typescript
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const sessionId = `smoke-test-${Date.now()}`;
const workspaceDir = '/tmp/babysitter-openclaw-smoke';
const stateDir = path.join(workspaceDir, 'plugin', 'skills', 'babysit', 'state');

mkdirSync(path.join(workspaceDir, '.a5c'), { recursive: true });
mkdirSync(stateDir, { recursive: true });

// 1. Session init
execSync(
  `babysitter session:init --session-id ${sessionId} --state-dir ${stateDir} --json`,
  { encoding: 'utf-8' }
);
const stateFile = `${stateDir}/${sessionId}.md`;
console.assert(existsSync(stateFile), 'State file should exist');
const content = readFileSync(stateFile, 'utf-8');
console.assert(content.includes('active: true'), 'Should be active');
console.assert(content.includes('iteration: 1'), 'Should start at iteration 1');
console.assert(content.includes('run_id: ""'), 'Should have empty run_id');

// 2. Create process and run
writeFileSync(
  path.join(workspaceDir, 'process.js'),
  `exports.process = async function(inputs, ctx) {
    const result = await ctx.task('greet', { name: inputs.name });
    return { greeting: result };
  };`
);
writeFileSync(
  path.join(workspaceDir, 'inputs.json'),
  JSON.stringify({ name: 'OpenClaw' })
);
const createResult = execSync(
  `babysitter run:create --process-id test --entry ./process.js#process --inputs ./inputs.json --prompt "Smoke test" --json`,
  { encoding: 'utf-8', cwd: workspaceDir }
);
const { runId } = JSON.parse(createResult);
console.assert(runId, 'Should return a runId');

// 3. Bind session
execSync(
  `babysitter session:associate --session-id ${sessionId} --run-id ${runId} --state-dir ${stateDir} --json`,
  { encoding: 'utf-8', cwd: workspaceDir }
);
const bound = readFileSync(stateFile, 'utf-8');
console.assert(bound.includes(`run_id: "${runId}"`), 'Should contain runId');

// 4. Iterate and discover effects
const iterResult = execSync(
  `babysitter run:iterate .a5c/runs/${runId} --json`,
  { encoding: 'utf-8', cwd: workspaceDir }
);
const iterData = JSON.parse(iterResult);
console.assert(iterData.status, 'Should return a status');

// 5. List and post effects
const listResult = execSync(
  `babysitter task:list .a5c/runs/${runId} --pending --json`,
  { encoding: 'utf-8', cwd: workspaceDir }
);
const tasks = JSON.parse(listResult).tasks;
console.assert(Array.isArray(tasks), 'Should return tasks array');

for (const task of tasks) {
  const outputFile = path.join(
    workspaceDir, '.a5c', 'runs', runId, 'tasks', task.effectId, 'output.json'
  );
  writeFileSync(outputFile, JSON.stringify({ result: 'Hello!' }));
  execSync(
    `babysitter task:post .a5c/runs/${runId} ${task.effectId} --status ok --value tasks/${task.effectId}/output.json --json`,
    { encoding: 'utf-8', cwd: workspaceDir }
  );
}

// 6. Check iteration guard
const guardResult = execSync(
  `babysitter session:check-iteration --session-id ${sessionId} --state-dir ${stateDir} --json`,
  { encoding: 'utf-8' }
);
const guardData = JSON.parse(guardResult);
console.assert(guardData.found === true, 'Should find session');
console.assert(guardData.shouldContinue === true, 'Should continue');

// 7. Re-iterate to check completion
const reiterResult = execSync(
  `babysitter run:iterate .a5c/runs/${runId} --json`,
  { encoding: 'utf-8', cwd: workspaceDir }
);
const reiterData = JSON.parse(reiterResult);
if (reiterData.status === 'completed') {
  console.assert(reiterData.completionProof, 'Should have completion proof');
}

console.log('SMOKE TEST PASSED');
```

### Common Failure Modes

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Plugin not loaded by Gateway | Missing `openclaw` field in package.json | Add the field per Section 2a |
| `babysitter: command not found` | SDK not installed | Run `npm install -g @a5c-ai/babysitter-sdk` |
| `agent_end` hook never fires | Hook not registered | Check `api.registerHook('agent_end', ...)` in plugin |
| Loop exits after 1 iteration | Session message not re-injecting | Verify sendSessionMessage() triggers a new agent turn |
| Infinite loop (never exits) | Completion proof not detected | Check `<promise>` tag scanning in `agent_end` handler |
| State file missing on daemon restart | File was in temp directory | Use workspace-relative path, not `/tmp` |
| Re-entrant run error | Previous run still active | Check and clean up existing run before binding |
| Iterations very fast, exits early | Runaway detection triggers (avg <= 15s) | Agent is not doing meaningful work; check effect execution |
| Breakpoint never resolves | `api.prompt()` not available | Use registerCommand() fallback (see Section 2e) |
| Multi-agent delegation fails | Agent ID not found | Verify agent routing in `openclaw.json` |
| Daemon restart loses in-flight iteration | In-memory state cleared on `openclaw restart` | File-based state in `{sessionId}.md` is the source of truth. On restart, `before_agent_start` re-reads the existing file (not overwrite). Verify the state file path is workspace-relative, not in a tmpfs. If an iteration was mid-flight when the daemon died, the next `agent_end` will pick up from the last persisted iteration count. Stale `run.lock` files are auto-cleaned after 40 retries (10s). |

---

## 8. Reference Implementation

### Key Files

| File | Role |
|------|------|
| `src/index.ts` | Plugin entry point; registers hooks and MCP tools |
| `src/hooks.ts` | `before_agent_start`, `agent_end`, `tool_result_persist` registration |
| `src/guards.ts` | `checkGuards()`, `evaluateAndContinue()`, iteration state management |
| `src/effects.ts` | Effect execution (node, breakpoint, sleep, delegation) |
| `src/sessions.ts` | Session messaging abstraction with verified/unverified API fallbacks |
| `src/install.ts` | SDK CLI installation and verification |
| `src/orchestration.ts` | Run creation, session binding, iteration message building |
| `src/mcp-tools.ts` | MCP tool definitions for babysitter operations (optional) |
| `skills/babysit/SKILL.md` | Skill definition for ClawHub registry |
| `skills/babysit/state/` | Session state files (per session) |

### MCP Tool Registration (Optional)

Expose babysitter operations as MCP tools so the agent can invoke them directly:

```typescript
// src/mcp-tools.ts
import type { OpenClawPluginApi } from 'openclaw';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

interface McpConfig {
  pluginRoot: string;
  stateDir: string;
}

export function registerMcpTools(
  api: OpenClawPluginApi,
  config: McpConfig
): void {
  const server = new Server(
    { name: 'babysitter-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler('tools/list', async () => ({
    tools: [
      {
        name: 'babysitter_run_create',
        description: 'Create a new babysitter orchestration run',
        inputSchema: {
          type: 'object',
          properties: {
            processId: { type: 'string', description: 'Process identifier' },
            entryPoint: { type: 'string', description: 'Entry point (file#function)' },
            inputs: { type: 'object', description: 'Process inputs' },
            prompt: { type: 'string', description: 'User prompt' },
          },
          required: ['processId', 'entryPoint', 'prompt'],
        },
      },
      {
        name: 'babysitter_run_iterate',
        description: 'Advance the orchestration run by one iteration',
        inputSchema: {
          type: 'object',
          properties: {
            runId: { type: 'string', description: 'Run identifier' },
          },
          required: ['runId'],
        },
      },
      {
        name: 'babysitter_task_list',
        description: 'List pending tasks for a run',
        inputSchema: {
          type: 'object',
          properties: {
            runId: { type: 'string', description: 'Run identifier' },
          },
          required: ['runId'],
        },
      },
      {
        name: 'babysitter_task_post',
        description: 'Post a task result',
        inputSchema: {
          type: 'object',
          properties: {
            runId: { type: 'string', description: 'Run identifier' },
            effectId: { type: 'string', description: 'Effect identifier' },
            status: { type: 'string', enum: ['ok', 'error'] },
            value: { type: 'object', description: 'Result value' },
          },
          required: ['runId', 'effectId', 'status', 'value'],
        },
      },
    ],
  }));

  server.setRequestHandler('tools/call', async (request) => {
    const { name, arguments: args } = request.params;
    const { execSync } = await import('node:child_process');
    const { writeFileSync } = await import('node:fs');
    const path = await import('node:path');
    const cli = 'babysitter';
    const cwd = process.cwd();

    try {
      let result: string;

      switch (name) {
        case 'babysitter_run_create': {
          const inputsFile = path.join(cwd, '.a5c', `tmp-inputs-${Date.now()}.json`);
          writeFileSync(inputsFile, JSON.stringify(args.inputs ?? {}));
          result = execSync(
            `${cli} run:create` +
            ` --process-id "${args.processId}"` +
            ` --entry "${args.entryPoint}"` +
            ` --inputs "${inputsFile}"` +
            ` --prompt "${(args.prompt as string).replace(/"/g, '\\"')}"` +
            ` --json`,
            { encoding: 'utf-8', cwd, timeout: 30_000 }
          );
          break;
        }

        case 'babysitter_run_iterate': {
          const runDir = path.join('.a5c', 'runs', args.runId as string);
          result = execSync(
            `${cli} run:iterate ${runDir} --json`,
            { encoding: 'utf-8', cwd, timeout: 60_000 }
          );
          break;
        }

        case 'babysitter_task_list': {
          const runDir = path.join('.a5c', 'runs', args.runId as string);
          result = execSync(
            `${cli} task:list ${runDir} --pending --json`,
            { encoding: 'utf-8', cwd, timeout: 10_000 }
          );
          break;
        }

        case 'babysitter_task_post': {
          const runDir = path.join('.a5c', 'runs', args.runId as string);
          const effectId = args.effectId as string;
          const valueFile = path.join(
            cwd, runDir, 'tasks', effectId, `mcp-output-${Date.now()}.json`
          );
          writeFileSync(valueFile, JSON.stringify(args.value));
          result = execSync(
            `${cli} task:post ${runDir} ${effectId}` +
            ` --status ${args.status}` +
            ` --value tasks/${effectId}/mcp-output-${Date.now()}.json` +
            ` --json`,
            { encoding: 'utf-8', cwd, timeout: 30_000 }
          );
          break;
        }

        default:
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({ error: `Unknown tool: ${name}` }),
            }],
            isError: true,
          };
      }

      return {
        content: [{ type: 'text', text: result }],
      };
    } catch (err: unknown) {
      const error = err as { message?: string; stderr?: string };
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: error.message ?? 'Unknown error',
            stderr: error.stderr,
          }),
        }],
        isError: true,
      };
    }
  });

  // Connect via stdio or HTTP depending on OpenClaw MCP config
  const transport = new StdioServerTransport();
  server.connect(transport);
}
```

### Configuration Reference

#### openclaw.json (Project)

```json
{
  "plugins": {
    "@a5c-ai/openclaw-babysitter": {
      "enabled": true,
      "settings": {
        "maxIterations": 256,
        "runawayThreshold": 15,
        "nodeTaskTimeout": 900000,
        "autoApproveBreakpoints": false
      }
    }
  }
}
```

#### ~/.openclaw/openclaw.json (Global)

```json
{
  "gateway": {
    "plugins": ["@a5c-ai/openclaw-babysitter"]
  }
}
```

---

## Appendix A: HarnessAdapter (SDK-Internal)

> **Note:** This section describes an SDK-internal interface. It is relevant only
> to contributors modifying `packages/sdk/src/harness/`. Plugin authors should use
> the hook-based integration described in Sections 2-5 and do not need to
> implement a HarnessAdapter.

For first-class SDK support, implement the `HarnessAdapter` interface:

```typescript
// packages/sdk/src/harness/openclaw.ts
import type {
  HarnessAdapter,
  HookHandlerArgs,
  SessionBindOptions,
  SessionBindResult,
} from './types.js';

export class OpenClawAdapter implements HarnessAdapter {
  readonly name = 'openclaw';

  isActive(): boolean {
    return !!(process.env.OPENCLAW_SESSION_ID || process.env.OPENCLAW_GATEWAY_URL);
  }

  resolveSessionId(parsed: { sessionId?: string }): string | undefined {
    return parsed.sessionId ?? process.env.OPENCLAW_SESSION_ID;
  }

  resolveStateDir(args: {
    stateDir?: string;
    pluginRoot?: string;
  }): string | undefined {
    if (args.stateDir) return args.stateDir;
    if (args.pluginRoot) return `${args.pluginRoot}/skills/babysit/state`;
    return undefined;
  }

  resolvePluginRoot(args: { pluginRoot?: string }): string | undefined {
    return args.pluginRoot ?? process.env.OPENCLAW_PLUGIN_ROOT;
  }

  async bindSession(opts: SessionBindOptions): Promise<SessionBindResult> {
    const stateDir = this.resolveStateDir(opts);
    if (!stateDir) throw new Error('Cannot resolve state directory');

    const sessionId = this.resolveSessionId(opts);
    if (!sessionId) throw new Error('Cannot resolve session ID');

    const filePath = `${stateDir}/${sessionId}.md`;
    // ... bind logic (identical to claudeCode.ts bindSessionImpl)

    return { harness: this.name, sessionId, stateFile: filePath };
  }

  async handleStopHook(args: HookHandlerArgs): Promise<number> {
    // OpenClaw uses agent_end instead of a stop hook, so this
    // is primarily for CLI-based invocation compatibility.
    // Uses the same guard algorithm as checkGuards() in Section 2g.
    return 0;
  }

  async handleSessionStartHook(args: HookHandlerArgs): Promise<number> {
    // Create baseline state file (same logic as Section 2b)
    return 0;
  }

  findHookDispatcherPath(startCwd: string): string | null {
    const candidates = [
      `${startCwd}/.a5c/hooks`,
      `${process.env.HOME}/.openclaw/hooks`,
    ];
    for (const _dir of candidates) {
      // ... check for dispatcher script
    }
    return null;
  }
}
```

Register the adapter in `packages/sdk/src/harness/registry.ts`:

```typescript
import { OpenClawAdapter } from './openclaw.js';

// Add to the adapter list (probed in priority order)
const adapters: HarnessAdapter[] = [
  new ClaudeCodeAdapter(),
  new OpenClawAdapter(),   // <-- Add here
  new NullAdapter(),       // Fallback (always last)
];
```

---

## Appendix B: Complete CLI Command Reference

| Command | Purpose | Section |
|---------|---------|---------|
| `babysitter version --json` | Verify CLI installation | 2a |
| `babysitter session:init --session-id ID --state-dir DIR --json` | Create baseline session state | 2b |
| `babysitter run:create --process-id PID --entry FILE --inputs FILE --json` | Create a new run | 2c |
| `babysitter session:associate --session-id ID --run-id RID --state-dir DIR --json` | Bind session to run | 2c |
| `babysitter run:iterate RUNDIR --json` | Advance orchestration, discover effects | 2d, 2e |
| `babysitter run:status RUNDIR --json` | Read run status and completion proof | 2d |
| `babysitter session:iteration-message --session-id ID --state-dir DIR --json` | Get context to re-inject after CONTINUE | 2d |
| `babysitter task:list RUNDIR --pending --json` | List pending effects | 2e |
| `babysitter task:show RUNDIR EFFECTID --json` | Read task definition | 2e |
| `babysitter task:post RUNDIR EFFECTID --status STATUS --value FILE --json` | Post effect result | 2f |
| `babysitter session:check-iteration --session-id ID --state-dir DIR --json` | Check iteration guards | 2g |
| `babysitter hook:run --hook-type TYPE --harness NAME --json` | Dispatch a lifecycle hook | 5 |

---

## Appendix C: OpenClaw vs Claude Code Comparison

| Aspect | Claude Code | OpenClaw |
|--------|------------|----------|
| Runtime model | Ephemeral CLI process | Long-lived daemon (Gateway) |
| Stop mechanism | Stop hook (shell script) | `agent_end` hook (Node.js) |
| Context re-injection | Hook `block` decision with `reason` | `sendSessionMessage()` abstraction |
| Session persistence | File-based (YAML frontmatter) | SQLite + file-based state |
| Plugin registration | `plugin.json` manifest | `package.json` `openclaw` field |
| Skill distribution | Plugin directory | ClawHub registry |
| Breakpoint UX | `AskUserQuestion` tool | Channel message (api.prompt() unverified; fallback available) |
| Multi-agent | Not native | Native via `sessions_spawn` [verified] |
| MCP support | Via plugin system | Native `@modelcontextprotocol/sdk` |
| Hook discovery | Per-repo/per-user/plugin dirs | Per-workspace/per-user/plugin dirs |
| Channel support | CLI only | WhatsApp, Telegram, Slack, Discord, etc. |
