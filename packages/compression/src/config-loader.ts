/**
 * config-loader — loads and merges CompressionConfig from multiple sources.
 *
 * Priority (highest wins):
 *   env vars  >  project config (.a5c/compression.config.json)
 *             >  user config (~/.a5c/compression.config.json)
 *             >  built-in defaults
 */

import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { CompressionConfig } from './config.js';
import { DEFAULT_COMPRESSION_CONFIG } from './config.js';

// ---------------------------------------------------------------------------
// Env var names
// ---------------------------------------------------------------------------

export const COMPRESSION_ENV_VARS = {
  ENABLED: 'BABYSITTER_COMPRESSION_ENABLED',
  USER_PROMPT: 'BABYSITTER_COMPRESSION_USER_PROMPT',
  COMMANDS: 'BABYSITTER_COMPRESSION_COMMANDS',
  SDK_CONTEXT: 'BABYSITTER_COMPRESSION_SDK_CONTEXT',
  LIBRARY_CACHE: 'BABYSITTER_COMPRESSION_LIBRARY_CACHE',
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse an env-var string value as a boolean. Accepts "1"/"true"/"yes" as true. */
function parseBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes') return true;
  if (v === '0' || v === 'false' || v === 'no') return false;
  return undefined;
}

/** Attempt to read and parse a JSON file; returns undefined on any error. */
function readJsonFile(filePath: string): unknown {
  try {
    if (!existsSync(filePath)) return undefined;
    const raw = readFileSync(filePath, 'utf8');
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Deep merge
// ---------------------------------------------------------------------------

/**
 * Deeply merge `override` onto `base`.  Only keys present in `override` are
 * applied; missing keys fall through to `base`.  Arrays are replaced wholesale.
 */
function deepMerge<T>(base: T, override: Partial<T>): T {
  if (
    typeof base !== 'object' ||
    base === null ||
    typeof override !== 'object' ||
    override === null
  ) {
    return override as T ?? base;
  }

  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };

  for (const key of Object.keys(override as Record<string, unknown>)) {
    const overrideVal = (override as Record<string, unknown>)[key];
    const baseVal = (base as Record<string, unknown>)[key];

    if (
      overrideVal !== null &&
      typeof overrideVal === 'object' &&
      !Array.isArray(overrideVal) &&
      baseVal !== null &&
      typeof baseVal === 'object' &&
      !Array.isArray(baseVal)
    ) {
      result[key] = deepMerge(baseVal, overrideVal as Partial<typeof baseVal>);
    } else if (overrideVal !== undefined) {
      result[key] = overrideVal;
    }
  }

  return result as T;
}

// ---------------------------------------------------------------------------
// File config loading
// ---------------------------------------------------------------------------

const CONFIG_FILENAME = 'compression.config.json';

function loadFileConfig(dir: string): Partial<CompressionConfig> {
  const filePath = path.join(dir, '.a5c', CONFIG_FILENAME);
  const parsed = readJsonFile(filePath);
  if (parsed === undefined || typeof parsed !== 'object' || parsed === null) {
    return {};
  }
  return parsed as Partial<CompressionConfig>;
}

// ---------------------------------------------------------------------------
// Env-var overlay
// ---------------------------------------------------------------------------

function applyEnvVars(config: CompressionConfig): CompressionConfig {
  let result = { ...config };

  // Master switch
  const masterEnabled = parseBool(process.env[COMPRESSION_ENV_VARS.ENABLED]);
  if (masterEnabled !== undefined) {
    result = { ...result, enabled: masterEnabled };
    // If master switch is turned off, disable all layers immediately
    if (!masterEnabled) {
      result = {
        ...result,
        layers: {
          userPromptHook: { ...result.layers.userPromptHook, enabled: false },
          commandOutputHook: { ...result.layers.commandOutputHook, enabled: false },
          sdkContextHook: { ...result.layers.sdkContextHook, enabled: false },
          processLibraryCache: { ...result.layers.processLibraryCache, enabled: false },
        },
      };
    }
  }

  // Per-layer switches (only applied if master is still enabled)
  if (result.enabled) {
    const userPrompt = parseBool(process.env[COMPRESSION_ENV_VARS.USER_PROMPT]);
    if (userPrompt !== undefined) {
      result = {
        ...result,
        layers: {
          ...result.layers,
          userPromptHook: { ...result.layers.userPromptHook, enabled: userPrompt },
        },
      };
    }

    const commands = parseBool(process.env[COMPRESSION_ENV_VARS.COMMANDS]);
    if (commands !== undefined) {
      result = {
        ...result,
        layers: {
          ...result.layers,
          commandOutputHook: { ...result.layers.commandOutputHook, enabled: commands },
        },
      };
    }

    const sdkContext = parseBool(process.env[COMPRESSION_ENV_VARS.SDK_CONTEXT]);
    if (sdkContext !== undefined) {
      result = {
        ...result,
        layers: {
          ...result.layers,
          sdkContextHook: { ...result.layers.sdkContextHook, enabled: sdkContext },
        },
      };
    }

    const libraryCache = parseBool(process.env[COMPRESSION_ENV_VARS.LIBRARY_CACHE]);
    if (libraryCache !== undefined) {
      result = {
        ...result,
        layers: {
          ...result.layers,
          processLibraryCache: { ...result.layers.processLibraryCache, enabled: libraryCache },
        },
      };
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load the effective CompressionConfig by merging all sources.
 *
 * @param projectDir  Root of the project (directory that contains .a5c/).
 *                    Defaults to `process.cwd()`.
 */
export function loadCompressionConfig(projectDir?: string): CompressionConfig {
  const cwd = projectDir ?? process.cwd();

  // 1. Start with built-in defaults
  let config: CompressionConfig = structuredClone
    ? structuredClone(DEFAULT_COMPRESSION_CONFIG)
    : (JSON.parse(JSON.stringify(DEFAULT_COMPRESSION_CONFIG)) as CompressionConfig);

  // 2. Apply user-level config (~/.a5c/compression.config.json)
  const userConfig = loadFileConfig(os.homedir());
  if (Object.keys(userConfig).length > 0) {
    config = deepMerge(config, userConfig);
  }

  // 3. Apply project-level config (.a5c/compression.config.json)
  const projectConfig = loadFileConfig(cwd);
  if (Object.keys(projectConfig).length > 0) {
    config = deepMerge(config, projectConfig);
  }

  // 4. Apply env-var overrides (highest priority)
  config = applyEnvVars(config);

  return config;
}
