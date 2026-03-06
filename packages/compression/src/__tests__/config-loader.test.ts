import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// We import after env manipulation so we must clear the module cache between tests.
// Use vitest's module isolation via vi.resetModules() where needed.

const CONFIG_FILENAME = 'compression.config.json';

async function writeProjectConfig(dir: string, config: object): Promise<void> {
  const a5cDir = path.join(dir, '.a5c');
  await fs.mkdir(a5cDir, { recursive: true });
  await fs.writeFile(path.join(a5cDir, CONFIG_FILENAME), JSON.stringify(config, null, 2));
}

describe('loadCompressionConfig', () => {
  let tmpDir: string;
  const originalEnv: Record<string, string | undefined> = {};
  const envVarNames = [
    'BABYSITTER_COMPRESSION_ENABLED',
    'BABYSITTER_COMPRESSION_USER_PROMPT',
    'BABYSITTER_COMPRESSION_COMMANDS',
    'BABYSITTER_COMPRESSION_SDK_CONTEXT',
    'BABYSITTER_COMPRESSION_LIBRARY_CACHE',
  ];

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'babysitter-compression-test-'));
    // Save and clear all relevant env vars
    for (const key of envVarNames) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
    // Ensure no user-level config interferes by pointing home to a clean tmp dir
    // (We can't easily redirect os.homedir(), so we rely on the absence of env vars
    //  and a fresh tmpDir that has no ~/.a5c directory.)
  });

  afterEach(async () => {
    // Restore env vars
    for (const key of envVarNames) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
    // Clean up temp dir
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
    // Reset module registry so config-loader re-reads env vars fresh
    vi.resetModules();
  });

  it('returns default config when no files exist and no env vars are set', async () => {
    const { loadCompressionConfig } = await import('../config-loader.js');
    const { DEFAULT_COMPRESSION_CONFIG } = await import('../config.js');

    const config = loadCompressionConfig(tmpDir);

    expect(config.enabled).toBe(DEFAULT_COMPRESSION_CONFIG.enabled);
    expect(config.layers.userPromptHook.enabled).toBe(
      DEFAULT_COMPRESSION_CONFIG.layers.userPromptHook.enabled,
    );
    expect(config.layers.userPromptHook.engine).toBe(
      DEFAULT_COMPRESSION_CONFIG.layers.userPromptHook.engine,
    );
    expect(config.layers.commandOutputHook.enabled).toBe(
      DEFAULT_COMPRESSION_CONFIG.layers.commandOutputHook.enabled,
    );
    expect(config.layers.sdkContextHook.targetReduction).toBe(
      DEFAULT_COMPRESSION_CONFIG.layers.sdkContextHook.targetReduction,
    );
    expect(config.layers.processLibraryCache.ttlHours).toBe(
      DEFAULT_COMPRESSION_CONFIG.layers.processLibraryCache.ttlHours,
    );
  });

  it('project config overrides specific keys while leaving others at defaults', async () => {
    await writeProjectConfig(tmpDir, {
      layers: {
        userPromptHook: { enabled: false, threshold: 1000 },
        processLibraryCache: { ttlHours: 48 },
      },
    });

    const { loadCompressionConfig } = await import('../config-loader.js');
    const { DEFAULT_COMPRESSION_CONFIG } = await import('../config.js');
    const config = loadCompressionConfig(tmpDir);

    // Overridden values
    expect(config.layers.userPromptHook.enabled).toBe(false);
    expect(config.layers.userPromptHook.threshold).toBe(1000);
    expect(config.layers.processLibraryCache.ttlHours).toBe(48);

    // Untouched defaults
    expect(config.layers.userPromptHook.engine).toBe(
      DEFAULT_COMPRESSION_CONFIG.layers.userPromptHook.engine,
    );
    expect(config.layers.commandOutputHook.enabled).toBe(
      DEFAULT_COMPRESSION_CONFIG.layers.commandOutputHook.enabled,
    );
    expect(config.layers.sdkContextHook.minCompressionTokens).toBe(
      DEFAULT_COMPRESSION_CONFIG.layers.sdkContextHook.minCompressionTokens,
    );
  });

  it('env var BABYSITTER_COMPRESSION_USER_PROMPT=false overrides project config enabled=true', async () => {
    // Project config sets userPromptHook.enabled = true
    await writeProjectConfig(tmpDir, {
      layers: { userPromptHook: { enabled: true } },
    });

    // Env var says disabled
    process.env['BABYSITTER_COMPRESSION_USER_PROMPT'] = 'false';

    const { loadCompressionConfig } = await import('../config-loader.js');
    const config = loadCompressionConfig(tmpDir);

    expect(config.layers.userPromptHook.enabled).toBe(false);
    // Other layers should remain enabled
    expect(config.layers.commandOutputHook.enabled).toBe(true);
  });

  it('master switch BABYSITTER_COMPRESSION_ENABLED=false disables all layers', async () => {
    // Project config has everything enabled
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

  it('partial config merge only overrides specified keys', async () => {
    // Only override one nested field deep inside sdkContextHook
    await writeProjectConfig(tmpDir, {
      layers: {
        sdkContextHook: { targetReduction: 0.5 },
      },
    });

    const { loadCompressionConfig } = await import('../config-loader.js');
    const { DEFAULT_COMPRESSION_CONFIG } = await import('../config.js');
    const config = loadCompressionConfig(tmpDir);

    // The overridden field
    expect(config.layers.sdkContextHook.targetReduction).toBe(0.5);

    // All other sdkContextHook fields should match defaults
    expect(config.layers.sdkContextHook.enabled).toBe(
      DEFAULT_COMPRESSION_CONFIG.layers.sdkContextHook.enabled,
    );
    expect(config.layers.sdkContextHook.minCompressionTokens).toBe(
      DEFAULT_COMPRESSION_CONFIG.layers.sdkContextHook.minCompressionTokens,
    );

    // Other layers entirely untouched
    expect(config.layers.userPromptHook.keepRatio).toBe(
      DEFAULT_COMPRESSION_CONFIG.layers.userPromptHook.keepRatio,
    );
    expect(config.layers.processLibraryCache.targetReduction).toBe(
      DEFAULT_COMPRESSION_CONFIG.layers.processLibraryCache.targetReduction,
    );
  });
});
