import crypto from 'node:crypto';

const TOKEN_REGEX = /[\p{L}\p{N}]+|[^\s]/gu;
const TOKEN_NORMALIZE_REGEX = /[^\p{L}\p{N}]/gu;
const DEDUPE_NORMALIZE_REGEX = /[^\p{L}\p{N}\s]/gu;
const BOILERPLATE_REGEX = /copyright|all rights reserved|disclaimer|confidential/i;
const MAX_SEGMENT_TOKENS = 120;

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'how', 'in', 'is', 'it',
  'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was', 'we', 'with', 'you', 'your', 'our',
]);

export const DEFAULT_OPTIONS = {
  minCompressionTokens: 80,
  maxCompressionSentences: 10,
  targetReduction: 0.45,
};

export function tokenize(text) {
  if (!text) {
    return [];
  }
  const matches = text.match(TOKEN_REGEX);
  return matches ?? [];
}

export function estimateTokens(text) {
  return tokenize(text).length;
}

function normalizeForDeduping(sentence) {
  return sentence
    .toLowerCase()
    .replace(DEDUPE_NORMALIZE_REGEX, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitIntoSentences(text) {
  return text
    .split(/(?<=[.!?])\s+|\n+/g)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function chunkTokens(tokens, chunkSize) {
  const chunks = [];
  for (let index = 0; index < tokens.length; index += chunkSize) {
    chunks.push(tokens.slice(index, index + chunkSize));
  }
  return chunks;
}

function splitOversizedSentence(sentence, maxTokens = MAX_SEGMENT_TOKENS) {
  const rawTokens = tokenize(sentence);
  if (rawTokens.length <= maxTokens) {
    return [sentence];
  }

  const commaSplit = sentence
    .split(/(?<=[,;:])\s+|\s+-\s+/g)
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (commaSplit.length > 1) {
    const segments = [];
    for (const segment of commaSplit) {
      if (estimateTokens(segment) <= maxTokens) {
        segments.push(segment);
      } else {
        for (const chunk of chunkTokens(tokenize(segment), maxTokens)) {
          segments.push(chunk.join(' '));
        }
      }
    }
    return segments;
  }

  return chunkTokens(rawTokens, maxTokens).map((chunk) => chunk.join(' '));
}

function normalizeToken(token) {
  return token.replace(TOKEN_NORMALIZE_REGEX, '').trim();
}

function tokenizeNormalized(text) {
  return tokenize((text ?? '').toLowerCase())
    .map(normalizeToken)
    .filter(Boolean);
}

function normalizedTermsFromRawTokens(rawTokens) {
  return rawTokens
    .map((token) => normalizeToken(token.toLowerCase()))
    .filter(Boolean);
}

function queryTerms(query) {
  const terms = tokenizeNormalized(query)
    .filter((term) => term.length >= 3 && !STOP_WORDS.has(term));
  return new Set(terms);
}

function preprocessContext(context) {
  const normalizedContext = context ?? '';
  const originalTokens = estimateTokens(normalizedContext);
  const dedupeSet = new Set();
  const candidates = [];

  for (const sentence of splitIntoSentences(normalizedContext)) {
    for (const segment of splitOversizedSentence(sentence)) {
      const normalized = normalizeForDeduping(segment);
      if (!normalized || dedupeSet.has(normalized)) {
        continue;
      }

      dedupeSet.add(normalized);

      const rawTokens = tokenize(segment);
      const normalizedTerms = normalizedTermsFromRawTokens(rawTokens);
      const lowered = segment.toLowerCase();

      candidates.push({
        sentence: segment,
        index: candidates.length,
        tokenCount: rawTokens.length,
        uniqueTerms: new Set(normalizedTerms),
        isBoilerplate: BOILERPLATE_REGEX.test(lowered),
      });
    }
  }

  return {
    originalTokens,
    dedupedSentenceCount: candidates.length,
    candidates,
  };
}

function scoreSentenceCandidate(candidate, terms) {
  if (candidate.tokenCount === 0) {
    return { score: 0, overlapCount: 0, overlapTerms: [] };
  }

  const overlapTerms = [];
  let overlap = 0;

  for (const term of terms) {
    if (candidate.uniqueTerms.has(term)) {
      overlap += 1;
      overlapTerms.push(term);
    }
  }

  const overlapScore = overlap * 2;
  const densityScore = terms.size > 0 ? overlap / terms.size : 0;
  const lengthScore = Math.min(candidate.tokenCount, 40) / 40;
  const boilerplatePenalty = candidate.isBoilerplate ? 0.5 : 0;

  return {
    score: overlapScore + densityScore + lengthScore - boilerplatePenalty,
    overlapCount: overlap,
    overlapTerms,
  };
}

/**
 * Core query-aware sentence extraction algorithm.
 * Selects the most relevant sentences within a token budget.
 */
export function extractSentences({
  context,
  query,
  minCompressionTokens = DEFAULT_OPTIONS.minCompressionTokens,
  maxCompressionSentences = DEFAULT_OPTIONS.maxCompressionSentences,
  targetReduction = DEFAULT_OPTIONS.targetReduction,
}) {
  const contextText = context ?? '';
  const contextAnalysis = preprocessContext(contextText);
  const { originalTokens, dedupedSentenceCount, candidates } = contextAnalysis;
  const targetTokens = Math.max(
    1,
    Math.max(minCompressionTokens, Math.floor(originalTokens * (1 - targetReduction))),
  );

  const terms = queryTerms(query);
  const scoredSentences = candidates.map((candidate) => ({
    sentence: candidate.sentence,
    index: candidate.index,
    ...scoreSentenceCandidate(candidate, terms),
    tokens: candidate.tokenCount,
  }));

  const selected = [];
  const selectedIndices = new Set();
  const coveredTerms = new Set();
  let selectedTokens = 0;

  while (selected.length < maxCompressionSentences) {
    let bestCandidate = null;
    let bestAdjustedScore = Number.NEGATIVE_INFINITY;

    for (const candidate of scoredSentences) {
      if (selectedIndices.has(candidate.index)) {
        continue;
      }

      const underBudget = selectedTokens + candidate.tokens <= targetTokens;
      const forceTopCandidate = selected.length === 0;
      const forceRelevantSecond = selected.length === 1 && candidate.overlapCount > 0;

      if (!underBudget && !forceTopCandidate && !forceRelevantSecond) {
        continue;
      }

      let uncoveredOverlapCount = 0;
      for (const term of candidate.overlapTerms) {
        if (!coveredTerms.has(term)) {
          uncoveredOverlapCount += 1;
        }
      }

      const adjustedScore = candidate.score + uncoveredOverlapCount * 1.2;

      if (adjustedScore > bestAdjustedScore) {
        bestAdjustedScore = adjustedScore;
        bestCandidate = candidate;
        continue;
      }

      if (adjustedScore === bestAdjustedScore && bestCandidate) {
        if (candidate.overlapCount > bestCandidate.overlapCount) {
          bestCandidate = candidate;
          continue;
        }
        if (
          candidate.overlapCount === bestCandidate.overlapCount
          && candidate.tokens < bestCandidate.tokens
        ) {
          bestCandidate = candidate;
          continue;
        }
        if (
          candidate.overlapCount === bestCandidate.overlapCount
          && candidate.tokens === bestCandidate.tokens
          && candidate.index < bestCandidate.index
        ) {
          bestCandidate = candidate;
        }
      }
    }

    if (!bestCandidate) {
      break;
    }

    selected.push(bestCandidate);
    selectedIndices.add(bestCandidate.index);
    selectedTokens += bestCandidate.tokens;

    for (const term of bestCandidate.overlapTerms) {
      coveredTerms.add(term);
    }
  }

  const selectedTermCounts = new Map();
  for (const candidate of selected) {
    for (const term of candidate.overlapTerms) {
      selectedTermCounts.set(term, (selectedTermCounts.get(term) ?? 0) + 1);
    }
  }

  const missingTerms = [...terms].filter((term) => !selectedTermCounts.has(term));

  for (const missingTerm of missingTerms) {
    const candidateOptions = scoredSentences
      .filter(
        (candidate) =>
          !selectedIndices.has(candidate.index)
          && candidate.overlapTerms.includes(missingTerm),
      )
      .sort((left, right) => {
        if (right.score === left.score) {
          return left.tokens - right.tokens;
        }
        return right.score - left.score;
      });

    for (const candidate of candidateOptions) {
      let bestSwapIndex = -1;
      let bestSwapNetGain = Number.NEGATIVE_INFINITY;
      let bestSwapScore = Number.POSITIVE_INFINITY;

      for (let index = 0; index < selected.length; index += 1) {
        const existing = selected[index];
        const swappedTokens = selectedTokens - existing.tokens + candidate.tokens;
        if (swappedTokens > targetTokens) {
          continue;
        }

        let gainCount = 0;
        for (const term of candidate.overlapTerms) {
          if (!selectedTermCounts.has(term)) {
            gainCount += 1;
          }
        }

        let lossCount = 0;
        for (const term of existing.overlapTerms) {
          const count = selectedTermCounts.get(term) ?? 0;
          const preservedByCandidate = candidate.overlapTerms.includes(term);
          if (count === 1 && !preservedByCandidate) {
            lossCount += 1;
          }
        }

        const netGain = gainCount - lossCount;
        if (netGain <= 0) {
          continue;
        }

        if (netGain > bestSwapNetGain) {
          bestSwapNetGain = netGain;
          bestSwapIndex = index;
          bestSwapScore = existing.score;
          continue;
        }

        if (netGain === bestSwapNetGain && existing.score < bestSwapScore) {
          bestSwapIndex = index;
          bestSwapScore = existing.score;
        }
      }

      if (bestSwapIndex === -1) {
        continue;
      }

      const removed = selected[bestSwapIndex];
      selected[bestSwapIndex] = candidate;
      selectedTokens = selectedTokens - removed.tokens + candidate.tokens;
      selectedIndices.delete(removed.index);
      selectedIndices.add(candidate.index);

      for (const term of removed.overlapTerms) {
        const nextCount = (selectedTermCounts.get(term) ?? 0) - 1;
        if (nextCount <= 0) {
          selectedTermCounts.delete(term);
        } else {
          selectedTermCounts.set(term, nextCount);
        }
      }

      for (const term of candidate.overlapTerms) {
        selectedTermCounts.set(term, (selectedTermCounts.get(term) ?? 0) + 1);
      }

      break;
    }
  }

  selected.sort((a, b) => a.index - b.index);

  let compressedText = selected.map((item) => item.sentence).join(' ');

  if (!compressedText) {
    compressedText = tokenize(contextText).slice(0, targetTokens).join(' ');
  } else {
    const compressedRawTokens = tokenize(compressedText);
    if (compressedRawTokens.length > targetTokens) {
      compressedText = compressedRawTokens.slice(0, targetTokens).join(' ');
    }
  }

  const compressedTokens = estimateTokens(compressedText);

  return {
    compressedText,
    compressedTokens,
    originalTokens,
    reductionRatio:
      originalTokens === 0 ? 0 : (originalTokens - compressedTokens) / originalTokens,
    selectedSentenceCount: selected.length,
    dedupedSentenceCount,
  };
}
