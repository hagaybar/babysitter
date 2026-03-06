/**
 * compression:status — print the resolved compression config as a table or JSON.
 *
 * Usage:
 *   babysitter compression:status [--json]
 */

import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CompressionStatusOptions {
  json?: boolean;
  cwd?: string;
}

interface LayerRow {
  layer: string;
  enabled: boolean;
  engine: string;
  keySettings: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveProjectDir(cwd?: string): string {
  return cwd ?? process.cwd();
}

// Lazy-load the compression package so the SDK doesn't hard-depend on it at
// module load time. The package ships as ESM source; we require a dynamic import.
async function loadConfig(projectDir: string) {
  // The compression package exports loadCompressionConfig which reads from the
  // filesystem and env vars.  We call it with the resolved project dir.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('@a5c-ai/babysitter-compression') as {
    loadCompressionConfig: (dir: string) => import('@a5c-ai/babysitter-compression').CompressionConfig;
  };
  return mod.loadCompressionConfig(projectDir);
}

function buildRows(config: Awaited<ReturnType<typeof loadConfig>>): LayerRow[] {
  const { layers } = config;
  return [
    {
      layer: 'userPromptHook',
      enabled: layers.userPromptHook.enabled,
      engine: layers.userPromptHook.engine,
      keySettings: `threshold=${layers.userPromptHook.threshold}, keepRatio=${layers.userPromptHook.keepRatio}`,
    },
    {
      layer: 'commandOutputHook',
      enabled: layers.commandOutputHook.enabled,
      engine: layers.commandOutputHook.engine,
      keySettings: `excludeCommands=[${layers.commandOutputHook.excludeCommands.join(', ')}]`,
    },
    {
      layer: 'sdkContextHook',
      enabled: layers.sdkContextHook.enabled,
      engine: layers.sdkContextHook.engine,
      keySettings: `targetReduction=${layers.sdkContextHook.targetReduction}, minTokens=${layers.sdkContextHook.minCompressionTokens}`,
    },
    {
      layer: 'processLibraryCache',
      enabled: layers.processLibraryCache.enabled,
      engine: layers.processLibraryCache.engine,
      keySettings: `targetReduction=${layers.processLibraryCache.targetReduction}, ttlHours=${layers.processLibraryCache.ttlHours}`,
    },
  ];
}

function printTable(masterEnabled: boolean, rows: LayerRow[]): void {
  console.log(`\nCompression master switch: ${masterEnabled ? 'ENABLED' : 'DISABLED'}\n`);
  const col = { layer: 22, enabled: 9, engine: 22, keySettings: 60 };
  const header = [
    'Layer'.padEnd(col.layer),
    'Enabled'.padEnd(col.enabled),
    'Engine'.padEnd(col.engine),
    'Key settings',
  ].join('  ');
  const separator = [
    '-'.repeat(col.layer),
    '-'.repeat(col.enabled),
    '-'.repeat(col.engine),
    '-'.repeat(col.keySettings),
  ].join('  ');
  console.log(header);
  console.log(separator);
  for (const row of rows) {
    const line = [
      row.layer.padEnd(col.layer),
      String(row.enabled).padEnd(col.enabled),
      row.engine.padEnd(col.engine),
      row.keySettings,
    ].join('  ');
    console.log(line);
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleCompressionStatus(opts: CompressionStatusOptions): Promise<number> {
  const projectDir = resolveProjectDir(opts.cwd);

  let config: Awaited<ReturnType<typeof loadConfig>>;
  try {
    config = await loadConfig(projectDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (opts.json) {
      console.error(JSON.stringify({ error: `Failed to load compression config: ${message}` }));
    } else {
      console.error(`Error: Failed to load compression config: ${message}`);
    }
    return 1;
  }

  const rows = buildRows(config);

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          masterEnabled: config.enabled,
          configFile: path.join(projectDir, '.a5c', 'compression.config.json'),
          layers: rows,
        },
        null,
        2,
      ),
    );
  } else {
    printTable(config.enabled, rows);
  }

  return 0;
}
