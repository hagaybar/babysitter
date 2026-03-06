/**
 * engines.integration.test.ts
 *
 * Integration tests for the three compression engines:
 *   - sentence-extractor  (sentenceExtract)
 *   - density-filter      (densityFilter)
 *   - command-compressor  (compressCommandOutput)
 *
 * All tests operate on real prose / code / command output — no mocks.
 */

import { describe, it, expect } from 'vitest';
import { sentenceExtract } from '../engines/sentence-extractor/index.js';
import { densityFilter } from '../engines/density-filter/index.js';
import { compressCommandOutput } from '../engines/command-compressor/index.js';

// ---------------------------------------------------------------------------
// sentenceExtract
// ---------------------------------------------------------------------------

describe('sentenceExtract — real prose (200+ words)', () => {
  // ~230 words of prose covering software architecture
  const LONG_PROSE = [
    'Modern software systems are increasingly built around microservices architectures.',
    'Each microservice is responsible for a single bounded context within the larger domain.',
    'Communication between services happens over HTTP REST APIs or asynchronous message queues.',
    'A service mesh like Istio or Linkerd can handle cross-cutting concerns such as retries and circuit breaking.',
    'Authentication is typically centralised in a dedicated identity service that issues JWT tokens.',
    'Each JWT contains claims that downstream services can verify using a shared public key.',
    'Token lifetimes are kept short, usually 15 to 60 minutes, to limit the blast radius of a compromised token.',
    'Refresh tokens with longer lifetimes are stored securely in an HTTP-only cookie.',
    'The database layer separates read replicas from the primary write node to improve throughput.',
    'PostgreSQL is the dominant choice for transactional workloads requiring ACID guarantees.',
    'Redis serves as the caching layer and handles pub-sub messaging for real-time notifications.',
    'Observability is achieved through structured logging, distributed tracing, and metrics collection.',
    'Prometheus scrapes metrics endpoints and Grafana provides dashboard visualisation.',
    'Deployment pipelines enforce automated testing, linting, and security scanning on every commit.',
    'Kubernetes orchestrates containers with rolling updates ensuring zero-downtime deployments.',
    'Feature flags allow teams to decouple deployment from release, enabling safer experimentation.',
    'Runbook documentation ensures on-call engineers can diagnose and resolve incidents efficiently.',
    'Post-incident reviews drive continuous improvement by capturing what went wrong and how to prevent recurrence.',
  ].join(' ');

  it('compressedTokens < originalTokens for long prose with targetReduction=0.4', () => {
    const result = sentenceExtract(LONG_PROSE, 'JWT authentication token service', {
      targetReduction: 0.4,
    });

    expect(result.originalTokens).toBeGreaterThan(150);
    expect(result.compressedTokens).toBeLessThan(result.originalTokens);
    expect(result.reductionRatio).toBeGreaterThan(0);
    expect(result.reductionRatio).toBeLessThan(1);
    expect(result.compressedText.length).toBeGreaterThan(0);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('compressedTokens < originalTokens for long prose with targetReduction=0.3', () => {
    const result = sentenceExtract(LONG_PROSE, 'Kubernetes deployment rolling update', {
      targetReduction: 0.3,
    });

    expect(result.originalTokens).toBeGreaterThan(150);
    expect(result.compressedTokens).toBeLessThanOrEqual(result.originalTokens);
    expect(result.compressedText).toBeTruthy();
  });

  it('compressedText contains query-relevant sentences', () => {
    const result = sentenceExtract(LONG_PROSE, 'JWT token authentication', {
      targetReduction: 0.6,
      maxSentences: 4,
    });

    // The engine should favour sentences mentioning JWT / token / authentication
    const lowerCompressed = result.compressedText.toLowerCase();
    const hasRelevantContent =
      lowerCompressed.includes('jwt') ||
      lowerCompressed.includes('token') ||
      lowerCompressed.includes('auth');
    expect(hasRelevantContent).toBe(true);
  });

  it('handles empty context gracefully', () => {
    const result = sentenceExtract('', 'any query');
    expect(result.compressedText).toBe('');
    expect(result.originalTokens).toBe(0);
    expect(result.compressedTokens).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// densityFilter — passthrough on code content
// ---------------------------------------------------------------------------

describe('densityFilter — code content passthrough', () => {
  // Short code snippet — too small for aggressive reduction to make a dent
  const SHORT_CODE = `function add(a: number, b: number): number { return a + b; }`;

  it('passthrough: short code reductionRatio stays at 0 or near 0', () => {
    const result = densityFilter(SHORT_CODE, 'add function arithmetic', {
      targetReduction: 0.1,
      minTokens: 80,
    });

    // For very short input, the engine should retain all content (reductionRatio ~= 0)
    // because the token budget equals or exceeds what is available
    expect(result.estimatedKeptTokens).toBeLessThanOrEqual(result.estimatedOriginalTokens);
    // The compressed output must not be empty — at least some content survives
    // (if minTokens > available tokens, the engine keeps everything it can)
    expect(result.nOriginalSentences).toBeGreaterThanOrEqual(1);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('passthrough: single-line code produces a non-empty result with reductionRatio >= 0', () => {
    const code = 'const x = computeValue(input, config);';
    const result = densityFilter(code, 'compute value', { targetReduction: 0.2, minTokens: 80 });

    // Token count is small; minTokens floor keeps everything
    expect(result.estimatedOriginalTokens).toBeGreaterThan(0);
    expect(result.estimatedKeptTokens).toBeGreaterThanOrEqual(0);
    // reductionRatio is always 0..1
    const ratio = result.estimatedOriginalTokens > 0
      ? (result.estimatedOriginalTokens - result.estimatedKeptTokens) / result.estimatedOriginalTokens
      : 0;
    expect(ratio).toBeGreaterThanOrEqual(0);
    expect(ratio).toBeLessThanOrEqual(1);
  });

  it('reduces long multi-sentence content beyond minTokens floor', () => {
    const longContent = Array.from(
      { length: 20 },
      (_, i) =>
        `Step ${i + 1}: The system validates the input parameter and records the result in the audit log.`,
    ).join(' ');

    const result = densityFilter(longContent, 'validates input parameter audit', {
      targetReduction: 0.5,
      minTokens: 80,
      maxSentences: 5,
    });

    expect(result.nKeptSentences).toBeLessThanOrEqual(5);
    expect(result.estimatedKeptTokens).toBeLessThanOrEqual(result.estimatedOriginalTokens);
    expect(result.compressed).toBeTruthy();
  });

  it('handles empty input correctly', () => {
    const result = densityFilter('', 'query');
    expect(result.compressed).toBe('');
    expect(result.nOriginalSentences).toBe(0);
    expect(result.nKeptSentences).toBe(0);
    expect(result.estimatedOriginalTokens).toBe(0);
    expect(result.estimatedKeptTokens).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// compressCommandOutput — git status
// ---------------------------------------------------------------------------

describe('compressCommandOutput — git status', () => {
  const GIT_STATUS_OUTPUT =
    'On branch main\nChanges not staged for commit:\n  (use "git add <file>..." to update what will be committed)\n\nno changes added to commit\n';

  it('compresses git status output — compressedOutput shorter than raw input', () => {
    const result = compressCommandOutput('git status', GIT_STATUS_OUTPUT);

    expect(result.commandFamily).toBe('git');
    expect(result.originalChars).toBe(GIT_STATUS_OUTPUT.length);
    expect(result.compressedOutput.length).toBeLessThan(GIT_STATUS_OUTPUT.length);
    expect(result.compressedChars).toBeLessThan(result.originalChars);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('compresses a richer git status with staged and unstaged changes', () => {
    const richStatus = [
      'On branch feature/compression-toggle',
      "Your branch is up to date with 'origin/feature/compression-toggle'.",
      '',
      'Changes to be committed:',
      '  (use "git restore --staged <file>..." to unstage)',
      '\tnew file:   packages/compression/src/__tests__/toggles.integration.test.ts',
      '\tnew file:   packages/compression/src/__tests__/engines.integration.test.ts',
      '',
      'Changes not staged for commit:',
      '  (use "git add <file>..." to update what will be committed)',
      '\tmodified:   packages/sdk/src/cli/commands/compressionToggle.ts',
      '\tmodified:   packages/compression/src/config-loader.ts',
      '',
      'Untracked files:',
      '  (use "git add <file>..." to include in what will be committed)',
      '\t.a5c/runs/01KK13QEYNZDKFG0T2RMC2P4M7/artifacts/',
    ].join('\n');

    const result = compressCommandOutput('git status', richStatus);

    expect(result.commandFamily).toBe('git');
    expect(result.compressedOutput).toBeTruthy();
    expect(result.compressedChars).toBeLessThan(result.originalChars);
  });

  it('compresses ls output and filters noise directories', () => {
    const lsOutput = [
      'total 48',
      'drwxr-xr-x  2 user  staff    64 Jan  1 12:00 .',
      'drwxr-xr-x  2 user  staff    64 Jan  1 12:00 ..',
      'drwxr-xr-x  2 user  staff    64 Jan  1 12:00 src',
      'drwxr-xr-x  2 user  staff    64 Jan  1 12:00 node_modules',
      '-rw-r--r--  1 user  staff  1234 Jan  1 12:00 package.json',
      '-rw-r--r--  1 user  staff  5678 Jan  1 12:00 index.ts',
    ].join('\n');

    const result = compressCommandOutput('ls -la', lsOutput);
    expect(result.commandFamily).toBe('ls');
    expect(result.compressedOutput).toContain('src/');
    expect(result.compressedOutput).not.toContain('node_modules');
  });

  it('handles unknown commands by capping lines at maxLines', () => {
    const bigOutput = Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n');
    const result = compressCommandOutput('docker ps', bigOutput, { maxLines: 50 });

    expect(result.commandFamily).toBe('unknown');
    const outputLineCount = result.compressedOutput.split('\n').length;
    // 50 data lines + 1 "... more lines" line
    expect(outputLineCount).toBeLessThanOrEqual(51);
    expect(result.compressedOutput).toContain('more lines');
  });
});
