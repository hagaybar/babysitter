/**
 * grep.ts — compress grep/rg output into grouped, truncated format.
 * Ported from rtk grep_cmd.rs.
 */

function cleanLine(line: string, maxLen: number): string {
  const trimmed = line.trim();
  if (trimmed.length <= maxLen) return trimmed;

  // Truncate long lines with ellipsis
  return trimmed.slice(0, maxLen - 3) + '...';
}

function compactPath(path: string): string {
  if (path.length <= 50) return path;
  const parts = path.split('/');
  if (parts.length <= 3) return path;
  return `${parts[0]}}/.../${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

/** Compress grep/rg output: group by file, truncate long lines */
export function compressGrepOutput(
  rawOutput: string,
  pattern: string,
  maxResults = 50,
  maxLineLen = 120,
): string {
  if (!rawOutput.trim()) return `0 matches for '${pattern}'`;

  const byFile = new Map<string, Array<[number, string]>>();
  let total = 0;

  for (const line of rawOutput.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split(':');
    let file: string, lineNum: number, content: string;

    if (parts.length >= 3 && /^\d+$/.test(parts[1])) {
      file = parts[0];
      lineNum = parseInt(parts[1], 10);
      content = parts.slice(2).join(':');
    } else {
      continue;
    }

    total++;
    const cleaned = cleanLine(content, maxLineLen);
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file)!.push([lineNum, cleaned]);
  }

  if (total === 0) return `0 matches for '${pattern}'`;

  let out = `${total} matches in ${byFile.size} files:\n\n`;
  let shown = 0;
  const filesSorted = [...byFile.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  for (const [file, matches] of filesSorted) {
    if (shown >= maxResults) break;
    out += `${compactPath(file)} (${matches.length}):\n`;
    for (const [ln, content] of matches.slice(0, 10)) {
      out += `  ${String(ln).padStart(4)}: ${content}\n`;
      shown++;
      if (shown >= maxResults) break;
    }
    if (matches.length > 10) out += `  +${matches.length - 10}\n`;
    out += '\n';
  }

  if (total > shown) out += `... +${total - shown} more\n`;
  return out;
}
