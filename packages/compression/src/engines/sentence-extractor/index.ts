// @ts-expect-error — .mjs interop under ESM package
import { extractSentences, estimateTokens } from './engine.mjs';

export interface SentenceExtractOptions {
  /** Target fraction to remove (default: 0.45) */
  targetReduction?: number;
  /** Minimum tokens to keep in output (default: 80) */
  minCompressionTokens?: number;
  /** Maximum sentences to select (default: 10) */
  maxSentences?: number;
}

export interface SentenceExtractResult {
  /** The extracted/compressed text */
  compressedText: string;
  /** Estimated token count of input */
  originalTokens: number;
  /** Estimated token count of output */
  compressedTokens: number;
  /** Fraction removed: (original - compressed) / original */
  reductionRatio: number;
  /** Wall-clock latency of this call in milliseconds */
  latencyMs: number;
}

/**
 * Query-aware sentence extraction.
 *
 * Scores every sentence in `context` by term-overlap with `query`, then
 * greedily selects the highest-scoring sentences that fit within the token
 * budget derived from `options.targetReduction`.
 *
 * No network calls or LLM required — pure deterministic algorithm.
 */
export function sentenceExtract(
  context: string,
  query: string,
  options?: SentenceExtractOptions,
): SentenceExtractResult {
  const start = performance.now();

  const raw = extractSentences({
    context,
    query,
    targetReduction: options?.targetReduction,
    minCompressionTokens: options?.minCompressionTokens,
    maxCompressionSentences: options?.maxSentences,
  }) as {
    compressedText: string;
    originalTokens: number;
    compressedTokens: number;
    reductionRatio: number;
  };

  return {
    compressedText: raw.compressedText,
    originalTokens: raw.originalTokens,
    compressedTokens: raw.compressedTokens,
    reductionRatio: raw.reductionRatio,
    latencyMs: performance.now() - start,
  };
}
