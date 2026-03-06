/**
 * diff.ts — compress diff/comparison output.
 * Ported from rtk diff_cmd.rs.
 */

interface DiffChange {
  kind: 'added' | 'removed' | 'modified';
  lineNum: number;
  content: string;
  newContent?: string;
}

interface DiffResult {
  added: number;
  removed: number;
  modified: number;
  changes: DiffChange[];
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 3) + '...';
}

function similarity(a: string, b: string): number {
  const aChars = new Set(a.split(''));
  const bChars = new Set(b.split(''));
  const intersection = [...aChars].filter((c) => bChars.has(c)).length;
  const union = new Set([...aChars, ...bChars]).size;
  return union === 0 ? 1.0 : intersection / union;
}

function computeDiff(lines1: string[], lines2: string[]): DiffResult {
  const changes: DiffChange[] = [];
  let added = 0, removed = 0, modified = 0;
  const maxLen = Math.max(lines1.length, lines2.length);

  for (let i = 0; i < maxLen; i++) {
    const l1 = lines1[i];
    const l2 = lines2[i];

    if (l1 !== undefined && l2 !== undefined && l1 !== l2) {
      if (similarity(l1, l2) > 0.5) {
        changes.push({ kind: 'modified', lineNum: i + 1, content: l1, newContent: l2 });
        modified++;
      } else {
        changes.push({ kind: 'removed', lineNum: i + 1, content: l1 });
        changes.push({ kind: 'added', lineNum: i + 1, content: l2 });
        removed++; added++;
      }
    } else if (l1 !== undefined && l2 === undefined) {
      changes.push({ kind: 'removed', lineNum: i + 1, content: l1 });
      removed++;
    } else if (l1 === undefined && l2 !== undefined) {
      changes.push({ kind: 'added', lineNum: i + 1, content: l2 });
      added++;
    }
  }

  return { added, removed, modified, changes };
}

/** Condense unified diff format (from git diff / diff -u) */
export function condenseDiff(diff: string): string {
  const result: string[] = [];
  let currentFile = '';
  let added = 0, removed = 0;
  const changes: string[] = [];

  const flush = (): void => {
    if (currentFile && (added > 0 || removed > 0)) {
      result.push(`${currentFile} (+${added} -${removed})`);
      for (const c of changes.slice(0, 10)) result.push(`  ${c}`);
      if (changes.length > 10) result.push(`  ... +${changes.length - 10} more`);
    }
  };

  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      flush();
      currentFile = line.replace(/^\+\+\+ b?\//, '');
      added = 0; removed = 0; changes.length = 0;
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      added++;
      if (changes.length < 15) changes.push(truncate(line, 70));
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      removed++;
      if (changes.length < 15) changes.push(truncate(line, 70));
    }
  }
  flush();

  return result.join('\n');
}

/** Compare two text blocks and produce a compact diff summary */
export function compressDiffOutput(text1: string, text2: string): string {
  if (text1 === text2) return 'files are identical';

  const lines1 = text1.split('\n');
  const lines2 = text2.split('\n');
  const diff = computeDiff(lines1, lines2);
  const parts: string[] = [];
  parts.push(`+${diff.added} added, -${diff.removed} removed, ~${diff.modified} modified`);

  for (const change of diff.changes.slice(0, 50)) {
    if (change.kind === 'added') {
      parts.push(`+${String(change.lineNum).padStart(4)} ${truncate(change.content, 80)}`);
    } else if (change.kind === 'removed') {
      parts.push(`-${String(change.lineNum).padStart(4)} ${truncate(change.content, 80)}`);
    } else if (change.kind === 'modified') {
      parts.push(`~${String(change.lineNum).padStart(4)} ${truncate(change.content, 70)} -> ${truncate(change.newContent ?? '', 70)}`);
    }
  }

  if (diff.changes.length > 50) parts.push(`... +${diff.changes.length - 50} more changes`);
  return parts.join('\n');
}
