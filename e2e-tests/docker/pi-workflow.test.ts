/**
 * Pi harness full workflow E2E tests.
 *
 * Exercises the complete babysitter orchestration lifecycle the way
 * oh-my-pi actually uses it: through direct SDK function calls
 * (createRun, orchestrateIteration, commitEffectResult), NOT through
 * the babysitter CLI.  This mirrors the real Pi extension code in
 * plugins/pi/extensions/babysitter/sdk-bridge.ts.
 *
 * No LLM / API key required -- effects are manually resolved.
 *
 * Verifies: SDK-driven run creation, iteration producing pending
 * effects, commitEffectResult resolving them, journal lifecycle
 * (RUN_CREATED -> EFFECT_REQUESTED -> EFFECT_RESOLVED -> RUN_COMPLETED),
 * completion proof, and run status derivation from journal.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  buildImage,
  dockerExec,
  startContainer,
  stopContainer,
} from "./helpers";
import path from "path";

const ROOT = path.resolve(__dirname, "../..");

// Ensure NODE_PATH includes the global npm root so process files and
// inline scripts can resolve '@a5c-ai/babysitter-sdk'.
const NP = "export NODE_PATH=$(npm root -g) &&";

/** Counter to create unique script filenames inside the container. */
let scriptCounter = 0;

/**
 * Run an inline Node.js script inside the Docker container that uses
 * the babysitter SDK directly (the way Pi does it).
 *
 * Writes the script to a temp file and executes it via `node`, avoiding
 * shell quoting issues with `node -e` and multiline scripts.
 * Returns parsed JSON from stdout.
 */
function runSdkScript<T = unknown>(script: string, timeout = 30_000): T {
  const scriptFile = `/tmp/_pi_test_${++scriptCounter}.js`;

  // Write script to a temp file inside the container using heredoc
  dockerExec(
    `cat > ${scriptFile} << 'SDKSCRIPTEOF'\n${script}\nSDKSCRIPTEOF`,
  );

  // Execute the script with NODE_PATH set
  const out = dockerExec(
    `${NP} node ${scriptFile}`,
    { timeout },
  ).trim();

  // Find and parse the last JSON object in the output
  const lastBrace = out.lastIndexOf("}");
  if (lastBrace === -1) throw new SyntaxError(`No JSON in output: ${out}`);
  let depth = 0;
  for (let i = lastBrace; i >= 0; i--) {
    if (out[i] === "}") depth++;
    if (out[i] === "{") depth--;
    if (depth === 0) return JSON.parse(out.slice(i, lastBrace + 1)) as T;
  }
  throw new SyntaxError(`Unmatched braces in output: ${out}`);
}

beforeAll(() => {
  buildImage(ROOT);
  startContainer();
}, 300_000);

afterAll(() => {
  stopContainer();
});

// ============================================================================
// Single-task process: full lifecycle via SDK API
// ============================================================================

describe("Pi SDK-driven single-task lifecycle", () => {
  const tag = `pi-sdk-${Date.now()}`;
  let runDir: string;
  let effectId: string;

  test("createRun via SDK creates a run directory with journal", () => {
    const procDir = `/tmp/${tag}`;
    dockerExec(`mkdir -p ${procDir}`);

    // Create a process file with one node task -- same as what Pi's
    // session-binder would dynamically create or reference
    dockerExec(
      `cat > ${procDir}/proc.js << 'PROCEOF'
const { defineTask } = require('@a5c-ai/babysitter-sdk');

const echoTask = defineTask('echo', (args, taskCtx) => ({
  kind: 'node',
  title: 'Echo task',
  node: { script: 'echo-script.js', args: [args.message] },
  io: {
    inputJsonPath: 'tasks/' + taskCtx.effectId + '/input.json',
    outputJsonPath: 'tasks/' + taskCtx.effectId + '/output.json',
  },
}));

exports.process = async function process(inputs, ctx) {
  const result = await ctx.task(echoTask, { message: inputs.message });
  return { status: 'success', echo: result.echo };
};
PROCEOF`,
    );

    // Use createRun directly -- same as sdk-bridge.createNewRun()
    const result = runSdkScript<{ runId: string; runDir: string }>(`
      const { createRun } = require('@a5c-ai/babysitter-sdk');
      const path = require('path');

      (async () => {
        const result = await createRun({
          runsDir: '/tmp/${tag}/runs',
          process: {
            processId: 'pi-echo',
            importPath: '/tmp/${tag}/proc.js',
            exportName: 'process',
          },
          inputs: { message: 'hello-pi' },
          prompt: 'pi lifecycle test',
        });
        console.log(JSON.stringify({
          runId: result.runId,
          runDir: result.runDir,
        }));
      })();
    `);

    expect(result.runId).toBeTruthy();
    expect(result.runDir).toBeTruthy();
    runDir = result.runDir;

    // Verify run.json and journal exist
    dockerExec(`test -f ${runDir}/run.json`);
    dockerExec(`test -d ${runDir}/journal`);
  });

  test("orchestrateIteration via SDK produces a pending effect", () => {
    // Call orchestrateIteration directly -- same as sdk-bridge.iterate()
    const result = runSdkScript<{
      status: string;
      nextActions: Array<{ effectId: string; kind: string }>;
    }>(`
      const { orchestrateIteration } = require('@a5c-ai/babysitter-sdk');

      (async () => {
        const result = await orchestrateIteration({
          runDir: '${runDir}',
        });
        console.log(JSON.stringify({
          status: result.status,
          nextActions: (result.nextActions || []).map(a => ({
            effectId: a.effectId,
            kind: a.kind,
          })),
        }));
      })();
    `);

    expect(result.status).toBe("waiting");
    expect(result.nextActions.length).toBe(1);
    expect(result.nextActions[0].kind).toBe("node");
    effectId = result.nextActions[0].effectId;
  });

  test("commitEffectResult via SDK resolves the effect", () => {
    // Post the result using commitEffectResult -- same as
    // sdk-bridge.postResult() / effect-executor.postEffectResult()
    const result = runSdkScript<{ effectId: string }>(`
      const { commitEffectResult } = require('@a5c-ai/babysitter-sdk');

      (async () => {
        const artifacts = await commitEffectResult({
          runDir: '${runDir}',
          effectId: '${effectId}',
          result: {
            status: 'ok',
            value: { echo: 'hello-pi' },
          },
        });
        console.log(JSON.stringify({ effectId: '${effectId}' }));
      })();
    `);

    expect(result.effectId).toBe(effectId);
  });

  test("second orchestrateIteration completes the run", () => {
    const result = runSdkScript<{
      status: string;
      hasOutput: boolean;
    }>(`
      const { orchestrateIteration } = require('@a5c-ai/babysitter-sdk');

      (async () => {
        const result = await orchestrateIteration({
          runDir: '${runDir}',
        });
        console.log(JSON.stringify({
          status: result.status,
          hasOutput: result.output !== undefined,
        }));
      })();
    `);

    expect(result.status).toBe("completed");
    expect(result.hasOutput).toBe(true);
  });

  test("journal has correct lifecycle events", () => {
    const result = runSdkScript<{ events: string[] }>(`
      const { loadJournal } = require('@a5c-ai/babysitter-sdk');

      (async () => {
        const journal = await loadJournal('${runDir}');
        const events = journal.map(e => e.type);
        console.log(JSON.stringify({ events }));
      })();
    `);

    expect(result.events[0]).toBe("RUN_CREATED");
    expect(result.events).toContain("EFFECT_REQUESTED");
    expect(result.events).toContain("EFFECT_RESOLVED");
    expect(result.events).toContain("RUN_COMPLETED");

    // RUN_COMPLETED comes after all EFFECT_RESOLVED
    const lastResolved = result.events.lastIndexOf("EFFECT_RESOLVED");
    const completed = result.events.indexOf("RUN_COMPLETED");
    expect(completed).toBeGreaterThan(lastResolved);
  });

  test("run status derived from journal matches completed", () => {
    // Derive status from journal the same way sdk-bridge.getRunStatus() does
    const result = runSdkScript<{
      status: string;
      pendingCount: number;
    }>(`
      const { loadJournal, readRunMetadata } = require('@a5c-ai/babysitter-sdk');

      (async () => {
        const journal = await loadJournal('${runDir}');
        let status = 'running';
        for (const entry of journal) {
          if (entry.type === 'RUN_COMPLETED') status = 'completed';
          else if (entry.type === 'RUN_FAILED') status = 'failed';
        }

        const resolved = new Set();
        const requested = new Set();
        for (const entry of journal) {
          const data = entry.data || {};
          if (entry.type === 'EFFECT_RESOLVED') resolved.add(data.effectId);
          if (entry.type === 'EFFECT_REQUESTED') requested.add(data.effectId);
        }
        const pendingCount = [...requested].filter(id => !resolved.has(id)).length;

        console.log(JSON.stringify({ status, pendingCount }));
      })();
    `);

    expect(result.status).toBe("completed");
    expect(result.pendingCount).toBe(0);
  });
});

// ============================================================================
// Multi-task process: sequential effects via SDK API
// ============================================================================

describe("Pi SDK-driven multi-task lifecycle", () => {
  const tag = `pi-multi-${Date.now()}`;
  let runDir: string;

  test("create run and iterate through two sequential tasks", () => {
    const procDir = `/tmp/${tag}`;
    dockerExec(`mkdir -p ${procDir}`);

    dockerExec(
      `cat > ${procDir}/proc.js << 'PROCEOF'
const { defineTask } = require('@a5c-ai/babysitter-sdk');

const stepA = defineTask('step-a', (args, taskCtx) => ({
  kind: 'node',
  title: 'Step A',
  node: { script: 'a.js' },
  io: {
    inputJsonPath: 'tasks/' + taskCtx.effectId + '/input.json',
    outputJsonPath: 'tasks/' + taskCtx.effectId + '/output.json',
  },
}));

const stepB = defineTask('step-b', (args, taskCtx) => ({
  kind: 'node',
  title: 'Step B',
  node: { script: 'b.js' },
  io: {
    inputJsonPath: 'tasks/' + taskCtx.effectId + '/input.json',
    outputJsonPath: 'tasks/' + taskCtx.effectId + '/output.json',
  },
}));

exports.process = async function process(inputs, ctx) {
  const a = await ctx.task(stepA, { n: 1 });
  const b = await ctx.task(stepB, { n: 2 });
  return { total: a.value + b.value };
};
PROCEOF`,
    );

    // Full lifecycle: createRun -> iterate -> commit -> iterate -> commit -> iterate (complete)
    // This is the exact loop Pi's loop-driver.onAgentEnd() drives
    const result = runSdkScript<{
      status: string;
      iterations: number;
      resolvedEffects: string[];
      runDir: string;
    }>(`
      const {
        createRun,
        orchestrateIteration,
        commitEffectResult,
      } = require('@a5c-ai/babysitter-sdk');

      (async () => {
        // 1. Create run (session-binder.bindRun)
        const run = await createRun({
          runsDir: '/tmp/${tag}/runs',
          process: {
            processId: 'pi-multi',
            importPath: '/tmp/${tag}/proc.js',
            exportName: 'process',
          },
          inputs: {},
          prompt: 'multi-task test',
        });

        const resolvedEffects = [];
        let iterations = 0;
        let lastResult;

        // 2. Iterate loop (loop-driver.onAgentEnd)
        for (let i = 0; i < 10; i++) {
          const iter = await orchestrateIteration({ runDir: run.runDir });
          iterations++;

          if (iter.status === 'completed' || iter.status === 'failed') {
            lastResult = iter;
            break;
          }

          // 3. Resolve pending effects (effect-executor.postEffectResult)
          if (iter.status === 'waiting' && iter.nextActions) {
            for (const action of iter.nextActions) {
              await commitEffectResult({
                runDir: run.runDir,
                effectId: action.effectId,
                result: { status: 'ok', value: { value: 10 } },
              });
              resolvedEffects.push(action.effectId);
            }
          }

          lastResult = iter;
        }

        console.log(JSON.stringify({
          status: lastResult?.status || 'unknown',
          iterations,
          resolvedEffects,
          runDir: run.runDir,
        }));
      })();
    `, 60_000);

    expect(result.status).toBe("completed");
    expect(result.resolvedEffects.length).toBe(2);
    // Sequential tasks need at least 3 iterations:
    // iter1 -> effect A requested, iter2 -> effect B requested, iter3 -> completed
    expect(result.iterations).toBeGreaterThanOrEqual(3);
    runDir = result.runDir;
  });

  test("journal has two EFFECT_REQUESTED and two EFFECT_RESOLVED", () => {
    const result = runSdkScript<{
      requested: number;
      resolved: number;
      hasCompleted: boolean;
    }>(`
      const { loadJournal } = require('@a5c-ai/babysitter-sdk');

      (async () => {
        const journal = await loadJournal('${runDir}');
        const types = journal.map(e => e.type);
        console.log(JSON.stringify({
          requested: types.filter(t => t === 'EFFECT_REQUESTED').length,
          resolved: types.filter(t => t === 'EFFECT_RESOLVED').length,
          hasCompleted: types.includes('RUN_COMPLETED'),
        }));
      })();
    `);

    expect(result.requested).toBe(2);
    expect(result.resolved).toBe(2);
    expect(result.hasCompleted).toBe(true);
  });
});

// ============================================================================
// Zero-task process: immediate completion
// ============================================================================

describe("Pi SDK-driven immediate completion", () => {
  test("process with no tasks completes on first iteration", () => {
    const tag = `pi-immediate-${Date.now()}`;
    const procDir = `/tmp/${tag}`;
    dockerExec(`mkdir -p ${procDir}`);

    dockerExec(
      `printf '%s' 'exports.process = async function(inputs, ctx) { return { ok: true }; };' > ${procDir}/proc.js`,
    );

    const result = runSdkScript<{
      status: string;
      hasOutput: boolean;
    }>(`
      const { createRun, orchestrateIteration } = require('@a5c-ai/babysitter-sdk');

      (async () => {
        const run = await createRun({
          runsDir: '/tmp/${tag}/runs',
          process: {
            processId: 'pi-immediate',
            importPath: '/tmp/${tag}/proc.js',
            exportName: 'process',
          },
          inputs: {},
          prompt: 'immediate completion test',
        });

        const iter = await orchestrateIteration({ runDir: run.runDir });
        console.log(JSON.stringify({
          status: iter.status,
          hasOutput: iter.output !== undefined,
        }));
      })();
    `);

    expect(result.status).toBe("completed");
    expect(result.hasOutput).toBe(true);
  });
});

// ============================================================================
// Completion proof consistency
// ============================================================================

describe("Pi SDK-driven completion proof consistency", () => {
  test("completionProof is stored in run metadata and accessible after completion", () => {
    const tag = `pi-proof-${Date.now()}`;
    const procDir = `/tmp/${tag}`;
    dockerExec(`mkdir -p ${procDir}`);

    dockerExec(
      `printf '%s' 'exports.process = async function(inputs, ctx) { return { ok: true }; };' > ${procDir}/proc.js`,
    );

    // The completion proof is stored in run.json metadata at creation time
    // and can be read back via readRunMetadata -- this is how the CLI's
    // resolveCompletionProof() works.
    const result = runSdkScript<{
      status: string;
      metadataProof: string;
      journalHasCompleted: boolean;
    }>(`
      const {
        createRun,
        orchestrateIteration,
        readRunMetadata,
        loadJournal,
      } = require('@a5c-ai/babysitter-sdk');

      (async () => {
        const run = await createRun({
          runsDir: '/tmp/${tag}/runs',
          process: {
            processId: 'pi-proof',
            importPath: '/tmp/${tag}/proc.js',
            exportName: 'process',
          },
          inputs: {},
          prompt: 'proof test',
        });

        const iter = await orchestrateIteration({ runDir: run.runDir });
        const metadata = await readRunMetadata(run.runDir);
        const journal = await loadJournal(run.runDir);

        console.log(JSON.stringify({
          status: iter.status,
          metadataProof: metadata.completionProof || '',
          journalHasCompleted: journal.some(e => e.type === 'RUN_COMPLETED'),
        }));
      })();
    `);

    expect(result.status).toBe("completed");
    expect(result.journalHasCompleted).toBe(true);
    // completionProof is stored in run.json at create time
    expect(result.metadataProof).toBeTruthy();
    expect(result.metadataProof.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// Run status derivation (mirrors sdk-bridge.getRunStatus)
// ============================================================================

describe("Pi SDK-driven run status at each phase", () => {
  const tag = `pi-status-${Date.now()}`;

  test("status transitions: running -> waiting -> completed", () => {
    const procDir = `/tmp/${tag}`;
    dockerExec(`mkdir -p ${procDir}`);

    dockerExec(
      `cat > ${procDir}/proc.js << 'PROCEOF'
const { defineTask } = require('@a5c-ai/babysitter-sdk');
const t = defineTask('work', (args, taskCtx) => ({
  kind: 'node',
  title: 'Work',
  node: { script: 'w.js' },
  io: {
    inputJsonPath: 'tasks/' + taskCtx.effectId + '/input.json',
    outputJsonPath: 'tasks/' + taskCtx.effectId + '/output.json',
  },
}));
exports.process = async function(inputs, ctx) {
  const r = await ctx.task(t, {});
  return { done: true };
};
PROCEOF`,
    );

    // Derive status from journal the way Pi's getRunStatus does -- reading
    // the journal and computing status ourselves, not using the CLI.
    const result = runSdkScript<{
      afterCreate: string;
      afterIterate: string;
      pendingAfterIterate: number;
      afterResolveAndIterate: string;
      pendingAfterComplete: number;
    }>(`
      const {
        createRun,
        orchestrateIteration,
        commitEffectResult,
        loadJournal,
      } = require('@a5c-ai/babysitter-sdk');

      function deriveStatus(journal) {
        let status = 'running';
        for (const entry of journal) {
          if (entry.type === 'RUN_COMPLETED') status = 'completed';
          else if (entry.type === 'RUN_FAILED') status = 'failed';
        }
        return status;
      }

      function countPending(journal) {
        const resolved = new Set();
        const requested = new Set();
        for (const entry of journal) {
          const data = entry.data || {};
          if (entry.type === 'EFFECT_RESOLVED') resolved.add(data.effectId);
          if (entry.type === 'EFFECT_REQUESTED') requested.add(data.effectId);
        }
        return [...requested].filter(id => !resolved.has(id)).length;
      }

      (async () => {
        // 1. Create run
        const run = await createRun({
          runsDir: '/tmp/${tag}/runs',
          process: {
            processId: 'pi-status',
            importPath: '/tmp/${tag}/proc.js',
            exportName: 'process',
          },
          inputs: {},
          prompt: 'status test',
        });

        const journalAfterCreate = await loadJournal(run.runDir);
        const afterCreate = deriveStatus(journalAfterCreate);

        // 2. First iteration -> waiting
        const iter1 = await orchestrateIteration({ runDir: run.runDir });
        const journalAfterIterate = await loadJournal(run.runDir);
        const afterIterate = deriveStatus(journalAfterIterate);
        const pendingAfterIterate = countPending(journalAfterIterate);

        // 3. Resolve effect and iterate again -> completed
        const effectId = iter1.nextActions[0].effectId;
        await commitEffectResult({
          runDir: run.runDir,
          effectId,
          result: { status: 'ok', value: { ok: true } },
        });

        await orchestrateIteration({ runDir: run.runDir });
        const journalAfterComplete = await loadJournal(run.runDir);
        const afterResolveAndIterate = deriveStatus(journalAfterComplete);
        const pendingAfterComplete = countPending(journalAfterComplete);

        console.log(JSON.stringify({
          afterCreate,
          afterIterate,
          pendingAfterIterate,
          afterResolveAndIterate,
          pendingAfterComplete,
        }));
      })();
    `, 60_000);

    expect(result.afterCreate).toBe("running");
    expect(result.afterIterate).toBe("running"); // has pending effects but no terminal event
    expect(result.pendingAfterIterate).toBe(1);
    expect(result.afterResolveAndIterate).toBe("completed");
    expect(result.pendingAfterComplete).toBe(0);
  });
});
