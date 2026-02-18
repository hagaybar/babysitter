import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import {
  buildImage,
  dockerExec,
  dockerExecSafe,
  PLUGIN_DIR,
  startContainer,
  stopContainer,
} from "./helpers";
import path from "path";

const ROOT = path.resolve(__dirname, "../..");
const HOOK = `${PLUGIN_DIR}/hooks/babysitter-stop-hook.sh`;
// The stop hook hardcodes STATE_DIR="$PLUGIN_ROOT/skills/babysit/state",
// so we must use the same directory for session init calls.
const STATE_DIR = `${PLUGIN_DIR}/skills/babysit/state`;
const LOG_DIR = "/tmp/hook-test-logs";
const HOOK_ENV = `CLAUDE_PLUGIN_ROOT=${PLUGIN_DIR} BABYSITTER_LOG_DIR=${LOG_DIR} CLI=babysitter`;

beforeAll(() => {
  buildImage(ROOT);
  startContainer();
  dockerExec(`mkdir -p ${STATE_DIR} ${LOG_DIR}`);
}, 300_000);

afterAll(() => {
  stopContainer();
});

afterEach(() => {
  dockerExec(`rm -rf ${STATE_DIR}/* ${LOG_DIR}/* 2>/dev/null || true`);
});

/** Write a hook input file and run the stop hook, reading from that file. */
function runHook(sessionId: string, transcriptPath: string): { stdout: string; exitCode: number } {
  const inputFile = `/tmp/hook-input-${Date.now()}.json`;
  const inputJson = JSON.stringify({ session_id: sessionId, transcript_path: transcriptPath });

  // Write input to file, pipe it to the hook, then clean up
  const cmd = [
    `printf '%s' '${inputJson.replace(/'/g, "'\\''")}' > ${inputFile}`,
    `${HOOK_ENV} bash ${HOOK} < ${inputFile}; echo "EXIT_CODE=$?"`,
    `rm -f ${inputFile}`,
  ].join(" ; ");

  const { stdout, exitCode: rawExitCode } = dockerExecSafe(cmd);

  // Extract the actual exit code from the output
  const lines = stdout.split("\n");
  const exitLine = lines.find((l) => l.startsWith("EXIT_CODE="));
  const exitCode = exitLine ? parseInt(exitLine.split("=")[1], 10) : rawExitCode;
  const output = lines.filter((l) => !l.startsWith("EXIT_CODE=")).join("\n").trim();

  return { stdout: output, exitCode };
}

/** Extract a JSON object from multi-line hook output (jq pretty-prints). */
function parseJsonBlock(output: string): Record<string, unknown> | undefined {
  // Try parsing the entire output as JSON first
  try {
    return JSON.parse(output);
  } catch {
    // Fall back to extracting { ... } block from mixed output
    const match = output.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

/** Create a mock JSONL transcript file inside the container. */
function createTranscript(filePath: string, text: string): void {
  const line = JSON.stringify({
    role: "assistant",
    message: { content: [{ type: "text", text }] },
  });
  // Use printf to avoid echo interpretation issues
  dockerExec(`printf '%s\\n' '${line.replace(/'/g, "'\\''")}' > ${filePath}`);
}

describe("Stop hook lifecycle", () => {
  test("exits 0 (allows exit) when no session state exists", () => {
    const { exitCode, stdout } = runHook(
      "nonexistent-session-" + Date.now(),
      "/dev/null",
    );
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain('"decision"');
  });

  test("blocks exit when active session state exists", () => {
    const sid = "active-" + Date.now();
    const transcriptFile = "/tmp/hook-transcript-active.jsonl";

    // Init session
    dockerExec(
      `babysitter session:init --session-id ${sid} --state-dir ${STATE_DIR} --prompt "test orchestration" --json`,
    );

    // Create transcript
    createTranscript(transcriptFile, "some assistant output here");

    // Run hook
    const { exitCode, stdout } = runHook(sid, transcriptFile);

    expect(exitCode).toBe(0);
    // Hook outputs multi-line JSON via jq - parse the complete output
    const output = parseJsonBlock(stdout);
    expect(output).toBeDefined();
    expect(output!.decision).toBe("block");
    expect(output!.reason).toBe("test orchestration");
    expect(output!.systemMessage).toContain("iteration");

    dockerExec(`rm -f ${transcriptFile}`);
  });

  test("increments iteration counter on each invocation", () => {
    const sid = "iter-" + Date.now();
    const transcriptFile = "/tmp/hook-transcript-iter.jsonl";

    dockerExec(
      `babysitter session:init --session-id ${sid} --state-dir ${STATE_DIR} --prompt "counting test" --json`,
    );
    createTranscript(transcriptFile, "iteration output");

    // First invocation
    const first = runHook(sid, transcriptFile);
    const firstOut = parseJsonBlock(first.stdout);
    expect(firstOut).toBeDefined();
    expect(firstOut!.systemMessage).toContain("iteration 2");

    // Second invocation
    const second = runHook(sid, transcriptFile);
    const secondOut = parseJsonBlock(second.stdout);
    expect(secondOut).toBeDefined();
    expect(secondOut!.systemMessage).toContain("iteration 3");

    // Verify state
    const stateOut = dockerExec(
      `babysitter session:state --session-id ${sid} --state-dir ${STATE_DIR} --json`,
    ).trim();
    const state = JSON.parse(stateOut);
    expect(state.state.iteration).toBe(3);

    dockerExec(`rm -f ${transcriptFile}`);
  });

  test("detects completion proof and allows exit", () => {
    const sid = "complete-" + Date.now();
    const runDir = "/tmp/hook-test-run";
    const transcriptFile = "/tmp/hook-transcript-complete.jsonl";

    // The SDK derives completionProof from runId via sha256("runId:babysitter-completion-secret-v1")
    // For runId "test-run" the derived secret is:
    const secret =
      "db5801f37401e3b014de18ccd168d317c96e3c4154702cfd5ab38d507608da17";

    // Create a mock completed run with proper journal events
    // (run:status derives state from journal, not from run.json)
    dockerExec(`mkdir -p ${runDir}/journal ${runDir}/state`);
    dockerExec(
      `printf '%s' '{"runId":"test-run","processId":"test"}' > ${runDir}/run.json`,
    );
    dockerExec(
      `printf '%s' '{"seq":1,"ulid":"01TEST1","type":"RUN_CREATED","recordedAt":"2026-01-01T00:00:00Z","data":{}}' > ${runDir}/journal/000001.01TEST1.json`,
    );
    dockerExec(
      `printf '%s' '{"seq":2,"ulid":"01TEST2","type":"RUN_COMPLETED","recordedAt":"2026-01-01T00:01:00Z","data":{"outputRef":"state/output.json"}}' > ${runDir}/journal/000002.01TEST2.json`,
    );

    // Init session with run-id
    dockerExec(
      `babysitter session:init --session-id ${sid} --state-dir ${STATE_DIR} --prompt "complete test" --run-id ${runDir} --json`,
    );

    // Create transcript with promise tag containing the derived secret
    createTranscript(
      transcriptFile,
      `Done! <promise>${secret}</promise>`,
    );

    const { exitCode, stdout } = runHook(sid, transcriptFile);

    expect(exitCode).toBe(0);
    // Should NOT output block JSON (should allow exit)
    const parsed = parseJsonBlock(stdout);
    expect(parsed?.decision).not.toBe("block");

    // Session state should be deleted
    const stateOut = dockerExec(
      `babysitter session:state --session-id ${sid} --state-dir ${STATE_DIR} --json`,
    ).trim();
    const state = JSON.parse(stateOut);
    expect(state.found).toBe(false);

    dockerExec(`rm -rf ${runDir} ${transcriptFile}`);
  });

  test("handles missing transcript gracefully", () => {
    const sid = "missing-" + Date.now();

    dockerExec(
      `babysitter session:init --session-id ${sid} --state-dir ${STATE_DIR} --prompt "test" --json`,
    );

    const { exitCode } = runHook(sid, "/nonexistent/path/transcript.jsonl");
    expect(exitCode).toBe(0);
  });

  test("handles empty JSON input gracefully", () => {
    // Write empty JSON directly
    const inputFile = `/tmp/hook-input-empty-${Date.now()}.json`;
    const { stdout } = dockerExecSafe(
      `printf '{}' > ${inputFile} && ${HOOK_ENV} bash ${HOOK} < ${inputFile}; echo "EXIT_CODE=$?" && rm -f ${inputFile}`,
    );
    const exitLine = stdout.split("\n").find((l) => l.startsWith("EXIT_CODE="));
    const exitCode = exitLine ? parseInt(exitLine.split("=")[1], 10) : -1;
    expect(exitCode).toBe(0);
  });
});
