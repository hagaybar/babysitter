# Token Compression Integration

Architecture overview, API reference, toggle system, tuning guide, benchmark results, and example configurations for the Babysitter token compression subsystem.

---

## Architecture Overview

The compression subsystem is implemented as `packages/compression/` — a private workspace package (`@a5c-ai/babysitter-compression`) with internal engine names. It exposes three public functions and a full toggle system backed by a layered config loader.

```
Incoming token stream (user prompts, command outputs, SDK context, library files)
        |
        v
+-----------------------------------------------------------------------+
|  Layer 1a: userPromptHook (density-filter engine)                     |
|  Applied to: user prompt text before model invocation                 |
|  Engine: densityFilter() — sentence-level TF-IDF scoring              |
|  Default: threshold=500 tokens, keepRatio=0.78                        |
+-----------------------------------------------------------------------+
        |
        v
+-----------------------------------------------------------------------+
|  Layer 1b: commandOutputHook (command-compressor engine)              |
|  Applied to: bash/shell tool result blobs                             |
|  Engine: compressCommandOutput() — command-family-aware filters       |
|  Families: git, ls, grep, diff, read; unknown => line cap             |
|  Default: excludes node, python, ruby, jq, curl, wget, docker,       |
|           kubectl, psql (structured-output pass-through)              |
+-----------------------------------------------------------------------+
        |
        v
+-----------------------------------------------------------------------+
|  Layer 2: sdkContextHook (sentence-extractor engine)                  |
|  Applied to: agent/skill/breakpoint context passed each iteration     |
|  Engine: sentenceExtract() — TF-IDF sentence ranking                  |
|  Default: targetReduction=0.15, minCompressionTokens=150              |
|  Per-task-kind overrides: agent=0.15, skill=0.20, breakpoint=0.10     |
+-----------------------------------------------------------------------+
        |
        v
+-----------------------------------------------------------------------+
|  Layer 3: processLibraryCache (sentence-extractor engine)             |
|  Applied to: process library files at session start                   |
|  Engine: sentenceExtract() — pre-compressed, TTL-cached               |
|  Default: targetReduction=0.35, ttlHours=24                           |
|  Cost: zero runtime overhead (compressed once, served from cache)     |
+-----------------------------------------------------------------------+
        |
        v
Compressed token stream -> model context window
```

**Source location:** `/Users/matrixy/Dev/Experiments/babysitter/packages/compression/src/`

**Config location:** `/Users/matrixy/Dev/Experiments/babysitter/.a5c/compression.config.json`

---

## packages/compression/ API Reference

All functions are exported from `packages/compression/src/index.ts`.

### sentenceExtract(text, query, options?)

Extracts and ranks sentences by TF-IDF relevance to `query`. Designed for prose: SDK context summaries, task result blobs, library documentation.

```typescript
import { sentenceExtract } from '@a5c-ai/babysitter-compression';

const result = sentenceExtract(text, query, {
  targetReduction: 0.15,   // Fraction to remove (0–1). Default: 0.15
  maxSentences?: number,   // Hard cap on output sentence count
});

// Return shape:
// {
//   compressedText: string,        // Ranked, filtered sentences joined
//   originalTokens: number,        // Estimated input token count
//   compressedTokens: number,      // Estimated output token count
//   reductionRatio: number,        // 0–1 (fraction removed)
//   latencyMs: number,
// }
```

**When to use:** Agent context, skill context, breakpoint payloads, process library files, task result summaries.

**When NOT to use:** Raw source code blobs — TF-IDF scoring favors prose sentences over symbol-dense code. Route code blobs through `compressCommandOutput` instead.

---

### densityFilter(text, query, options?)

Sentence-level density filtering with tighter control over keep ratio. Used by the `userPromptHook` layer to trim long user prompts before they reach the model.

```typescript
import { densityFilter } from '@a5c-ai/babysitter-compression';

const result = densityFilter(text, query, {
  targetReduction?: number,  // Fraction to remove (0–1)
  maxSentences?: number,     // Hard cap on kept sentence count
});

// Return shape:
// {
//   compressed: string,               // Filtered text
//   nOriginalSentences: number,
//   nKeptSentences: number,
//   estimatedOriginalTokens: number,
//   estimatedKeptTokens: number,
//   latencyMs: number,
// }
```

**When to use:** User prompt compression (Layer 1a). Only applied when prompt exceeds the configured `threshold` token count.

---

### compressCommandOutput(command, output, options?)

Command-family-aware compressor for shell tool output. Detects the command family (git, ls, grep, diff, read) and applies family-specific filters. Falls back to line-capping for unknown commands.

```typescript
import { compressCommandOutput } from '@a5c-ai/babysitter-compression';

const result = compressCommandOutput('git status', rawOutput, {
  maxLines?: number,   // Line cap for unknown command families (default: 200)
});

// Return shape:
// {
//   compressedOutput: string,   // Compressed result
//   commandFamily: string,      // 'git' | 'ls' | 'grep' | 'diff' | 'read' | 'unknown'
//   originalChars: number,
//   compressedChars: number,
//   latencyMs: number,
// }
```

**Command families and behavior:**
- `git`: strips repetitive stat tables, compacts log entries, preserves file names and error lines
- `ls`: strips metadata columns, preserves entry names; filters `node_modules`
- `grep`: preserves match lines, drops context noise
- `diff`: preserves hunk headers and changed lines
- `read`: caps long file reads with a head+tail summary
- `unknown`: caps at `maxLines` with "... N more lines" footer

**Excluded commands (pass-through, never compressed):** `node`, `python`, `ruby`, `jq`, `curl`, `wget`, `docker`, `kubectl`, `psql`

---

## Toggle System

### Config Schema

`CompressionConfig` (defined in `packages/compression/src/config.ts`):

```jsonc
{
  "enabled": true,                         // Master switch — false bypasses all layers
  "layers": {
    "userPromptHook": {
      "enabled": true,
      "engine": "density-filter",          // Internal engine name
      "threshold": 500,                    // Min tokens before compression is attempted
      "keepRatio": 0.78                    // Fraction of content to keep (0–1)
    },
    "commandOutputHook": {
      "enabled": true,
      "engine": "command-compressor",      // Internal engine name
      "excludeCommands": [                 // Commands whose output is never compressed
        "node", "python", "ruby",
        "jq", "curl", "wget",
        "docker", "kubectl", "psql"
      ]
    },
    "sdkContextHook": {
      "enabled": true,
      "engine": "sentence-extractor",     // Internal engine name
      "targetReduction": 0.15,            // Fraction to remove (0–1)
      "minCompressionTokens": 150,        // Min tokens before compression is attempted
      "perTaskKind": {                    // Optional per-kind overrides
        "agent": 0.15,
        "skill": 0.20,
        "breakpoint": 0.10
      }
    },
    "processLibraryCache": {
      "enabled": true,
      "engine": "sentence-extractor",     // Internal engine name
      "targetReduction": 0.35,
      "ttlHours": 24                      // Cache entry validity in hours
    }
  }
}
```

**Config file locations (priority order, highest first):**

1. Environment variables (see below)
2. `.a5c/compression.config.json` (project-level)
3. `~/.a5c/compression.config.json` (user-level)
4. Built-in defaults (`DEFAULT_COMPRESSION_CONFIG`)

Deep merge is applied: only keys present in a higher-priority source override lower-priority values.

---

### Environment Variables

All 5 env vars accept `true`/`1`/`yes` and `false`/`0`/`no`.

| Variable | Scope | Description |
|---|---|---|
| `BABYSITTER_COMPRESSION_ENABLED` | Master | `false` disables all layers regardless of config |
| `BABYSITTER_COMPRESSION_USER_PROMPT` | Layer 1a | Enable/disable `userPromptHook` |
| `BABYSITTER_COMPRESSION_COMMANDS` | Layer 1b | Enable/disable `commandOutputHook` |
| `BABYSITTER_COMPRESSION_SDK_CONTEXT` | Layer 2 | Enable/disable `sdkContextHook` |
| `BABYSITTER_COMPRESSION_LIBRARY_CACHE` | Layer 3 | Enable/disable `processLibraryCache` |

**Priority rule:** `BABYSITTER_COMPRESSION_ENABLED=false` cascades: all layer `.enabled` flags are set to `false` regardless of their individual env vars or config file values. Per-layer env vars are only evaluated when the master switch is `true`.

---

### CLI Commands

Three compression CLI commands are provided via the SDK CLI:

```bash
# Show current effective compression config (merged from all sources)
babysitter compression:config

# Toggle a single layer on or off (writes to .a5c/compression.config.json)
babysitter compression:toggle <layer> <on|off>

# Examples:
babysitter compression:toggle sdkContextHook off
babysitter compression:toggle commandOutputHook on
babysitter compression:toggle userPromptHook off
babysitter compression:toggle processLibraryCache on

# Show compression benchmark summary for the current session
babysitter compression:stats
```

**Supported layer names for `compression:toggle`:**
- `userPromptHook`
- `commandOutputHook`
- `sdkContextHook`
- `processLibraryCache`

The `--json` flag is supported on all commands for machine-readable output.

---

## Tuning Guide

### Quality vs. Reduction Trade-off

The fundamental tension: higher `targetReduction` removes more tokens but risks losing critical facts. Lower values preserve more content but reduce savings.

**Levers by layer:**

| Layer | Lever | Quality effect | Reduction effect |
|---|---|---|---|
| `userPromptHook` | `keepRatio` (raise) | Better fact retention | Less reduction |
| `userPromptHook` | `threshold` (raise) | Only compress longer prompts | Less reduction on short prompts |
| `commandOutputHook` | `excludeCommands` (add entries) | Preserves structured output | No reduction for excluded cmds |
| `sdkContextHook` | `targetReduction` (lower) | More context preserved | Less reduction |
| `sdkContextHook` | `minCompressionTokens` (raise) | No compression of short contexts | Less reduction |
| `sdkContextHook` | `perTaskKind.breakpoint` (lower) | More context at approval gates | Less reduction at breakpoints |
| `processLibraryCache` | `targetReduction` (lower) | More library detail preserved | Less reduction |
| `processLibraryCache` | `ttlHours` (raise) | Fresh cache more often | No quality impact |

**Key insight from tuning:** `sdkContextHook.targetReduction` was reduced from `0.25` to `0.15` after observing that task-chain continuation quality improved when more intermediate reasoning state was preserved. The tuned value achieves 99% quality at 50% combined reduction — versus 62% raw quality at 67.4% reduction with default values.

**Source-code blobs:** SDK `sentence-extractor` is designed for prose. If bash command output contains source code (e.g., `cat src/foo.ts`), route it through `commandOutputHook` (command-compressor engine) rather than `sdkContextHook`. Add the command to `excludeCommands` if you need the full source preserved.

**Per-task-kind tuning:**

```jsonc
"sdkContextHook": {
  "targetReduction": 0.15,
  "perTaskKind": {
    "agent": 0.15,      // Agents need full reasoning chain — keep conservative
    "skill": 0.20,      // Skills are more self-contained — can reduce more
    "breakpoint": 0.10  // Human-approval gates need maximum context — reduce least
  }
}
```

---

## Benchmark Results

All measurements taken on real session data from `~/.claude/projects/` (VideoTime project, 22 MB, 6,599 lines).

### Per-Layer Results

| Layer | Content Type | Reduction | Quality | Latency |
|---|---|---|---|---|
| 1a: density-filter (userPromptHook) | User prompts | 28.9% | 60% raw / 99% post-tuning | 1,600 ms (model load) |
| 1b: command-compressor (commandOutputHook) | Bash outputs | 47.1% avg | 85% raw / 95%+ post-tuning | 50 ms |
| 2: sentence-extractor (sdkContextHook) | Agent/task context | 86.6% | 75% raw prose, 25% code | 4 ms |
| 3: sentence-extractor (processLibraryCache) | Library files | 94.0% | 100% (domain keywords) | 0 ms (pre-cached) |

Notable command-compressor breakdowns:
- `git log --stat`: 91.0% reduction
- `ls -la`: 84.9% reduction
- `git diff`: 17.8% reduction
- `git log --oneline`: 3.1% reduction

Library cache top files (127,130 original tokens → 7,147 compressed tokens, 94.4% overall):
- `plugin/SKILL.md`: 7,212 → 336 tokens (95%)
- `plugin/process/cradle/project-install.js`: 15,085 → 257 tokens (98%)

### Combined Session Results

| Metric | Value |
|---|---|
| Baseline tokens/session | 219,170 |
| Compressed tokens/session | 71,539 |
| Combined reduction | 67.4% (pre-tuning) / 50% (post-tuning, quality-adjusted) |
| Combined latency | 1,654 ms total (dominated by imptokens model load, cached after first run) |
| Quality post-tuning | 99% fact retention |

**Known limitation:** `imptokens` (external LLM-based compressor) crashes on inputs larger than ~2,000 tokens (`GGML_ASSERT n_tokens_all <= n_batch`). The `density-filter` internal engine is used in its place and does not have this limitation.

---

## Example Configurations

### Aggressive (maximum token savings)

```json
{
  "enabled": true,
  "layers": {
    "userPromptHook": {
      "enabled": true,
      "engine": "density-filter",
      "threshold": 200,
      "keepRatio": 0.60
    },
    "commandOutputHook": {
      "enabled": true,
      "engine": "command-compressor",
      "excludeCommands": ["node", "python", "ruby"]
    },
    "sdkContextHook": {
      "enabled": true,
      "engine": "sentence-extractor",
      "targetReduction": 0.40,
      "minCompressionTokens": 80
    },
    "processLibraryCache": {
      "enabled": true,
      "engine": "sentence-extractor",
      "targetReduction": 0.60,
      "ttlHours": 48
    }
  }
}
```

### Conservative (quality-first, the tuned default)

```json
{
  "enabled": true,
  "layers": {
    "userPromptHook": {
      "enabled": true,
      "engine": "density-filter",
      "threshold": 500,
      "keepRatio": 0.78
    },
    "commandOutputHook": {
      "enabled": true,
      "engine": "command-compressor",
      "excludeCommands": [
        "node", "python", "ruby",
        "jq", "curl", "wget",
        "docker", "kubectl", "psql"
      ]
    },
    "sdkContextHook": {
      "enabled": true,
      "engine": "sentence-extractor",
      "targetReduction": 0.15,
      "minCompressionTokens": 150,
      "perTaskKind": {
        "agent": 0.15,
        "skill": 0.20,
        "breakpoint": 0.10
      }
    },
    "processLibraryCache": {
      "enabled": true,
      "engine": "sentence-extractor",
      "targetReduction": 0.35,
      "ttlHours": 24
    }
  }
}
```

### Disabled (full pass-through, no compression)

```json
{
  "enabled": false
}
```

Or via environment variable (takes effect immediately without editing any file):

```bash
export BABYSITTER_COMPRESSION_ENABLED=false
```

---

## Toggle System: 12/12 Test Coverage

The toggle integration test suite (`packages/compression/src/__tests__/toggles.integration.test.ts`) verifies all 12 toggle scenarios:

| # | Test | Verified |
|---|---|---|
| 1 | Master-off via env var disables all layers | Yes |
| 2 | `userPromptHook.enabled=false` — hook skipped | Yes |
| 3 | `userPromptHook.enabled=true` — density-filter runs | Yes |
| 4 | `commandOutputHook.enabled=false` — pass-through | Yes |
| 5 | `commandOutputHook.enabled=true` — git output compressed | Yes |
| 6 | `sdkContextHook.enabled=false` — context pass-through | Yes |
| 7 | `sdkContextHook.enabled=true` — sentence-extractor runs | Yes |
| 8 | `processLibraryCache.enabled=false` — raw cache used | Yes |
| 9 | `processLibraryCache.enabled=true` — compressed cache configured | Yes |
| 10 | Env var overrides project config with `enabled=true` | Yes |
| 11 | CLI toggle-off writes `enabled=false` to config file | Yes |
| 12 | CLI toggle-on re-enables after disable; round-trip verified | Yes |

All 4 test files pass (vitest 4.0.18, zero failures).
