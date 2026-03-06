/**
 * density-filter — sentence-level, query-relevant context compression.
 *
 * Ported from Rust (sentence.rs): zero-dependency, no LLM required.
 * Only the sentence mode is ported; logprob/GGUF mode is omitted.
 *
 * Algorithm:
 * 1. Split context into sentences on .!? boundaries and newlines.
 * 2. Deduplicate via FNV-1a hash of normalized text.
 * 3. Score each unique sentence by query-term overlap.
 * 4. Select top-scored sentences within token budget.
 * 5. Reconstruct in original document order.
 */

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'shall', 'should', 'may', 'might', 'must', 'can', 'could', 'not',
  'it', 'its', 'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she',
  'we', 'they', 'me', 'him', 'her', 'us', 'them', 'my', 'your', 'his',
  'our', 'their', 'which', 'who', 'what', 'how', 'when', 'where', 'as',
  'if', 'so', 'than', 'then', 'no', 'up', 'out', 'about', 'into', 'also',
  'just', 'more', 'all', 'there', 'get', 'use', 'one', 'two', 'new',
]);

const BOILERPLATE_PATTERNS = [
  'copyright',
  'all rights reserved',
  'disclaimer',
  'terms of use',
  'privacy policy',
  'proprietary',
  'confidential',
  'trademark',
];

function tokenize(text: string): string[] {
  if (!text) return [];
  const tokens: string[] = [];
  const re = /[\p{L}\p{N}]+|[^\s]/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    tokens.push(m[0]);
  }
  return tokens;
}

function estimateTokens(text: string): number {
  if (!text) return 0;
  return tokenize(text).length;
}

function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  let current = '';
  for (const ch of text) {
    if (ch === '\n') {
      const trimmed = current.trim();
      if (trimmed) sentences.push(trimmed);
      current = '';
    } else if (ch === '.' || ch === '!' || ch === '?') {
      current += ch;
      const trimmed = current.trim();
      if (trimmed) sentences.push(trimmed);
      current = '';
    } else {
      current += ch;
    }
  }
  const trimmed = current.trim();
  if (trimmed) sentences.push(trimmed);
  return sentences;
}

function normalizeSentence(s: string): string {
  return s
    .split('')
    .filter((c) => /[\p{L}\p{N}\s]/u.test(c))
    .join('')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function isBoilerplateText(s: string): boolean {
  const lower = s.toLowerCase();
  return BOILERPLATE_PATTERNS.some((pat) => lower.includes(pat));
}

function fnv1aHash(s: string): bigint {
  const FNV_OFFSET = 14695981039346656037n;
  const FNV_PRIME = 1099511628211n;
  let hash = FNV_OFFSET;
  for (let i = 0; i < s.length; i++) {
    hash ^= BigInt(s.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * FNV_PRIME);
  }
  return hash;
}

interface SentenceFeatures {
  text: string;
  tokenCount: number;
  uniqueTerms: Set<string>;
  isBoilerplate: boolean;
  originalIndex: number;
}

interface PreprocessedContext {
  sentences: string[];
  uniqueFeatures: SentenceFeatures[];
  estimatedTotalTokens: number;
}

function preprocessContext(context: string): PreprocessedContext {
  const sentences = splitSentences(context);
  const estimatedTotalTokens = estimateTokens(context);

  const allFeatures: SentenceFeatures[] = sentences.map((s, i) => {
    const tokenCount = estimateTokens(s);
    const uniqueTerms = new Set(
      tokenize(s)
        .map((t) => t.toLowerCase())
        .filter((t) => t.length > 2 && !STOP_WORDS.has(t)),
    );
    return {
      text: s,
      tokenCount,
      uniqueTerms,
      isBoilerplate: isBoilerplateText(s),
      originalIndex: i,
    };
  });

  const seen = new Set<bigint>();
  const uniqueFeatures = allFeatures.filter((f) => {
    const h = fnv1aHash(normalizeSentence(f.text));
    if (seen.has(h)) return false;
    seen.add(h);
    return true;
  });

  return { sentences, uniqueFeatures, estimatedTotalTokens };
}

function extractQueryTerms(query: string): Set<string> {
  return new Set(
    tokenize(query)
      .map((t) => t.toLowerCase())
      .filter((t) => t.length > 2 && !STOP_WORDS.has(t)),
  );
}

function scoreSentenceFeature(feat: SentenceFeatures, queryTerms: Set<string>): number {
  const overlap = [...feat.uniqueTerms].filter((t) => queryTerms.has(t)).length;
  const boilerplatePenalty = feat.isBoilerplate ? 0.5 : 0;
  const lengthScore = Math.min(feat.tokenCount, 40) / 40;
  const overlapRatio = queryTerms.size > 0 ? overlap / queryTerms.size : 0;
  return overlap * 2 + overlapRatio + lengthScore - boilerplatePenalty;
}

export interface DensityOptions {
  /** Fraction of tokens to remove (default: 0.45) */
  targetReduction?: number;
  /** Minimum tokens to retain (default: 80) */
  minTokens?: number;
  /** Maximum sentences to keep (default: 10) */
  maxSentences?: number;
}

export interface DensityResult {
  compressed: string;
  nOriginalSentences: number;
  nKeptSentences: number;
  estimatedOriginalTokens: number;
  estimatedKeptTokens: number;
  latencyMs: number;
}

/**
 * Density-based sentence filtering.
 * Scores sentences by query-term density, selects top sentences within a
 * token budget, and reconstructs them in original document order.
 */
export function densityFilter(text: string, query: string, options?: DensityOptions): DensityResult {
  const start = performance.now();
  const targetReduction = options?.targetReduction ?? 0.45;
  const minTokens = options?.minTokens ?? 80;
  const maxSentences = options?.maxSentences ?? 10;

  const pre = preprocessContext(text);
  const nOriginalSentences = pre.sentences.length;
  const estimatedOriginalTokens = pre.estimatedTotalTokens;

  if (pre.uniqueFeatures.length === 0) {
    return {
      compressed: '',
      nOriginalSentences,
      nKeptSentences: 0,
      estimatedOriginalTokens,
      estimatedKeptTokens: 0,
      latencyMs: performance.now() - start,
    };
  }

  const queryTerms = extractQueryTerms(query);

  const scored = pre.uniqueFeatures
    .map((f) => ({ score: scoreSentenceFeature(f, queryTerms), originalIndex: f.originalIndex, tokenCount: f.tokenCount }))
    .sort((a, b) => b.score - a.score);

  const tokenBudget = Math.max(
    minTokens,
    Math.round(estimatedOriginalTokens * (1 - targetReduction)),
  );

  const keptIndices: number[] = [];
  let tokensUsed = 0;

  for (const { originalIndex, tokenCount } of scored) {
    if (keptIndices.length >= maxSentences) break;
    if (tokensUsed + tokenCount <= tokenBudget) {
      keptIndices.push(originalIndex);
      tokensUsed += tokenCount;
    }
  }

  keptIndices.sort((a, b) => a - b);
  const compressed = keptIndices.map((i) => pre.sentences[i]).join(' ');
  const estimatedKeptTokens = estimateTokens(compressed);

  return {
    compressed,
    nOriginalSentences,
    nKeptSentences: keptIndices.length,
    estimatedOriginalTokens,
    estimatedKeptTokens,
    latencyMs: performance.now() - start,
  };
}
