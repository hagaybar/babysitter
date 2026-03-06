/**
 * git.ts — compress git command output.
 * Ported from rtk git.rs (diff, log, status, show, branch logic only).
 * No CLI execution — pure output transformation.
 */

export type GitSubcommand =
  | 'diff' | 'log' | 'status' | 'show' | 'add'
  | 'commit' | 'push' | 'pull' | 'branch' | 'fetch'
  | 'stash' | 'worktree' | 'unknown';

export function detectGitSubcommand(command: string): GitSubcommand {
  const lower = command.toLowerCase().trim();
  const parts = lower.split(/\s+/);
  const sub = parts.find((p, i) => i > 0 && !p.startsWith('-')) ?? '';
  switch (sub) {
    case 'diff': return 'diff';
    case 'log': return 'log';
    case 'status': return 'status';
    case 'show': return 'show';
    case 'add': return 'add';
    case 'commit': return 'commit';
    case 'push': return 'push';
    case 'pull': return 'pull';
    case 'branch': return 'branch';
    case 'fetch': return 'fetch';
    case 'stash': return 'stash';
    case 'worktree': return 'worktree';
    default: return 'unknown';
  }
}

/** Compact a unified diff to stat summary + changed lines only */
export function compactDiff(diff: string, maxLines = 100): string {
  const lines = diff.split('\n');
  const result: string[] = [];
  let kept = 0;
  let currentFile = '';

  for (const line of lines) {
    if (kept >= maxLines) break;
    if (line.startsWith('diff --git') || line.startsWith('--- ') || line.startsWith('+++ ')) {
      if (line.startsWith('+++ ')) {
        currentFile = line.replace(/^\+\+\+ b?\//, '');
        result.push(`\n--- ${currentFile} ---`);
      }
      continue;
    }
    if (line.startsWith('@@')) continue; // skip hunk headers
    if (line.startsWith('+') || line.startsWith('-')) {
      const truncated = line.length > 120 ? line.slice(0, 117) + '...' : line;
      result.push(truncated);
      kept++;
    }
  }

  if (lines.length > maxLines) {
    result.push(`\n... ${lines.length - maxLines} more lines`);
  }

  return result.join('\n').trim();
}

/** Compact git log output: keep hash + subject only */
export function compactLog(log: string, maxEntries = 20): string {
  const lines = log.split('\n');
  const entries: string[] = [];
  let count = 0;

  for (const line of lines) {
    if (count >= maxEntries) break;
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Typical format: "abc1234 Subject line" or "commit abc1234..."
    if (trimmed.startsWith('commit ')) {
      entries.push(trimmed.replace('commit ', '').slice(0, 12));
    } else if (/^[0-9a-f]{7,}/.test(trimmed)) {
      entries.push(trimmed.length > 80 ? trimmed.slice(0, 77) + '...' : trimmed);
      count++;
    }
  }

  return entries.join('\n');
}

/** Compact git status output */
export function compactStatus(status: string): string {
  const lines = status.split('\n');
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];

  for (const line of lines) {
    if (!line.trim() || line.startsWith('On branch') || line.startsWith('HEAD')) continue;
    if (line.startsWith('\t')) {
      const name = line.trim();
      if (line.includes('new file:') || line.includes('modified:') || line.includes('deleted:')) {
        staged.push(name);
      } else {
        unstaged.push(name);
      }
    } else if (line.startsWith('?? ')) {
      untracked.push(line.slice(3));
    }
  }

  const parts: string[] = [];
  if (staged.length) parts.push(`staged(${staged.length}): ${staged.slice(0, 5).join(', ')}`);
  if (unstaged.length) parts.push(`unstaged(${unstaged.length}): ${unstaged.slice(0, 5).join(', ')}`);
  if (untracked.length) parts.push(`untracked(${untracked.length}): ${untracked.slice(0, 5).join(', ')}`);
  return parts.length ? parts.join('\n') : 'clean';
}

/** Compress git command output based on subcommand */
export function compressGitOutput(subcommand: GitSubcommand, rawOutput: string): string {
  switch (subcommand) {
    case 'diff': return compactDiff(rawOutput);
    case 'log': return compactLog(rawOutput);
    case 'status': return compactStatus(rawOutput);
    case 'show': return compactDiff(rawOutput, 60);
    case 'add': case 'commit': case 'push': case 'pull': case 'fetch': {
      // These are usually short confirmations — trim and cap
      const lines = rawOutput.split('\n').filter((l) => l.trim());
      return lines.slice(0, 10).join('\n');
    }
    default:
      return rawOutput.split('\n').slice(0, 50).join('\n');
  }
}
