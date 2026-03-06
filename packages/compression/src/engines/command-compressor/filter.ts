/**
 * filter.ts — language-aware code comment/whitespace filter.
 * Ported from rtk filter.rs. Supports None, Minimal, Aggressive levels.
 */

export type FilterLevel = 'none' | 'minimal' | 'aggressive';

export type Language =
  | 'rust'
  | 'python'
  | 'javascript'
  | 'typescript'
  | 'go'
  | 'c'
  | 'cpp'
  | 'java'
  | 'ruby'
  | 'shell'
  | 'unknown';

interface CommentPatterns {
  line?: string;
  blockStart?: string;
  blockEnd?: string;
  docLine?: string;
  docBlockStart?: string;
}

export function languageFromExtension(ext: string): Language {
  switch (ext.toLowerCase()) {
    case 'rs': return 'rust';
    case 'py': case 'pyw': return 'python';
    case 'js': case 'mjs': case 'cjs': return 'javascript';
    case 'ts': case 'tsx': return 'typescript';
    case 'go': return 'go';
    case 'c': case 'h': return 'c';
    case 'cpp': case 'cc': case 'cxx': case 'hpp': case 'hh': return 'cpp';
    case 'java': return 'java';
    case 'rb': return 'ruby';
    case 'sh': case 'bash': case 'zsh': return 'shell';
    default: return 'unknown';
  }
}

function commentPatterns(lang: Language): CommentPatterns {
  switch (lang) {
    case 'rust':
      return { line: '//', blockStart: '/*', blockEnd: '*/', docLine: '///', docBlockStart: '/**' };
    case 'python':
      return { line: '#', blockStart: '"""', blockEnd: '"""', docBlockStart: '"""' };
    case 'javascript': case 'typescript': case 'go': case 'c': case 'cpp': case 'java':
      return { line: '//', blockStart: '/*', blockEnd: '*/', docBlockStart: '/**' };
    case 'ruby':
      return { line: '#', blockStart: '=begin', blockEnd: '=end' };
    case 'shell':
      return { line: '#' };
    default:
      return { line: '//', blockStart: '/*', blockEnd: '*/' };
  }
}

function minimalFilter(content: string, lang: Language): string {
  const patterns = commentPatterns(lang);
  const lines = content.split('\n');
  const result: string[] = [];
  let inBlockComment = false;
  let inDocstring = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (patterns.blockStart && patterns.blockEnd) {
      if (!inDocstring && trimmed.includes(patterns.blockStart) &&
          !(patterns.docBlockStart && trimmed.startsWith(patterns.docBlockStart))) {
        inBlockComment = true;
      }
      if (inBlockComment) {
        if (trimmed.includes(patterns.blockEnd)) inBlockComment = false;
        continue;
      }
    }

    if (lang === 'python' && trimmed.startsWith('"""')) {
      inDocstring = !inDocstring;
      result.push(line);
      continue;
    }
    if (inDocstring) { result.push(line); continue; }

    if (patterns.line && trimmed.startsWith(patterns.line)) {
      if (patterns.docLine && trimmed.startsWith(patterns.docLine)) {
        result.push(line);
      }
      continue;
    }

    result.push(line);
  }

  return result.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const IMPORT_RE = /^(use |import |from |require\(|#include)/;
const FUNC_SIG_RE = /^(pub\s+)?(async\s+)?(fn|def|function|func|class|struct|enum|trait|interface|type)\s+\w+/;

function aggressiveFilter(content: string, lang: Language): string {
  const minimal = minimalFilter(content, lang);
  const lines = minimal.split('\n');
  const result: string[] = [];
  let braceDepth = 0;
  let inImplBody = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (IMPORT_RE.test(trimmed)) { result.push(line); continue; }
    if (FUNC_SIG_RE.test(trimmed)) { result.push(line); inImplBody = true; braceDepth = 0; continue; }

    const openBraces = (trimmed.match(/\{/g) ?? []).length;
    const closeBraces = (trimmed.match(/\}/g) ?? []).length;

    if (inImplBody) {
      braceDepth += openBraces - closeBraces;
      if (braceDepth <= 1 && (trimmed === '{' || trimmed === '}' || trimmed.endsWith('{'))) {
        result.push(line);
      }
      if (braceDepth <= 0) {
        inImplBody = false;
        if (trimmed && trimmed !== '}') result.push('    // ... implementation');
      }
      continue;
    }

    if (trimmed.startsWith('const ') || trimmed.startsWith('static ') ||
        trimmed.startsWith('let ') || trimmed.startsWith('pub const ') ||
        trimmed.startsWith('pub static ')) {
      result.push(line);
    }
  }

  return result.join('\n').trim();
}

export function applyFilter(content: string, lang: Language, level: FilterLevel): string {
  switch (level) {
    case 'none': return content;
    case 'minimal': return minimalFilter(content, lang);
    case 'aggressive': return aggressiveFilter(content, lang);
  }
}

export function smartTruncate(content: string, maxLines: number): string {
  const lines = content.split('\n');
  if (lines.length <= maxLines) return content;

  const result: string[] = [];
  let keptLines = 0;
  let skippedSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    const isImportant =
      FUNC_SIG_RE.test(trimmed) ||
      IMPORT_RE.test(trimmed) ||
      trimmed.startsWith('pub ') ||
      trimmed.startsWith('export ') ||
      trimmed === '}' || trimmed === '{';

    if (isImportant || keptLines < maxLines / 2) {
      if (skippedSection) {
        result.push(`    // ... ${lines.length - keptLines} lines omitted`);
        skippedSection = false;
      }
      result.push(line);
      keptLines++;
    } else {
      skippedSection = true;
    }
    if (keptLines >= maxLines - 1) break;
  }

  if (skippedSection || keptLines < lines.length) {
    result.push(`// ... ${lines.length - keptLines} more lines (total: ${lines.length})`);
  }

  return result.join('\n');
}
