/**
 * ls.ts — compress ls output into compact format.
 * Ported from rtk ls.rs.
 */

const NOISE_DIRS = new Set([
  'node_modules', '.git', 'target', '__pycache__', '.next', 'dist', 'build',
  '.cache', '.turbo', '.vercel', '.pytest_cache', '.mypy_cache', '.tox',
  '.venv', 'venv', 'coverage', '.nyc_output', '.DS_Store', 'Thumbs.db',
  '.idea', '.vscode', '.vs', '.eggs',
]);

function humanSize(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)}M`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${bytes}B`;
}

/** Parse ls -la raw output into compact name/size format */
export function compactLs(raw: string, showAll = false): string {
  const dirs: string[] = [];
  const files: Array<[string, string]> = [];
  const byExt = new Map<string, number>();

  for (const line of raw.split('\n')) {
    if (line.startsWith('total ') || !line.trim()) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 9) continue;

    const name = parts.slice(8).join(' ');
    if (name === '.' || name === '..') continue;
    if (!showAll && NOISE_DIRS.has(name)) continue;

    if (parts[0].startsWith('d')) {
      dirs.push(name);
    } else if (parts[0].startsWith('-') || parts[0].startsWith('l')) {
      const size = parseInt(parts[4], 10) || 0;
      const dotPos = name.lastIndexOf('.');
      const ext = dotPos >= 0 ? name.slice(dotPos) : 'no ext';
      byExt.set(ext, (byExt.get(ext) ?? 0) + 1);
      files.push([name, humanSize(size)]);
    }
  }

  if (!dirs.length && !files.length) return '(empty)\n';

  let out = '';
  for (const d of dirs) out += `${d}/\n`;
  for (const [name, size] of files) out += `${name}  ${size}\n`;

  out += '\n';
  let summary = `${files.length} files, ${dirs.length} dirs`;
  if (byExt.size) {
    const extCounts = [...byExt.entries()].sort((a, b) => b[1] - a[1]);
    const extParts = extCounts.slice(0, 5).map(([e, c]) => `${c} ${e}`);
    summary += ` (${extParts.join(', ')}`;
    if (extCounts.length > 5) summary += `, +${extCounts.length - 5} more`;
    summary += ')';
  }
  out += summary + '\n';
  return out;
}

/** Compress raw ls output */
export function compressLsOutput(rawOutput: string, showAll = false): string {
  return compactLs(rawOutput, showAll);
}
