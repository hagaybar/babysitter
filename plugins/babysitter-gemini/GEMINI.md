# Babysitter — Orchestration Context

Babysitter is an event-sourced workflow orchestrator. When active, it runs an **in-session loop** driven by the AfterAgent hook: each turn, you perform one orchestration step, then stop — the hook re-injects the prompt to continue.

## When Babysitter Is Active

The AfterAgent hook fires after every turn. If a babysitter run is bound to this session (via `GEMINI_SESSION_ID`), the hook will:
- **Block exit** (`{"decision":"block","reason":"..."}`) if the run is not yet complete
- **Allow exit** (`{}`) once you output `<promise>COMPLETION_PROOF</promise>` matching the run's `completionProof`

## Core Loop Pattern

After `run:create`, **stop after each step** — the hook drives the next iteration:

1. `babysitter run:iterate .a5c/runs/<runId> --json` → get pending effects
2. `babysitter task:list .a5c/runs/<runId> --pending --json` → identify tasks
3. Perform each task (shell, agent, breakpoint) → post result via `task:post`
4. **STOP** — hook re-injects prompt for next iteration

## CLI Quick Reference

```bash
# Install SDK
npm i -g @a5c-ai/babysitter-sdk@latest

# Create run (binds to GEMINI_SESSION_ID automatically)
babysitter run:create --process-id <id> --entry <path>#<export> \
  --inputs <file> --prompt "..." \
  --harness gemini-cli --session-id "${GEMINI_SESSION_ID}" \
  --state-dir ".a5c/state" --json

# Iterate
babysitter run:iterate .a5c/runs/<runId> --json

# List pending tasks
babysitter task:list .a5c/runs/<runId> --pending --json

# Post result
babysitter task:post .a5c/runs/<runId> <effectId> \
  --status ok --value tasks/<effectId>/output.json --json

# Check status
babysitter run:status .a5c/runs/<runId> --json
```

## Completion

When `run:iterate` or `run:status` returns `completionProof`, output exactly:
```
<promise>THE_PROOF_VALUE</promise>
```
The AfterAgent hook detects this and allows the session to exit cleanly.

## Session Setup Scripts

```bash
# Setup loop (before run:create)
bash "${extensionPath}/scripts/setup-babysitter-run.sh" \
  --gemini-session-id "${GEMINI_SESSION_ID}" <PROMPT>

# Associate run after run:create
bash "${extensionPath}/scripts/associate-session-with-run.sh" \
  --run-id <runId> --gemini-session-id "${GEMINI_SESSION_ID}"

# Resume existing run
bash "${extensionPath}/scripts/setup-babysitter-run-resume.sh" \
  --gemini-session-id "${GEMINI_SESSION_ID}" --run-id <runId>
```

## Critical Rules

- **NEVER** output `<promise>...</promise>` unless the run is fully completed
- **STOP after each phase** — do not call run:iterate multiple times per turn
- **Do not write result.json directly** — always use `task:post --value <file>`
- For breakpoints, ask the user using `ask_user` tool
- For agent tasks, delegate to a sub-agent (use `@agent` in your prompt)
