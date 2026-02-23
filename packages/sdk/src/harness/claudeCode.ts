/**
 * Claude Code harness adapter.
 *
 * Centralizes all Claude Code-specific behaviors:
 *   - Session ID resolution (CLAUDE_SESSION_ID, CLAUDE_ENV_FILE)
 *   - Plugin root resolution (CLAUDE_PLUGIN_ROOT)
 *   - State directory conventions (pluginRoot/skills/babysit/state)
 *   - Session binding (run:create → state file with run association)
 *   - Stop hook handler (approve/block decision)
 *   - Session-start hook handler (env file + baseline state file)
 *   - Hook dispatcher path (CLAUDE_PLUGIN_ROOT-based lookup)
 */

import * as path from "node:path";
import { existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { loadJournal, appendEvent } from "../storage/journal";
import { readRunMetadata } from "../storage/runFiles";
import { buildEffectIndex } from "../runtime/replay/effectIndex";
import { resolveCompletionProof } from "../cli/completionProof";
import type { EffectRecord } from "../runtime/types";
import { discoverSkillsInternal } from "../cli/commands/skill";
import {
  readSessionFile,
  sessionFileExists,
  getSessionFilePath,
  writeSessionFile,
  deleteSessionFile,
  updateSessionState,
  getCurrentTimestamp,
  updateIterationTimes,
  isIterationTooFast,
} from "../session";
import type { SessionState } from "../session";
import {
  parseTranscriptLastAssistantMessage,
  extractPromiseTag,
} from "../cli/commands/session";
import type {
  HarnessAdapter,
  SessionBindOptions,
  SessionBindResult,
  HookHandlerArgs,
} from "./types";

// ---------------------------------------------------------------------------
// Structured file logger (moved from hookRun.ts)
// ---------------------------------------------------------------------------

interface HookLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  setContext(key: string, value: string): void;
}

function createHookLogger(hookName: string): HookLogger {
  const logDir = process.env.BABYSITTER_LOG_DIR || '.a5c/logs';
  const logFile = logDir ? path.join(logDir, `${hookName}.log`) : null;
  const context: Record<string, string> = {};

  if (logFile) {
    try {
      mkdirSync(logDir, { recursive: true });
    } catch {
      // Best-effort
    }
  }

  function write(level: string, message: string): void {
    if (!logFile) return;
    const ts = new Date().toISOString();
    const ctxParts = Object.entries(context).map(
      ([k, v]) => `${k}=${v}`,
    );
    const ctxStr = ctxParts.length > 0 ? ` [${ctxParts.join(" ")}]` : "";
    const line = `[${level}] ${ts}${ctxStr} ${message}\n`;
    try {
      appendFileSync(logFile, line);
    } catch {
      // Best-effort
    }
  }

  return {
    info: (msg: string) => write("INFO", msg),
    warn: (msg: string) => write("WARN", msg),
    error: (msg: string) => write("ERROR", msg),
    setContext: (key: string, value: string) => {
      context[key] = value;
    },
  };
}

async function appendStopHookEvent(
  runDir: string,
  data: {
    sessionId: string;
    iteration: number;
    decision: "approve" | "block";
    reason: string;
    runState: string;
    pendingKinds: string;
    hasPromise: boolean;
  },
): Promise<void> {
  try {
    await appendEvent({
      runDir,
      eventType: "STOP_HOOK_INVOKED",
      event: {
        ...data,
        timestamp: new Date().toISOString(),
      },
    });
  } catch {
    // Best-effort: don't fail the hook if journal write fails
  }
}

// ---------------------------------------------------------------------------
// Stdin reader
// ---------------------------------------------------------------------------

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Hook input parsing
// ---------------------------------------------------------------------------

interface ClaudeCodeStopHookInput {
  session_id?: string;
  transcript_path?: string;
}

interface ClaudeCodeSessionStartHookInput {
  session_id?: string;
}

function parseHookInput(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Malformed JSON — treat as empty
  }
  return {};
}

function safeStr(obj: Record<string, unknown>, key: string): string {
  const val = obj[key];
  return typeof val === "string" ? val : "";
}

// ---------------------------------------------------------------------------
// Pending-by-kind helper
// ---------------------------------------------------------------------------

function countPendingByKind(records: EffectRecord[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const record of records) {
    const key = record.kind ?? "unknown";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries(
    Array.from(counts.entries()).sort(([a], [b]) => a.localeCompare(b)),
  );
}

// ---------------------------------------------------------------------------
// Cleanup helper
// ---------------------------------------------------------------------------

async function cleanupSession(filePath: string): Promise<void> {
  try {
    await deleteSessionFile(filePath);
  } catch {
    // Best-effort cleanup
  }
}

// ---------------------------------------------------------------------------
// Stop hook handler
// ---------------------------------------------------------------------------

async function handleStopHookImpl(args: HookHandlerArgs): Promise<number> {
  const { verbose } = args;
  const log = createHookLogger("babysitter-stop-hook");
  log.info("handleHookRunStop started");

  // 1. Read hook input JSON from stdin
  let rawInput: string;
  try {
    rawInput = await readStdin();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.warn(`stdin read error: ${msg}`);
    if (verbose) {
      process.stderr.write(`[hook:run stop] stdin read error: ${msg}\n`);
    }
    process.stdout.write('{"decision":"approve"}\n');
    return 0;
  }

  const hookInput = parseHookInput(rawInput) as ClaudeCodeStopHookInput;
  log.info("Hook input received");

  const sessionId = safeStr(hookInput as Record<string, unknown>, "session_id");
  if (!sessionId) {
    log.info("No session ID in hook input — allowing exit");
    if (verbose) {
      process.stderr.write("[hook:run stop] No session ID in hook input\n");
    }
    process.stdout.write('{"decision":"approve"}\n');
    return 0;
  }

  log.setContext("session", sessionId);
  log.info(`Session ID: ${sessionId}`);

  // 2. Resolve pluginRoot and stateDir (always resolve to absolute paths)
  const pluginRoot =
    args.pluginRoot || process.env.CLAUDE_PLUGIN_ROOT || "";
  const resolvedPluginRoot = pluginRoot ? path.resolve(pluginRoot) : "";
  const stateDir =
    args.stateDir
      ? path.resolve(args.stateDir)
      : (resolvedPluginRoot ? path.resolve(resolvedPluginRoot, "skills", "babysit", "state") : "");

  if (!stateDir) {
    log.warn("Cannot determine state directory — allowing exit");
    if (verbose) {
      process.stderr.write(
        "[hook:run stop] Cannot determine state directory\n",
      );
    }
    process.stdout.write('{"decision":"approve"}\n');
    return 0;
  }

  log.info(`Resolved pluginRoot: ${resolvedPluginRoot || "(empty)"}`);
  log.info(`Resolved stateDir: ${stateDir}`);

  const runsDir = args.runsDir || ".a5c/runs";

  // 3. Check iteration — try primary stateDir, then fallback to .a5c/state/
  let filePath = getSessionFilePath(stateDir, sessionId);
  log.info(`Checking session file at: ${filePath}`);

  let sessionFile;
  try {
    if (!(await sessionFileExists(filePath))) {
      // Fallback: check .a5c/state/ directory
      const fallbackStateDir = path.resolve(".a5c", "state");
      const fallbackPath = getSessionFilePath(fallbackStateDir, sessionId);
      log.info(`Primary state file not found, trying fallback: ${fallbackPath}`);
      if (await sessionFileExists(fallbackPath)) {
        filePath = fallbackPath;
        log.info(`Found session file at fallback path: ${filePath}`);
      } else {
        log.info(`No active loop found at primary (${filePath}) or fallback (${fallbackPath}) — allowing exit`);
        if (verbose) {
          process.stderr.write(
            `[hook:run stop] No active loop found for session ${sessionId}\n`,
          );
        }
        process.stdout.write('{"decision":"approve"}\n');
        return 0;
      }
    }
    sessionFile = await readSessionFile(filePath);
  } catch {
    log.warn(`Session file read error at ${filePath} — allowing exit`);
    process.stdout.write('{"decision":"approve"}\n');
    return 0;
  }

  const { state } = sessionFile;
  const prompt = sessionFile.prompt ?? "";

  // Check max iterations
  if (state.maxIterations > 0 && state.iteration >= state.maxIterations) {
    if (verbose) {
      process.stderr.write(
        `[hook:run stop] Max iterations (${state.maxIterations}) reached\n`,
      );
    }
    if (state.runId) {
      await appendStopHookEvent(path.join(runsDir, state.runId), {
        sessionId,
        iteration: state.iteration,
        decision: "approve",
        reason: "max_iterations_reached",
        runState: "",
        pendingKinds: "",
        hasPromise: false,
      });
    }
    await cleanupSession(filePath);
    process.stdout.write('{"decision":"approve"}\n');
    return 0;
  }

  // Check iteration timing (runaway loop detection)
  const now = getCurrentTimestamp();
  const updatedTimes =
    state.iteration >= 5
      ? updateIterationTimes(state.iterationTimes, state.lastIterationAt, now)
      : state.iterationTimes;

  if (isIterationTooFast(updatedTimes)) {
    if (verbose) {
      const avg =
        updatedTimes.reduce((a, b) => a + b, 0) / updatedTimes.length;
      process.stderr.write(
        `[hook:run stop] Iteration too fast (avg ${avg}s)\n`,
      );
    }
    if (state.runId) {
      await appendStopHookEvent(path.join(runsDir, state.runId), {
        sessionId,
        iteration: state.iteration,
        decision: "approve",
        reason: "iteration_too_fast",
        runState: "",
        pendingKinds: "",
        hasPromise: false,
      });
    }
    await cleanupSession(filePath);
    process.stdout.write('{"decision":"approve"}\n');
    return 0;
  }

  const iteration = state.iteration;
  const maxIterations = state.maxIterations;
  const runId = state.runId ?? "";
  if (runId) {
    log.setContext("run", runId);
  }

  // 4. Parse transcript for last assistant message
  const transcriptPath = safeStr(
    hookInput as Record<string, unknown>,
    "transcript_path",
  );

  let lastText: string | null = null;
  let hasPromise = false;
  let promiseValue: string | null = null;

  if (transcriptPath) {
    const resolvedTranscript = path.resolve(transcriptPath);
    if (existsSync(resolvedTranscript)) {
      try {
        const content = readFileSync(resolvedTranscript, "utf-8");
        const parsed = parseTranscriptLastAssistantMessage(content);
        lastText = parsed.text;
        if (parsed.found && parsed.text) {
          promiseValue = extractPromiseTag(parsed.text);
          hasPromise = promiseValue !== null;
        }
      } catch {
        if (verbose) {
          process.stderr.write(
            `[hook:run stop] Transcript parse error: ${resolvedTranscript}\n`,
          );
        }
        await cleanupSession(filePath);
        process.stdout.write('{"decision":"approve"}\n');
        return 0;
      }
    } else {
      if (verbose) {
        process.stderr.write(
          `[hook:run stop] Transcript not found: ${resolvedTranscript}\n`,
        );
      }
      await cleanupSession(filePath);
      process.stdout.write('{"decision":"approve"}\n');
      return 0;
    }
  }

  if (!lastText) {
    if (verbose) {
      process.stderr.write(
        "[hook:run stop] No assistant text content found in transcript\n",
      );
    }
    await cleanupSession(filePath);
    process.stdout.write('{"decision":"approve"}\n');
    return 0;
  }

  // 4b. If no run is associated, there's nothing to iterate on — allow exit
  if (!runId) {
    log.info("No run associated with session — allowing exit");
    if (verbose) {
      process.stderr.write(
        `[hook:run stop] No run associated with session ${sessionId} — allowing exit\n`,
      );
    }
    await cleanupSession(filePath);
    process.stdout.write('{"decision":"approve"}\n');
    return 0;
  }

  // 5. If runId is present, get run status
  let runState = "";
  let completionProof = "";
  let pendingKinds = "";

  if (runId) {
    try {
      const runDir = path.isAbsolute(runId)
        ? runId
        : path.join(runsDir, runId);
      const metadata = await readRunMetadata(runDir);
      const journal = await loadJournal(runDir);
      const index = await buildEffectIndex({ runDir, events: journal });

      const hasCompleted = journal.some((e) => e.type === "RUN_COMPLETED");
      const hasFailed = journal.some((e) => e.type === "RUN_FAILED");

      const pendingRecords = index.listPendingEffects();
      const pendingByKind = countPendingByKind(pendingRecords);
      const kindKeys = Object.keys(pendingByKind);
      if (kindKeys.length > 0) {
        pendingKinds = kindKeys.join(", ");
      }

      if (hasCompleted) {
        runState = "completed";
        completionProof = resolveCompletionProof(metadata);
      } else if (hasFailed) {
        runState = "failed";
      } else if (pendingRecords.length > 0) {
        runState = "waiting";
      } else {
        runState = "created";
      }
    } catch {
      runState = "";
    }

    log.info(`Run state: ${runState || "unknown"}`);
    if (completionProof) {
      log.info("Completion proof available");
    }

    if (!runState) {
      if (verbose) {
        process.stderr.write(
          `[hook:run stop] Run state is empty for ${runId}; run may be misconfigured\n`,
        );
      }
      if (runId) {
        await appendStopHookEvent(path.join(runsDir, runId), {
          sessionId,
          iteration: state.iteration,
          decision: "approve",
          reason: "run_state_unknown",
          runState,
          pendingKinds,
          hasPromise,
        });
      }
      await cleanupSession(filePath);
      process.stdout.write('{"decision":"approve"}\n');
      return 0;
    }
  }

  // 6. If completionProof matches promiseValue → complete
  if (hasPromise) {
    log.info("Detected valid promise tag");
  }
  if (completionProof && hasPromise && promiseValue === completionProof) {
    log.info("Promise matches completion proof — allowing exit");
    if (verbose) {
      process.stderr.write(
        `[hook:run stop] Valid promise tag detected - run complete\n`,
      );
    }
    if (runId) {
      await appendStopHookEvent(path.join(runsDir, runId), {
        sessionId,
        iteration: state.iteration,
        decision: "approve",
        reason: "completion_proof_matched",
        runState,
        pendingKinds,
        hasPromise,
      });
    }
    await cleanupSession(filePath);
    process.stdout.write('{"decision":"approve"}\n');
    return 0;
  }

  // 7. Not complete → continue loop
  if (!prompt) {
    if (verbose) {
      process.stderr.write(
        `[hook:run stop] State file corrupted - no prompt text\n`,
      );
    }
    if (runId) {
      await appendStopHookEvent(path.join(runsDir, runId), {
        sessionId,
        iteration: state.iteration,
        decision: "approve",
        reason: "no_prompt_text",
        runState,
        pendingKinds,
        hasPromise,
      });
    }
    await cleanupSession(filePath);
    process.stdout.write('{"decision":"approve"}\n');
    return 0;
  }

  const nextIteration = iteration + 1;
  const currentTime = getCurrentTimestamp();

  // Update session state
  const updatedState: SessionState = {
    ...state,
    iteration: nextIteration,
    lastIterationAt: currentTime,
    iterationTimes: updatedTimes,
  };

  try {
    await writeSessionFile(filePath, updatedState, prompt);
  } catch {
    if (verbose) {
      process.stderr.write(
        `[hook:run stop] Failed to update session state\n`,
      );
    }
  }

  // 8. Build system message
  let systemMessage: string;

  if (completionProof) {
    systemMessage = `\u{1F504} Babysitter iteration ${nextIteration} | Run completed! To finish: agent must call 'run:status --json' on your run, extract 'completionProof' from the output, then output it in <promise>SECRET</promise> tags. Do not mention or reveal the secret otherwise.`;
  } else if (runState === "waiting" && pendingKinds) {
    systemMessage = `\u{1F504} Babysitter iteration ${nextIteration} | Waiting on: ${pendingKinds}. Check if pending effects are resolved, then call run:iterate.`;
  } else if (runState === "failed") {
    systemMessage = `\u{1F504} Babysitter iteration ${nextIteration} | Failed. agent must fix the run, journal or process (inspect the sdk.md if needed) and proceed.`;
  } else {
    systemMessage = `\u{1F504} Babysitter iteration ${nextIteration} | Agent should continue orchestration (run:iterate)`;
  }

  // 9. Try to resolve skill context
  if (resolvedPluginRoot) {
    try {
      const discoverResult = await discoverSkillsInternal({
        pluginRoot: resolvedPluginRoot,
        runId: runId || undefined,
        runsDir,
      });
      if (discoverResult.summary) {
        systemMessage = `${systemMessage} | Available skills for this task: ${discoverResult.summary}. Use the Skill tool or skill-discovery to load any of these.`;
      }
    } catch {
      // Skill discovery failure is non-fatal
    }
  }

  // Cap system message at 1200 chars
  if (systemMessage.length > 1200) {
    systemMessage = systemMessage.slice(0, 1197) + "...";
  }

  // 10. Output block decision
  const output = {
    decision: "block",
    instructions:
      "use the babysitter skill to advance the orchestration to the next state (run:iterate) or perform the pending effects (task:list --pending --json), or fix the run if it failed.",
    reason: prompt,
    systemMessage,
  };

  if (runId) {
    await appendStopHookEvent(path.join(runsDir, runId), {
      sessionId,
      iteration: state.iteration,
      decision: "block",
      reason: "continue_loop",
      runState,
      pendingKinds,
      hasPromise,
    });
  }

  process.stdout.write(JSON.stringify(output) + "\n");

  log.info(
    `Decision: block (iteration=${nextIteration}, maxIterations=${maxIterations})`,
  );

  if (verbose) {
    process.stderr.write(
      `[hook:run stop] Blocking stop, iteration=${nextIteration} maxIterations=${maxIterations}\n`,
    );
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Session-start hook handler
// ---------------------------------------------------------------------------

async function handleSessionStartHookImpl(
  args: HookHandlerArgs,
): Promise<number> {
  const { verbose } = args;

  // 1. Read hook input JSON from stdin
  let rawInput: string;
  try {
    rawInput = await readStdin();
  } catch {
    process.stdout.write("{}\n");
    return 0;
  } finally {
    // Unref stdin so it doesn't keep the event loop alive.
    // Guard: unref() may not exist in all environments (e.g. non-socket stdin).
    if (typeof process.stdin.unref === "function") {
      process.stdin.unref();
    }
  }

  const hookInput = parseHookInput(rawInput) as ClaudeCodeSessionStartHookInput;
  const sessionId = safeStr(
    hookInput as Record<string, unknown>,
    "session_id",
  );

  if (!sessionId) {
    process.stdout.write("{}\n");
    return 0;
  }

  // 2. If CLAUDE_ENV_FILE is set, append session ID export
  const envFile = process.env.CLAUDE_ENV_FILE;
  if (envFile) {
    try {
      appendFileSync(envFile, `export CLAUDE_SESSION_ID="${sessionId}"\n`);
    } catch {
      if (verbose) {
        process.stderr.write(
          `[hook:run session-start] Failed to write to CLAUDE_ENV_FILE: ${envFile}\n`,
        );
      }
    }
  }

  // 3. Create baseline session state file so the stop hook can find it later.
  const pluginRoot =
    args.pluginRoot || process.env.CLAUDE_PLUGIN_ROOT || "";
  const resolvedPluginRoot = pluginRoot ? path.resolve(pluginRoot) : "";
  const stateDir =
    args.stateDir
      ? path.resolve(args.stateDir)
      : (resolvedPluginRoot ? path.resolve(resolvedPluginRoot, "skills", "babysit", "state") : "");

  if (stateDir) {
    const filePath = getSessionFilePath(stateDir, sessionId);
    try {
      if (!(await sessionFileExists(filePath))) {
        const nowTs = getCurrentTimestamp();
        const state: SessionState = {
          active: true,
          iteration: 1,
          maxIterations: 256,
          runId: "",
          startedAt: nowTs,
          lastIterationAt: nowTs,
          iterationTimes: [],
        };
        await writeSessionFile(filePath, state, "");
        if (verbose) {
          process.stderr.write(
            `[hook:run session-start] Created session state: ${filePath}\n`,
          );
        }
      }
    } catch {
      if (verbose) {
        process.stderr.write(
          `[hook:run session-start] Failed to create session state in ${stateDir}\n`,
        );
      }
    }
  }

  if (verbose) {
    process.stderr.write(
      `Babysitter session started: ${sessionId}\n`,
    );
  }

  // 4. Output empty object
  process.stdout.write("{}\n");
  return 0;
}

// ---------------------------------------------------------------------------
// Session binding (run:create flow)
// ---------------------------------------------------------------------------

async function bindSessionImpl(
  opts: SessionBindOptions,
): Promise<SessionBindResult> {
  const { sessionId, runId, pluginRoot, maxIterations = 256, prompt, verbose } = opts;

  // Resolve state directory (always resolve to absolute paths)
  const resolvedPluginRoot = pluginRoot ? path.resolve(pluginRoot) : "";
  let stateDir = opts.stateDir ? path.resolve(opts.stateDir) : "";
  if (!stateDir && resolvedPluginRoot) {
    stateDir = path.resolve(resolvedPluginRoot, "skills", "babysit", "state");
  }
  if (!stateDir) {
    return {
      harness: "claude-code",
      sessionId,
      error: "Cannot bind session: --state-dir or --plugin-root required for claude-code harness",
    };
  }

  const filePath = getSessionFilePath(stateDir, sessionId);

  // Check for existing session (prevent re-entrant runs)
  if (await sessionFileExists(filePath)) {
    try {
      const existing = await readSessionFile(filePath);
      if (existing.state.runId && existing.state.runId !== runId) {
        return {
          harness: "claude-code",
          sessionId,
          stateFile: filePath,
          error: `Session already associated with run: ${existing.state.runId}`,
        };
      }
      // Session exists but has no run or same run — update it
      await updateSessionState(filePath, { runId, active: true }, {
        state: existing.state,
        prompt: existing.prompt,
      });
      if (verbose) {
        process.stderr.write(
          `[run:create] Updated existing session ${sessionId} with run ${runId}\n`,
        );
      }
      return { harness: "claude-code", sessionId, stateFile: filePath };
    } catch {
      // Corrupted state file — overwrite it
    }
  }

  // Create new session state file with run already associated
  const nowTs = getCurrentTimestamp();
  const state: SessionState = {
    active: true,
    iteration: 1,
    maxIterations,
    runId,
    startedAt: nowTs,
    lastIterationAt: nowTs,
    iterationTimes: [],
  };

  try {
    await writeSessionFile(filePath, state, prompt);
  } catch (e) {
    return {
      harness: "claude-code",
      sessionId,
      error: `Failed to write session state: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  if (verbose) {
    process.stderr.write(
      `[run:create] Session ${sessionId} initialized and bound to run ${runId}\n`,
    );
  }

  return { harness: "claude-code", sessionId, stateFile: filePath };
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

export function createClaudeCodeAdapter(): HarnessAdapter {
  return {
    name: "claude-code",

    isActive(): boolean {
      return !!(process.env.CLAUDE_SESSION_ID || process.env.CLAUDE_ENV_FILE);
    },

    resolveSessionId(parsed: { sessionId?: string }): string | undefined {
      if (parsed.sessionId) return parsed.sessionId;
      if (process.env.CLAUDE_SESSION_ID) return process.env.CLAUDE_SESSION_ID;

      // Fallback: read from CLAUDE_ENV_FILE (written by session-start hook)
      const envFile = process.env.CLAUDE_ENV_FILE;
      if (envFile) {
        try {
          const content = readFileSync(envFile, "utf-8");
          const match = content.match(/export CLAUDE_SESSION_ID="([^"]+)"/);
          if (match?.[1]) return match[1];
        } catch {
          // Non-fatal
        }
      }

      return undefined;
    },

    resolveStateDir(args: { stateDir?: string; pluginRoot?: string }): string | undefined {
      if (args.stateDir) return path.resolve(args.stateDir);
      const root = args.pluginRoot || process.env.CLAUDE_PLUGIN_ROOT;
      if (root) return path.resolve(root, "skills", "babysit", "state");
      return undefined;
    },

    resolvePluginRoot(args: { pluginRoot?: string }): string | undefined {
      const root = args.pluginRoot || process.env.CLAUDE_PLUGIN_ROOT;
      return root ? path.resolve(root) : undefined;
    },

    bindSession(opts: SessionBindOptions): Promise<SessionBindResult> {
      return bindSessionImpl(opts);
    },

    handleStopHook(args: HookHandlerArgs): Promise<number> {
      return handleStopHookImpl(args);
    },

    handleSessionStartHook(args: HookHandlerArgs): Promise<number> {
      return handleSessionStartHookImpl(args);
    },

    findHookDispatcherPath(_startCwd: string): string | null {
      const claudePluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
      if (claudePluginRoot) {
        const candidate = path.join(path.resolve(claudePluginRoot), "hooks", "hook-dispatcher.sh");
        if (existsSync(candidate)) return candidate;
      }
      return null;
    },
  };
}
