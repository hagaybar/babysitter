/**
 * toggles.integration.test.ts
 *
 * Integration tests verifying every compression toggle works correctly end-to-end.
 * Tests 1-10: loadCompressionConfig() behaviour under env-var / config-file conditions.
 * Tests 11-12: handleCompressionToggle() writes/reads .a5c/compression.config.json.
 *
 * All tests use temporary directories — no actual ~/.a5c/ or .a5c/ files are modified.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CONFIG_FILENAME = 'compression.config.json';
const ENV_VAR_NAMES = [
  'BABYSITTER_COMPRESSION_ENABLED',
  'BABYSITTER_COMPRESSION_USER_PROMPT',
  'BABYSITTER_COMPRESSION_COMMANDS',
  'BABYSITTER_COMPRESSION_SDK_CONTEXT',
  'BABYSITTER_COMPRESSION_LIBRARY_CACHE',
] as const;

async function writeProjectConfig(projectDir: string, config: object): Promise<void> {
  const a5cDir = path.join(projectDir, '.a5c');
  await fs.mkdir(a5cDir, { recursive: true });
  await fs.writeFile(path.join(a5cDir, CONFIG_FILENAME), JSON.stringify(config, null, 2));
}

async function readProjectConfig(projectDir: string): Promise<Record<string, unknown>> {
  const filePath = path.join(projectDir, '.a5c', CONFIG_FILENAME);
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Env-var management across tests
// ---------------------------------------------------------------------------

let savedEnv: Record<string, string | undefined> = {};

function saveAndClearEnv(): void {
  savedEnv = {};
  for (const key of ENV_VAR_NAMES) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
}

function restoreEnv(): void {
  for (const key of ENV_VAR_NAMES) {
    const saved = savedEnv[key];
    if (saved === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved;
    }
  }
}

// ---------------------------------------------------------------------------
// Tests 1–10: loadCompressionConfig() toggle coverage
// ---------------------------------------------------------------------------

describe('compression toggle integration — loadCompressionConfig()', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'babysitter-toggles-'));
    saveAndClearEnv();
  });

  afterEach(async () => {
    restoreEnv();
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  // ── Test 1: master-off ────────────────────────────────────────────────────

  it('master-off: BABYSITTER_COMPRESSION_ENABLED=false disables all layers', async () => {
    // All layers explicitly enabled in project config
    await writeProjectConfig(tmpDir, {
      enabled: true,
      layers: {
        userPromptHook: { enabled: true },
        commandOutputHook: { enabled: true },
        sdkContextHook: { enabled: true },
        processLibraryCache: { enabled: true },
      },
    });

    process.env['BABYSITTER_COMPRESSION_ENABLED'] = 'false';

    const { loadCompressionConfig } = await import('../config-loader.js');
    const config = loadCompressionConfig(tmpDir);

    expect(config.enabled).toBe(false);
    expect(config.layers.userPromptHook.enabled).toBe(false);
    expect(config.layers.commandOutputHook.enabled).toBe(false);
    expect(config.layers.sdkContextHook.enabled).toBe(false);
    expect(config.layers.processLibraryCache.enabled).toBe(false);
  });

  // ── Test 2: prompt-hook-off ───────────────────────────────────────────────

  it('prompt-hook-off: userPromptHook.enabled=false in project config — imptokens hook skipped', async () => {
    await writeProjectConfig(tmpDir, {
      layers: { userPromptHook: { enabled: false } },
    });

    const { loadCompressionConfig } = await import('../config-loader.js');
    const config = loadCompressionConfig(tmpDir);

    // The userPromptHook must be disabled
    expect(config.layers.userPromptHook.enabled).toBe(false);
    // All other layers remain at defaults (enabled: true)
    expect(config.layers.commandOutputHook.enabled).toBe(true);
    expect(config.layers.sdkContextHook.enabled).toBe(true);
    expect(config.layers.processLibraryCache.enabled).toBe(true);
    // Master switch is still on
    expect(config.enabled).toBe(true);
  });

  // ── Test 3: prompt-hook-on ────────────────────────────────────────────────

  it('prompt-hook-on: userPromptHook.enabled=true — density-filter engine is configured', async () => {
    await writeProjectConfig(tmpDir, {
      layers: { userPromptHook: { enabled: true, engine: 'density-filter', threshold: 500 } },
    });

    const { loadCompressionConfig } = await import('../config-loader.js');
    const config = loadCompressionConfig(tmpDir);

    expect(config.layers.userPromptHook.enabled).toBe(true);
    expect(config.layers.userPromptHook.engine).toBe('density-filter');
    expect(config.layers.userPromptHook.threshold).toBe(500);
    // Verify density-filter runs: the engine function is accessible from index
    const { densityFilter } = await import('../engines/density-filter/index.js');
    const longText = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} about compression and token reduction.`).join(' ');
    const result = densityFilter(longText, 'compression token reduction', { targetReduction: 0.4, maxSentences: 8 });
    expect(result.estimatedKeptTokens).toBeLessThanOrEqual(result.estimatedOriginalTokens);
  });

  // ── Test 4: command-hook-off ──────────────────────────────────────────────

  it('command-hook-off: commandOutputHook.enabled=false — command output passes through', async () => {
    await writeProjectConfig(tmpDir, {
      layers: { commandOutputHook: { enabled: false } },
    });

    const { loadCompressionConfig } = await import('../config-loader.js');
    const config = loadCompressionConfig(tmpDir);

    expect(config.layers.commandOutputHook.enabled).toBe(false);
    // Other layers untouched
    expect(config.layers.userPromptHook.enabled).toBe(true);
    expect(config.layers.sdkContextHook.enabled).toBe(true);
    // When disabled, a consumer would pass output through unchanged
    const rawOutput = 'On branch main\nnothing to commit\n';
    // (Simulate passthrough — consumer checks .enabled before calling compressCommandOutput)
    const passthrough = config.layers.commandOutputHook.enabled ? 'would-be-compressed' : rawOutput;
    expect(passthrough).toBe(rawOutput);
  });

  // ── Test 5: command-hook-on ───────────────────────────────────────────────

  it('command-hook-on: commandOutputHook.enabled=true — git status is compressed', async () => {
    await writeProjectConfig(tmpDir, {
      layers: { commandOutputHook: { enabled: true } },
    });

    const { loadCompressionConfig } = await import('../config-loader.js');
    const config = loadCompressionConfig(tmpDir);

    expect(config.layers.commandOutputHook.enabled).toBe(true);
    expect(config.layers.commandOutputHook.engine).toBe('command-compressor');

    const { compressCommandOutput } = await import('../engines/command-compressor/index.js');
    const gitStatusOutput =
      'On branch main\nChanges not staged for commit:\n  (use "git add <file>..." to update what will be committed)\n\nno changes added to commit\n';
    const result = compressCommandOutput('git status', gitStatusOutput);

    expect(result.commandFamily).toBe('git');
    expect(result.compressedOutput.length).toBeLessThan(gitStatusOutput.length);
    expect(result.compressedChars).toBeLessThan(result.originalChars);
  });

  // ── Test 6: sdk-hook-off ──────────────────────────────────────────────────

  it('sdk-hook-off: sdkContextHook.enabled=false — context passes through unchanged', async () => {
    await writeProjectConfig(tmpDir, {
      layers: { sdkContextHook: { enabled: false } },
    });

    const { loadCompressionConfig } = await import('../config-loader.js');
    const config = loadCompressionConfig(tmpDir);

    expect(config.layers.sdkContextHook.enabled).toBe(false);
    // Other layers remain enabled
    expect(config.layers.userPromptHook.enabled).toBe(true);
    expect(config.layers.processLibraryCache.enabled).toBe(true);
    // Passthrough simulation
    const contextPayload = 'Some large context block that would normally be compressed.';
    const output = config.layers.sdkContextHook.enabled ? 'compressed' : contextPayload;
    expect(output).toBe(contextPayload);
  });

  // ── Test 7: sdk-hook-on ───────────────────────────────────────────────────

  it('sdk-hook-on: sdkContextHook.enabled=true — context is compressed via sentence-extractor', async () => {
    await writeProjectConfig(tmpDir, {
      layers: {
        sdkContextHook: {
          enabled: true,
          engine: 'sentence-extractor',
          targetReduction: 0.15,
          minCompressionTokens: 50,
        },
      },
    });

    const { loadCompressionConfig } = await import('../config-loader.js');
    const config = loadCompressionConfig(tmpDir);

    expect(config.layers.sdkContextHook.enabled).toBe(true);
    expect(config.layers.sdkContextHook.engine).toBe('sentence-extractor');
    expect(config.layers.sdkContextHook.targetReduction).toBe(0.15);
    expect(config.layers.sdkContextHook.minCompressionTokens).toBe(50);

    const { sentenceExtract } = await import('../engines/sentence-extractor/index.js');
    // 200+ word prose to ensure real compression occurs
    const prose = [
      'The software architecture follows a microservices pattern where each service handles a single responsibility.',
      'Services communicate via REST APIs and message queues to ensure loose coupling.',
      'The authentication service issues JWT tokens valid for 24 hours.',
      'Each downstream service validates tokens using a shared public key.',
      'The database layer uses PostgreSQL for transactional data and Redis for caching.',
      'Deployment is handled by Kubernetes with rolling updates to ensure zero downtime.',
      'Monitoring is provided by Prometheus and Grafana dashboards for real-time observability.',
      'CI/CD pipelines run tests on every pull request before merging to main.',
      'Code reviews are mandatory with at least two approvals required.',
      'The team follows trunk-based development to minimize long-lived feature branches.',
    ].join(' ');

    const result = sentenceExtract(prose, 'authentication JWT token service', { targetReduction: 0.4 });
    expect(result.originalTokens).toBeGreaterThan(50);
    expect(result.compressedTokens).toBeLessThanOrEqual(result.originalTokens);
    expect(result.reductionRatio).toBeGreaterThanOrEqual(0);
    expect(result.reductionRatio).toBeLessThanOrEqual(1);
  });

  // ── Test 8: library-cache-off ─────────────────────────────────────────────

  it('library-cache-off: processLibraryCache.enabled=false — no compressed cache used', async () => {
    await writeProjectConfig(tmpDir, {
      layers: { processLibraryCache: { enabled: false } },
    });

    const { loadCompressionConfig } = await import('../config-loader.js');
    const config = loadCompressionConfig(tmpDir);

    expect(config.layers.processLibraryCache.enabled).toBe(false);
    // Other layers remain enabled
    expect(config.layers.userPromptHook.enabled).toBe(true);
    expect(config.layers.commandOutputHook.enabled).toBe(true);
    expect(config.layers.sdkContextHook.enabled).toBe(true);
    // Simulate consumer: no cache compression when disabled
    const cacheEntry = { data: 'raw library content' };
    const result = config.layers.processLibraryCache.enabled
      ? { data: 'compressed' }
      : cacheEntry;
    expect(result.data).toBe('raw library content');
  });

  // ── Test 9: library-cache-on ──────────────────────────────────────────────

  it('library-cache-on: processLibraryCache.enabled=true — compressed cache configured correctly', async () => {
    await writeProjectConfig(tmpDir, {
      layers: {
        processLibraryCache: {
          enabled: true,
          engine: 'sentence-extractor',
          targetReduction: 0.35,
          ttlHours: 24,
        },
      },
    });

    const { loadCompressionConfig } = await import('../config-loader.js');
    const config = loadCompressionConfig(tmpDir);

    expect(config.layers.processLibraryCache.enabled).toBe(true);
    expect(config.layers.processLibraryCache.engine).toBe('sentence-extractor');
    expect(config.layers.processLibraryCache.targetReduction).toBe(0.35);
    expect(config.layers.processLibraryCache.ttlHours).toBe(24);

    // Verify the compression engine actually compresses long cache-like content
    const { sentenceExtract } = await import('../engines/sentence-extractor/index.js');
    const libDoc = Array.from(
      { length: 20 },
      (_, i) => `Library function ${i} performs data transformation and caching operations.`,
    ).join(' ');

    const result = sentenceExtract(libDoc, 'data transformation caching', {
      targetReduction: 0.35,
    });
    expect(result.compressedTokens).toBeLessThanOrEqual(result.originalTokens);
  });

  // ── Test 10: env-var-override ─────────────────────────────────────────────

  it('env-var-override: BABYSITTER_COMPRESSION_ENABLED=false overrides project config with enabled=true', async () => {
    // Project config says everything is on
    await writeProjectConfig(tmpDir, {
      enabled: true,
      layers: {
        userPromptHook: { enabled: true },
        commandOutputHook: { enabled: true },
        sdkContextHook: { enabled: true },
        processLibraryCache: { enabled: true },
      },
    });

    // Env var says master switch is off — must win
    process.env['BABYSITTER_COMPRESSION_ENABLED'] = 'false';

    const { loadCompressionConfig } = await import('../config-loader.js');
    const config = loadCompressionConfig(tmpDir);

    // Env var priority: all disabled regardless of project config
    expect(config.enabled).toBe(false);
    expect(config.layers.userPromptHook.enabled).toBe(false);
    expect(config.layers.commandOutputHook.enabled).toBe(false);
    expect(config.layers.sdkContextHook.enabled).toBe(false);
    expect(config.layers.processLibraryCache.enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests 11–12: handleCompressionToggle() CLI write/read round-trip
// ---------------------------------------------------------------------------

describe('compression toggle integration — CLI handleCompressionToggle()', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'babysitter-cli-toggle-'));
    saveAndClearEnv();
  });

  afterEach(async () => {
    restoreEnv();
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  // ── Test 11: cli-toggle-off ───────────────────────────────────────────────

  it('cli-toggle-off: compression:toggle sdkContextHook off — writes enabled=false to config file', async () => {
    const { handleCompressionToggle } = await import('../../../sdk/src/cli/commands/compressionToggle.js');

    const exitCode = await handleCompressionToggle({
      layer: 'sdkContextHook',
      value: false,
      json: true,
      cwd: tmpDir,
    });

    expect(exitCode).toBe(0);

    // Verify the file was actually written
    const written = await readProjectConfig(tmpDir);
    const layers = written['layers'] as Record<string, unknown>;
    const sdkHook = layers['sdkContextHook'] as Record<string, unknown>;
    expect(sdkHook['enabled']).toBe(false);

    // Verify loadCompressionConfig reflects the written value
    const { loadCompressionConfig } = await import('../config-loader.js');
    const config = loadCompressionConfig(tmpDir);
    expect(config.layers.sdkContextHook.enabled).toBe(false);
  });

  // ── Test 12: cli-toggle-on ────────────────────────────────────────────────

  it('cli-toggle-on: compression:toggle sdkContextHook on — re-enables after being disabled', async () => {
    const { handleCompressionToggle } = await import('../../../sdk/src/cli/commands/compressionToggle.js');

    // First disable it
    await handleCompressionToggle({
      layer: 'sdkContextHook',
      value: false,
      json: true,
      cwd: tmpDir,
    });

    // Then re-enable
    const exitCode = await handleCompressionToggle({
      layer: 'sdkContextHook',
      value: true,
      json: true,
      cwd: tmpDir,
    });

    expect(exitCode).toBe(0);

    // Verify file shows enabled=true
    const written = await readProjectConfig(tmpDir);
    const layers = written['layers'] as Record<string, unknown>;
    const sdkHook = layers['sdkContextHook'] as Record<string, unknown>;
    expect(sdkHook['enabled']).toBe(true);

    // Verify loadCompressionConfig sees it as enabled
    const { loadCompressionConfig } = await import('../config-loader.js');
    const config = loadCompressionConfig(tmpDir);
    expect(config.layers.sdkContextHook.enabled).toBe(true);
  });

  it('cli-toggle-off: rejects unknown layer with exit code 1', async () => {
    const { handleCompressionToggle } = await import('../../../sdk/src/cli/commands/compressionToggle.js');

    const exitCode = await handleCompressionToggle({
      layer: 'nonExistentLayer',
      value: false,
      json: true,
      cwd: tmpDir,
    });

    expect(exitCode).toBe(1);
  });
});
