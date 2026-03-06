/**
 * command-compressor — compress shell command output by type.
 *
 * Detects the command family (git, ls, grep, diff, read/cat) from the
 * command string and applies appropriate compression. Ported from rtk.
 */
import { detectGitSubcommand, compressGitOutput } from './git.js';
import { compressLsOutput } from './ls.js';
import { compressGrepOutput } from './grep.js';
import { compressReadOutput, type ReadCompressionOptions } from './read.js';
import { condenseDiff, compressDiffOutput } from './diff.js';
import { type FilterLevel } from './filter.js';

export { type FilterLevel } from './filter.js';
export { compactDiff, compactLog, compactStatus } from './git.js';
export { compactLs } from './ls.js';
export { compressGrepOutput } from './grep.js';
export { compressReadOutput } from './read.js';
export { condenseDiff, compressDiffOutput } from './diff.js';

export interface CommandConfig {
  /** Max lines to retain in output (default: unlimited) */
  maxLines?: number;
  /** For grep: max result count (default: 50) */
  maxResults?: number;
  /** For read/cat: filter level (default: 'minimal') */
  filterLevel?: FilterLevel;
  /** For read/cat: whether to add line numbers */
  lineNumbers?: boolean;
  /** For ls: show hidden/noise dirs */
  showAll?: boolean;
  /** For grep: max line length before truncation (default: 120) */
  maxLineLen?: number;
}

export interface CommandCompressResult {
  /** The compressed output */
  compressedOutput: string;
  /** Detected command family */
  commandFamily: string;
  /** Original character count */
  originalChars: number;
  /** Compressed character count */
  compressedChars: number;
  /** Wall-clock latency in milliseconds */
  latencyMs: number;
}

type CommandFamily = 'git' | 'ls' | 'grep' | 'diff' | 'read' | 'unknown';

function detectCommandFamily(command: string): CommandFamily {
  const trimmed = command.trim().toLowerCase();
  const first = trimmed.split(/\s+/)[0] ?? '';
  if (first === 'git' || first === 'rtk') {
    const parts = trimmed.split(/\s+/);
    if (parts[1] === 'git') return 'git';
    if (first === 'git') return 'git';
  }
  if (first === 'git') return 'git';
  if (first === 'ls' || first === 'dir') return 'ls';
  if (first === 'grep' || first === 'rg' || first === 'ag') return 'grep';
  if (first === 'diff' || first === 'delta') return 'diff';
  if (first === 'cat' || first === 'head' || first === 'tail' || first === 'less' || first === 'more') return 'read';
  return 'unknown';
}

/**
 * Compress command output using the appropriate strategy for the detected
 * command family.
 */
export function compressCommandOutput(
  command: string,
  rawOutput: string,
  config?: CommandConfig,
): CommandCompressResult {
  const start = performance.now();
  const originalChars = rawOutput.length;
  const family = detectCommandFamily(command);
  let compressedOutput: string;

  switch (family) {
    case 'git': {
      const sub = detectGitSubcommand(command);
      compressedOutput = compressGitOutput(sub, rawOutput);
      break;
    }
    case 'ls': {
      compressedOutput = compressLsOutput(rawOutput, config?.showAll);
      break;
    }
    case 'grep': {
      // Extract pattern from command for display
      const parts = command.split(/\s+/);
      const pattern = parts.find((p, i) => i > 0 && !p.startsWith('-')) ?? '';
      compressedOutput = compressGrepOutput(
        rawOutput,
        pattern,
        config?.maxResults,
        config?.maxLineLen,
      );
      break;
    }
    case 'diff': {
      // For diff, condense the unified diff format
      compressedOutput = condenseDiff(rawOutput);
      break;
    }
    case 'read': {
      const parts = command.trim().split(/\s+/);
      const filePath = parts[parts.length - 1] ?? '';
      const ext = filePath.includes('.') ? filePath.split('.').pop() ?? '' : '';
      const opts: ReadCompressionOptions = {
        filterLevel: config?.filterLevel ?? 'minimal',
        maxLines: config?.maxLines,
        lineNumbers: config?.lineNumbers,
        fileExtension: ext,
      };
      compressedOutput = compressReadOutput(rawOutput, opts);
      break;
    }
    default: {
      // Generic: cap lines
      const maxLines = config?.maxLines ?? 200;
      const lines = rawOutput.split('\n');
      if (lines.length > maxLines) {
        compressedOutput = lines.slice(0, maxLines).join('\n') + `\n... +${lines.length - maxLines} more lines`;
      } else {
        compressedOutput = rawOutput;
      }
    }
  }

  return {
    compressedOutput,
    commandFamily: family,
    originalChars,
    compressedChars: compressedOutput.length,
    latencyMs: performance.now() - start,
  };
}
