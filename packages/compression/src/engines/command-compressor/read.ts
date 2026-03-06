/**
 * read.ts — compress file content with language-aware filtering.
 * Ported from rtk read.rs.
 */
import { applyFilter, smartTruncate, languageFromExtension, type FilterLevel } from './filter.js';

export interface ReadCompressionOptions {
  filterLevel?: FilterLevel;
  maxLines?: number;
  lineNumbers?: boolean;
  /** File extension for language detection (e.g. 'rs', 'ts') */
  fileExtension?: string;
}

function formatWithLineNumbers(content: string): string {
  const lines = content.split('\n');
  const width = String(lines.length).length;
  return lines.map((line, i) => `${String(i + 1).padStart(width)} | ${line}`).join('\n');
}

/** Apply filter + optional truncation to file content */
export function compressReadOutput(
  content: string,
  options?: ReadCompressionOptions,
): string {
  const level = options?.filterLevel ?? 'minimal';
  const ext = options?.fileExtension ?? '';
  const lang = languageFromExtension(ext);

  let filtered = applyFilter(content, lang, level);

  if (options?.maxLines) {
    filtered = smartTruncate(filtered, options.maxLines);
  }

  if (options?.lineNumbers) {
    return formatWithLineNumbers(filtered);
  }

  return filtered;
}
