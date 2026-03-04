# Babysitter — Gemini CLI Extension

Orchestrate complex, multi-step AI workflows directly inside Gemini CLI using the event-sourced [Babysitter SDK](https://github.com/a5c-ai/babysitter).

## How It Works

Babysitter drives an **in-session loop** via the Gemini CLI `AfterAgent` hook:

1. You start a run with `/babysitter:call <task>`
2. Each turn, you perform one orchestration step (iterate, post a result, handle a breakpoint)
3. The `AfterAgent` hook fires after your turn — if the run isn't done, it blocks exit and re-injects the prompt for the next iteration
4. The loop ends when you output `<promise>COMPLETION_PROOF</promise>`

---

## Installation

### Option 1 — From GitHub (recommended)

```bash
gemini extensions install https://github.com/a5c-ai/babysitter --subdirectory plugins/babysitter-gemini --auto-update
```

### Option 2 — From a local clone

```bash
git clone https://github.com/a5c-ai/babysitter
gemini extensions install ./babysitter/plugins/babysitter-gemini
```

### Option 3 — Direct path (development)

```bash
gemini extensions install /absolute/path/to/babysitter/plugins/babysitter-gemini
```

The `--auto-update` flag (Option 1) keeps the extension updated automatically as new versions are released.

---

## Prerequisites

- [Gemini CLI](https://github.com/google-gemini/gemini-cli) installed
- [Node.js](https://nodejs.org/) 18+ (for the Babysitter SDK)
- The extension will install the Babysitter SDK automatically on first use

---

## Commands

All commands are available as `/babysitter:<command>` inside Gemini CLI.

| Command | Description |
|---------|-------------|
| `/babysitter:call [task]` | Start a new orchestration run |
| `/babysitter:resume [run-id]` | Resume an incomplete run |
| `/babysitter:yolo [task]` | Start a fully autonomous run (no breakpoints) |
| `/babysitter:forever [task]` | Start a never-ending periodic run |
| `/babysitter:plan [task]` | Design a process without executing it |
| `/babysitter:doctor [run-id]` | Diagnose run health |
| `/babysitter:observe` | Launch the real-time observer dashboard |
| `/babysitter:assimilate [target]` | Assimilate an external methodology or harness |
| `/babysitter:user-install` | Set up Babysitter for yourself |
| `/babysitter:project-install` | Set up Babysitter for this project |
| `/babysitter:retrospect [run-id]` | Analyze a completed run |
| `/babysitter:help [topic]` | Show help |

---

## Quick Start

```
/babysitter:call Build a REST API with JWT authentication
```

Babysitter will:
1. Interview you about the requirements
2. Design a custom process
3. Run it iteratively until complete

---

## State & Runs

Babysitter stores all state locally:

```
.a5c/
├── runs/<runId>/          # Run journals, tasks, and artifacts
│   ├── run.json
│   ├── journal/
│   ├── tasks/
│   └── state/
├── state/<sessionId>.md   # Active session state (hook tracking)
├── logs/                  # Hook execution logs
└── processes/             # Reusable process definitions
```

---

## How the Loop Works (Technical)

### Session Start
When Gemini CLI starts, the `SessionStart` hook creates a baseline session state file at `.a5c/state/<session_id>.md`.

### After Each Turn
The `AfterAgent` hook reads the session state file. If a babysitter run is active:
- Checks for `<promise>PROOF</promise>` in the agent's response — if matched, allows exit ✅
- Otherwise outputs `{"decision":"block","reason":"...","systemMessage":"..."}` to continue the loop

### Starting a Run
```bash
# 1. Initialize the session loop
bash "${extensionPath}/scripts/setup-babysitter-run.sh" \
  --gemini-session-id "${GEMINI_SESSION_ID}" \
  "Build a todo list app"

# 2. Create the run (binds session automatically)
babysitter run:create \
  --process-id my-process \
  --entry .a5c/processes/my-process.js#process \
  --inputs .a5c/processes/my-process.inputs.json \
  --harness gemini-cli \
  --session-id "${GEMINI_SESSION_ID}" \
  --state-dir ".a5c/state" \
  --json

# 3. STOP — the hook drives the loop from here
```

### Orchestration Loop (each iteration)
```bash
babysitter run:iterate .a5c/runs/<runId> --json --iteration <n>
babysitter task:list .a5c/runs/<runId> --pending --json
# ... execute each pending task ...
babysitter task:post .a5c/runs/<runId> <effectId> \
  --status ok --value tasks/<effectId>/output.json --json
# STOP — hook re-injects prompt for next turn
```

### Completing a Run
```bash
babysitter run:status .a5c/runs/<runId> --json
# Extract completionProof from output, then output:
# <promise>THE_PROOF_VALUE</promise>
```

---

## Logs

Hook logs are written to `.a5c/logs/`:

| File | Contents |
|------|----------|
| `babysitter-after-agent-hook.log` | AfterAgent hook decisions (block/allow) |
| `babysitter-after-agent-hook-stderr.log` | AfterAgent hook errors |
| `babysitter-session-start-hook.log` | Session start events |
| `babysitter-session-start-hook-stderr.log` | Session start errors |

---

## Troubleshooting

**Hook not firing?**
```
/babysitter:doctor
```

**SDK not found?**
```bash
npm i -g @a5c-ai/babysitter-sdk@latest
```

**Stale session state?**
```bash
rm .a5c/state/<session_id>.md
```

**Run stuck?**
```bash
babysitter run:status .a5c/runs/<runId> --json
babysitter run:events .a5c/runs/<runId> --limit 10 --reverse
```

---

## License

MIT — see [LICENSE](../../LICENSE)
