/**
 * Tests for the Gemini CLI harness adapter.
 *
 * Covers:
 *   - isActive() detection via env vars
 *   - resolveSessionId() from parsed args and env
 *   - AfterAgent hook (stop): approve, block, max-iterations, completion proof
 *   - SessionStart hook: creates baseline state file
 *   - bindSession(): creates/updates session state file
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleHookRun } from "../../cli/commands/hookRun";
import type { HookRunCommandArgs } from "../../cli/commands/hookRun";
import { createGeminiCliAdapter } from "../geminiCli";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  writeSessionFile,
  getSessionFilePath,
  getCurrentTimestamp,
  readSessionFile,
} from "../../session";
import type { SessionState } from "../../session";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "gemini-cli-test-"));
}

function callWithStdin(
  payload: string,
  args: HookRunCommandArgs,
): Promise<number> {
  const { Readable } = require("node:stream") as typeof import("node:stream");
  const fakeStdin = new Readable({
    read() {
      this.push(Buffer.from(payload, "utf8"));
      this.push(null);
    },
  });
  (fakeStdin as unknown as Record<string, unknown>).unref = () => {};

  const originalStdin = process.stdin;
  Object.defineProperty(process, "stdin", {
    value: fakeStdin,
    writable: true,
    configurable: true,
  });

  return handleHookRun(args).finally(() => {
    Object.defineProperty(process, "stdin", {
      value: originalStdin,
      writable: true,
      configurable: true,
    });
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;
let stateDir: string;
let stdoutChunks: string[];
let stderrChunks: string[];
let originalStdoutWrite: typeof process.stdout.write;
let originalStderrWrite: typeof process.stderr.write;

beforeEach(async () => {
  tmpDir = await makeTmpDir();
  stateDir = path.join(tmpDir, "state");
  await fs.mkdir(stateDir, { recursive: true });

  stdoutChunks = [];
  stderrChunks = [];

  originalStdoutWrite = process.stdout.write;
  originalStderrWrite = process.stderr.write;

  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutChunks.push(
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(),
    );
    return true;
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrChunks.push(
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(),
    );
    return true;
  }) as typeof process.stderr.write;
});

afterEach(async () => {
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
  vi.restoreAllMocks();
  // Clean up env vars
  delete process.env.GEMINI_SESSION_ID;
  delete process.env.GEMINI_PROJECT_DIR;
  delete process.env.GEMINI_CWD;
  try {
    await fs.rm(tmpDir, { recursive: true, force: true });
  } catch {
    // Ignore
  }
});

function getStdout(): string {
  return stdoutChunks.join("");
}

const baseArgs: HookRunCommandArgs = {
  hookType: "stop",
  harness: "gemini-cli",
  json: true,
};

// ---------------------------------------------------------------------------
// Adapter unit tests
// ---------------------------------------------------------------------------

describe("createGeminiCliAdapter", () => {
  it("has name 'gemini-cli'", () => {
    const adapter = createGeminiCliAdapter();
    expect(adapter.name).toBe("gemini-cli");
  });

  it("isActive() returns false when no Gemini env vars are set", () => {
    delete process.env.GEMINI_SESSION_ID;
    delete process.env.GEMINI_PROJECT_DIR;
    delete process.env.GEMINI_CWD;
    const adapter = createGeminiCliAdapter();
    expect(adapter.isActive()).toBe(false);
  });

  it("isActive() returns true when GEMINI_SESSION_ID is set", () => {
    process.env.GEMINI_SESSION_ID = "test-session-123";
    const adapter = createGeminiCliAdapter();
    expect(adapter.isActive()).toBe(true);
  });

  it("isActive() returns true when GEMINI_PROJECT_DIR is set", () => {
    process.env.GEMINI_PROJECT_DIR = "/tmp/project";
    const adapter = createGeminiCliAdapter();
    expect(adapter.isActive()).toBe(true);
  });

  it("resolveSessionId() returns parsed sessionId when provided", () => {
    const adapter = createGeminiCliAdapter();
    expect(adapter.resolveSessionId({ sessionId: "explicit-id" })).toBe(
      "explicit-id",
    );
  });

  it("resolveSessionId() falls back to GEMINI_SESSION_ID env var", () => {
    process.env.GEMINI_SESSION_ID = "env-session-456";
    const adapter = createGeminiCliAdapter();
    expect(adapter.resolveSessionId({})).toBe("env-session-456");
  });

  it("resolveSessionId() returns undefined when no env var set", () => {
    delete process.env.GEMINI_SESSION_ID;
    const adapter = createGeminiCliAdapter();
    expect(adapter.resolveSessionId({})).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AfterAgent (stop) hook tests via handleHookRun
// ---------------------------------------------------------------------------

describe("Gemini CLI AfterAgent hook (stop)", () => {
  it("allows exit when hook input has no session_id", async () => {
    const code = await callWithStdin(JSON.stringify({}), {
      ...baseArgs,
      stateDir,
    });
    expect(code).toBe(0);
    const output = JSON.parse(getStdout().trim()) as Record<string, unknown>;
    expect(output.decision).toBeUndefined();
  });

  it("allows exit when no session state file exists for session_id", async () => {
    const code = await callWithStdin(
      JSON.stringify({ session_id: "unknown-session-999" }),
      { ...baseArgs, stateDir },
    );
    expect(code).toBe(0);
    const output = JSON.parse(getStdout().trim()) as Record<string, unknown>;
    expect(output.decision).toBeUndefined();
  });

  it("allows exit when max iterations reached", async () => {
    const sessionId = "gemini-max-iter";
    const filePath = getSessionFilePath(stateDir, sessionId);
    const now = getCurrentTimestamp();
    const state: SessionState = {
      active: true,
      iteration: 50,
      maxIterations: 50,
      runId: "run-abc",
      startedAt: now,
      lastIterationAt: now,
      iterationTimes: [],
    };
    await writeSessionFile(filePath, state, "My task");

    const code = await callWithStdin(
      JSON.stringify({ session_id: sessionId }),
      { ...baseArgs, stateDir },
    );
    expect(code).toBe(0);
    const output = JSON.parse(getStdout().trim()) as Record<string, unknown>;
    expect(output.decision).toBeUndefined(); // approve (no decision = allow)
  });

  it("allows exit when session has no run associated", async () => {
    const sessionId = "gemini-no-run";
    const filePath = getSessionFilePath(stateDir, sessionId);
    const now = getCurrentTimestamp();
    const state: SessionState = {
      active: true,
      iteration: 1,
      maxIterations: 256,
      runId: "",
      startedAt: now,
      lastIterationAt: now,
      iterationTimes: [],
    };
    await writeSessionFile(filePath, state, "No run yet");

    const code = await callWithStdin(
      JSON.stringify({ session_id: sessionId }),
      { ...baseArgs, stateDir },
    );
    expect(code).toBe(0);
    const output = JSON.parse(getStdout().trim()) as Record<string, unknown>;
    expect(output.decision).toBeUndefined();
  });

  it("blocks when session is active with run and uses prompt_response for completion check", async () => {
    // Create a run directory with an active (non-completed) journal
    const runId = "gemini-active-run";
    const runsDir = path.join(tmpDir, "runs");
    const runDir = path.join(runsDir, runId);
    const journalDir = path.join(runDir, "journal");
    await fs.mkdir(journalDir, { recursive: true });

    const runMetadata = {
      schemaVersion: "2026.01.run-metadata",
      runId,
      processId: "test-process",
      entrypoint: { importPath: "/tmp/test.js", exportName: "process" },
      layoutVersion: 1,
      createdAt: new Date().toISOString(),
    };
    await fs.writeFile(
      path.join(runDir, "run.json"),
      JSON.stringify(runMetadata),
    );

    // Write RUN_CREATED event (run is active, not completed)
    const event = {
      type: "RUN_CREATED",
      recordedAt: new Date().toISOString(),
      data: { runId, processId: "test-process" },
      checksum: "abc123",
    };
    await fs.writeFile(
      path.join(journalDir, "000001.01ARZ3NDEKTSV4RRFFQ69G5FAV.json"),
      JSON.stringify(event),
    );

    // Create active session state
    const sessionId = "gemini-active-session";
    const filePath = getSessionFilePath(stateDir, sessionId);
    const now = getCurrentTimestamp();
    const state: SessionState = {
      active: true,
      iteration: 3,
      maxIterations: 100,
      runId,
      startedAt: now,
      lastIterationAt: now,
      iterationTimes: [],
    };
    await writeSessionFile(filePath, state, "Continue the run");

    // Use prompt_response (Gemini CLI style) — no promise tag
    const code = await callWithStdin(
      JSON.stringify({
        session_id: sessionId,
        prompt_response: "I ran run:iterate and posted the result.",
      }),
      { ...baseArgs, stateDir, runsDir },
    );
    expect(code).toBe(0);
    const output = JSON.parse(getStdout().trim()) as Record<string, unknown>;
    expect(output.decision).toBe("block");
    expect(output.systemMessage).toContain("iteration 4");
    expect(output.reason).toBeTruthy();
    expect(typeof output.reason).toBe("string");

    // Verify session state was incremented
    const updated = await readSessionFile(filePath);
    expect(updated.state.iteration).toBe(4);
  });

  it("reads session_id from GEMINI_SESSION_ID env var when not in input", async () => {
    const sessionId = "env-var-session";
    process.env.GEMINI_SESSION_ID = sessionId;

    // No session file → should still allow exit (no active loop)
    const code = await callWithStdin(
      JSON.stringify({}), // no session_id in input
      { ...baseArgs, stateDir },
    );
    expect(code).toBe(0);
    // No session file, so should approve
    const output = JSON.parse(getStdout().trim()) as Record<string, unknown>;
    expect(output.decision).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// SessionStart hook tests
// ---------------------------------------------------------------------------

describe("Gemini CLI SessionStart hook", () => {
  it("creates a baseline session state file", async () => {
    const sessionId = "gemini-session-start-test";

    const code = await callWithStdin(
      JSON.stringify({ session_id: sessionId }),
      {
        hookType: "session-start",
        harness: "gemini-cli",
        stateDir,
        json: true,
      },
    );
    expect(code).toBe(0);
    expect(getStdout().trim()).toBe("{}");

    // Verify state file was created
    const filePath = getSessionFilePath(stateDir, sessionId);
    const exists = await fs
      .access(filePath)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);

    // Verify baseline state (no run associated)
    const content = await fs.readFile(filePath, "utf8");
    expect(content).toContain("active: true");
    expect(content).toContain("iteration: 1");
    expect(content).toContain('run_id: ""');
  });

  it("does not overwrite existing session state", async () => {
    const sessionId = "gemini-existing-session";
    const filePath = getSessionFilePath(stateDir, sessionId);
    const now = getCurrentTimestamp();
    const existingState: SessionState = {
      active: true,
      iteration: 7,
      maxIterations: 256,
      runId: "existing-run-xyz",
      startedAt: now,
      lastIterationAt: now,
      iterationTimes: [],
    };
    await writeSessionFile(filePath, existingState, "Existing prompt");

    const code = await callWithStdin(
      JSON.stringify({ session_id: sessionId }),
      {
        hookType: "session-start",
        harness: "gemini-cli",
        stateDir,
        json: true,
      },
    );
    expect(code).toBe(0);

    // Existing state should be preserved
    const content = await fs.readFile(filePath, "utf8");
    expect(content).toContain("iteration: 7");
    expect(content).toContain('run_id: "existing-run-xyz"');
  });

  it("outputs empty JSON object when no session_id in input", async () => {
    const code = await callWithStdin(JSON.stringify({}), {
      hookType: "session-start",
      harness: "gemini-cli",
      stateDir,
      json: true,
    });
    expect(code).toBe(0);
    expect(getStdout().trim()).toBe("{}");
  });
});

// ---------------------------------------------------------------------------
// bindSession tests
// ---------------------------------------------------------------------------

describe("Gemini CLI bindSession", () => {
  it("creates a new session state file bound to a run", async () => {
    const adapter = createGeminiCliAdapter();
    const sessionId = "gemini-bind-session";

    const result = await adapter.bindSession({
      sessionId,
      runId: "new-run-abc",
      maxIterations: 50,
      prompt: "Build a REST API",
      stateDir,
    });

    expect(result.harness).toBe("gemini-cli");
    expect(result.sessionId).toBe(sessionId);
    expect(result.error).toBeUndefined();

    const filePath = getSessionFilePath(stateDir, sessionId);
    const content = await fs.readFile(filePath, "utf8");
    expect(content).toContain('run_id: "new-run-abc"');
    expect(content).toContain("max_iterations: 50");
    expect(content).toContain("Build a REST API");
  });

  it("updates existing session with run ID", async () => {
    const adapter = createGeminiCliAdapter();
    const sessionId = "gemini-update-session";
    const filePath = getSessionFilePath(stateDir, sessionId);

    // Create session without run
    const now = getCurrentTimestamp();
    const state: SessionState = {
      active: true,
      iteration: 1,
      maxIterations: 256,
      runId: "",
      startedAt: now,
      lastIterationAt: now,
      iterationTimes: [],
    };
    await writeSessionFile(filePath, state, "Initial prompt");

    const result = await adapter.bindSession({
      sessionId,
      runId: "updated-run-xyz",
      stateDir,
    });

    expect(result.error).toBeUndefined();

    const content = await fs.readFile(filePath, "utf8");
    expect(content).toContain('run_id: "updated-run-xyz"');
  });

  it("returns error when session already associated with different run", async () => {
    const adapter = createGeminiCliAdapter();
    const sessionId = "gemini-conflict-session";
    const filePath = getSessionFilePath(stateDir, sessionId);

    const now = getCurrentTimestamp();
    const state: SessionState = {
      active: true,
      iteration: 3,
      maxIterations: 256,
      runId: "existing-run-999",
      startedAt: now,
      lastIterationAt: now,
      iterationTimes: [],
    };
    await writeSessionFile(filePath, state, "Already running");

    const result = await adapter.bindSession({
      sessionId,
      runId: "new-conflicting-run",
      stateDir,
    });

    expect(result.error).toContain("existing-run-999");
  });
});
