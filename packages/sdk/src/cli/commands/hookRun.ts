/**
 * hook:run CLI command.
 *
 * Dispatches hook handling to the appropriate harness adapter.
 * Each harness (e.g. "claude-code") implements its own stop and
 * session-start handlers via the HarnessAdapter interface.
 *
 * The "user-prompt-submit" hook type is harness-agnostic: it reads the
 * Claude Code UserPromptSubmit JSON payload from stdin, applies density-filter
 * compression if the prompt exceeds the configured token threshold, and writes
 * the (possibly compressed) payload to stdout.
 */

import { getAdapterByName, listSupportedHarnesses } from "../../harness";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface HookRunCommandArgs {
  hookType: string;
  /** Which host tool is invoking the hook. Defaults to "claude-code". */
  harness: string;
  pluginRoot?: string;
  stateDir?: string;
  runsDir?: string;
  json: boolean;
  verbose?: boolean;
}

// ---------------------------------------------------------------------------
// user-prompt-submit handler (harness-agnostic, self-contained)
//
// Reads compression config from .a5c/compression.config.json (project and
// user-level), applies density-filter compression if the prompt exceeds the
// configured token threshold, and writes the result to stdout.
//
// The density-filter algorithm is inlined here so this handler has zero
// runtime dependencies on the @a5c-ai/babysitter-compression ESM package.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ── Config loader (inline, mirrors compression/src/config-loader.ts) ────────

interface UserPromptLayerConfig {
  enabled: boolean;
  threshold: number;
  keepRatio: number;
}

interface MinimalCompressionConfig {
  enabled: boolean;
  layers: { userPromptHook: UserPromptLayerConfig };
}

const DEFAULT_LAYER: UserPromptLayerConfig = { enabled: true, threshold: 500, keepRatio: 0.78 };
const DEFAULT_CONFIG: MinimalCompressionConfig = { enabled: true, layers: { userPromptHook: DEFAULT_LAYER } };

function loadUserPromptConfig(projectDir: string): MinimalCompressionConfig {
  let cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as MinimalCompressionConfig;

  for (const dir of [os.homedir(), projectDir]) {
    const filePath = path.join(dir, ".a5c", "compression.config.json");
    if (!existsSync(filePath)) continue;
    try {
      const raw = JSON.parse(readFileSync(filePath, "utf8")) as Partial<MinimalCompressionConfig>;
      if (typeof raw.enabled === "boolean") cfg.enabled = raw.enabled;
      const ul = raw.layers?.userPromptHook;
      if (ul) {
        if (typeof ul.enabled === "boolean") cfg.layers.userPromptHook.enabled = ul.enabled;
        if (typeof ul.threshold === "number") cfg.layers.userPromptHook.threshold = ul.threshold;
        if (typeof ul.keepRatio === "number") cfg.layers.userPromptHook.keepRatio = ul.keepRatio;
      }
    } catch {
      // malformed config — skip
    }
  }

  // Env-var overrides
  const envEnabled = process.env["BABYSITTER_COMPRESSION_ENABLED"];
  if (envEnabled !== undefined) {
    const v = envEnabled.trim().toLowerCase();
    if (v === "0" || v === "false" || v === "no") { cfg.enabled = false; cfg.layers.userPromptHook.enabled = false; }
    if (v === "1" || v === "true" || v === "yes") cfg.enabled = true;
  }
  const envLayer = process.env["BABYSITTER_COMPRESSION_USER_PROMPT"];
  if (envLayer !== undefined) {
    const v = envLayer.trim().toLowerCase();
    if (v === "0" || v === "false" || v === "no") cfg.layers.userPromptHook.enabled = false;
    if (v === "1" || v === "true" || v === "yes") cfg.layers.userPromptHook.enabled = true;
  }

  return cfg;
}

// ── Density filter (inline, mirrors compression/src/engines/density-filter) ─


const BOILERPLATE = ["copyright","all rights reserved","disclaimer","terms of use","privacy policy","proprietary","confidential","trademark"];

function estimateTokens(text: string): number {
  return (text.match(/[\p{L}\p{N}]+|[^\s]/gu) ?? []).length;
}

function splitSentences(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (const ch of text) {
    if (ch === "\n" || ch === "." || ch === "!" || ch === "?") {
      if (ch !== "\n") cur += ch;
      const t = cur.trim();
      if (t) out.push(t);
      cur = "";
    } else {
      cur += ch;
    }
  }
  const t = cur.trim();
  if (t) out.push(t);
  return out;
}

function fnv1a(s: string): bigint {
  let h = 14695981039346656037n;
  for (let i = 0; i < s.length; i++) h = BigInt.asUintN(64, (h ^ BigInt(s.charCodeAt(i))) * 1099511628211n);
  return h;
}

function densityFilterInline(text: string, targetReduction: number): string {
  const sentences = splitSentences(text);
  if (sentences.length === 0) return text;

  const totalTokens = estimateTokens(text);
  const tokenBudget = Math.max(80, Math.round(totalTokens * (1 - targetReduction)));

  const seen = new Set<bigint>();
  const features: Array<{ index: number; tokenCount: number; score: number }> = [];
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i];
    const h = fnv1a(s.toLowerCase().replace(/\s+/g, " ").trim());
    if (seen.has(h)) continue;
    seen.add(h);
    const tc = estimateTokens(s);
    const isBoilerplate = BOILERPLATE.some(p => s.toLowerCase().includes(p));
    features.push({ index: i, tokenCount: tc, score: Math.min(tc, 40) / 40 - (isBoilerplate ? 0.5 : 0) });
  }

  const sorted = [...features].sort((a, b) => b.score - a.score);
  const kept: number[] = [];
  let used = 0;
  for (const f of sorted) {
    if (kept.length >= 500) break;
    if (used + f.tokenCount <= tokenBudget) { kept.push(f.index); used += f.tokenCount; }
  }

  // If nothing fits (e.g. single huge sentence), fall back to original
  if (kept.length === 0) return text;

  kept.sort((a, b) => a - b);
  return kept.map(i => sentences[i]).join(" ");
}

// ── Main handler ─────────────────────────────────────────────────────────────

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

async function handleUserPromptSubmit(): Promise<number> {
  let raw: string;
  try {
    raw = await readStdin();
  } catch {
    return 0;
  }

  const config = loadUserPromptConfig(process.cwd());
  const layer = config.layers.userPromptHook;

  if (!config.enabled || !layer.enabled) {
    process.stdout.write(raw);
    return 0;
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    process.stdout.write(raw);
    return 0;
  }

  const prompt = payload.prompt;
  if (typeof prompt !== "string") {
    process.stdout.write(JSON.stringify(payload));
    return 0;
  }

  const tokenCount = estimateTokens(prompt);
  if (tokenCount <= layer.threshold) {
    process.stdout.write(JSON.stringify(payload));
    return 0;
  }

  payload.prompt = densityFilterInline(prompt, 1 - layer.keepRatio);
  process.stdout.write(JSON.stringify(payload));
  return 0;
}

// ---------------------------------------------------------------------------
// Main dispatcher
// ---------------------------------------------------------------------------

export async function handleHookRun(args: HookRunCommandArgs): Promise<number> {
  const { hookType, harness, json } = args;

  if (!hookType) {
    const error = {
      error: "MISSING_HOOK_TYPE",
      message: "--hook-type is required for hook:run",
    };
    if (json) {
      process.stderr.write(JSON.stringify(error, null, 2) + "\n");
    } else {
      process.stderr.write("Error: --hook-type is required for hook:run\n");
    }
    return 1;
  }

  // user-prompt-submit is harness-agnostic — handle before adapter lookup
  if (hookType === "user-prompt-submit") {
    return await handleUserPromptSubmit();
  }

  const adapter = getAdapterByName(harness);
  if (!adapter) {
    const supported = listSupportedHarnesses();
    const error = {
      error: "UNSUPPORTED_HARNESS",
      message: `Unsupported harness: "${harness}". Supported: ${supported.join(", ")}`,
    };
    if (json) {
      process.stderr.write(JSON.stringify(error, null, 2) + "\n");
    } else {
      process.stderr.write(`Error: ${error.message}\n`);
    }
    return 1;
  }

  switch (hookType) {
    case "stop":
      return await adapter.handleStopHook(args);
    case "session-start":
      return await adapter.handleSessionStartHook(args);
    default: {
      const error = {
        error: "UNKNOWN_HOOK_TYPE",
        message: `Unknown hook type: ${hookType}. Supported: stop, session-start, user-prompt-submit`,
      };
      if (json) {
        process.stderr.write(JSON.stringify(error, null, 2) + "\n");
      } else {
        process.stderr.write(
          `Error: Unknown hook type: ${hookType}. Supported: stop, session-start, user-prompt-submit\n`,
        );
      }
      return 1;
    }
  }
}
