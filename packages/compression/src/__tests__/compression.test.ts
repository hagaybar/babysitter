import { describe, it, expect } from 'vitest';
import { sentenceExtract } from '../engines/sentence-extractor/index.js';
import { densityFilter } from '../engines/density-filter/index.js';
import { compressCommandOutput } from '../engines/command-compressor/index.js';

// ── sentenceExtract ──────────────────────────────────────────────────────────

describe('sentenceExtract', () => {
  it('extracts relevant sentences from a prose paragraph', () => {
    const context = [
      'The capital of France is Paris.',
      'Paris is known for the Eiffel Tower and its cuisine.',
      'France produces many famous wines including Bordeaux and Burgundy.',
      'The weather in Paris is mild with occasional rain.',
      'French cuisine is celebrated worldwide for its sophistication.',
    ].join(' ');

    const result = sentenceExtract(context, 'What is the capital of France?');

    expect(result.compressedText).toContain('Paris');
    expect(result.originalTokens).toBeGreaterThan(0);
    expect(result.compressedTokens).toBeGreaterThan(0);
    expect(result.reductionRatio).toBeGreaterThanOrEqual(0);
    expect(result.reductionRatio).toBeLessThanOrEqual(1);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('returns compressedText even when query has no overlap', () => {
    const result = sentenceExtract('Hello world. Foo bar baz.', 'zzz qqq');
    expect(typeof result.compressedText).toBe('string');
  });

  it('handles empty context gracefully', () => {
    const result = sentenceExtract('', 'some query');
    expect(result.compressedText).toBe('');
    expect(result.originalTokens).toBe(0);
  });
});

// ── densityFilter ────────────────────────────────────────────────────────────

describe('densityFilter', () => {
  it('passthrough on short code (under budget)', () => {
    const code = 'function add(a, b) { return a + b; }';
    const result = densityFilter(code, 'add function', { targetReduction: 0.1 });
    // Short input: may be kept as-is or lightly trimmed
    expect(result.compressed.length).toBeGreaterThan(0);
    expect(result.nOriginalSentences).toBeGreaterThanOrEqual(1);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('reduces a longer passage', () => {
    const context = [
      'The authentication system uses JWT tokens.',
      'Each token expires after 24 hours.',
      'Users must re-authenticate after expiry.',
      'The database stores hashed passwords using bcrypt.',
      'Email verification is required during signup.',
    ].join(' ');

    const result = densityFilter(context, 'JWT token expiry', { maxSentences: 2 });
    expect(result.nKeptSentences).toBeLessThanOrEqual(2);
    expect(result.compressed).toBeTruthy();
    expect(result.estimatedKeptTokens).toBeLessThanOrEqual(result.estimatedOriginalTokens);
  });

  it('handles empty input', () => {
    const result = densityFilter('', 'query');
    expect(result.compressed).toBe('');
    expect(result.nOriginalSentences).toBe(0);
    expect(result.nKeptSentences).toBe(0);
  });
});

// ── compressCommandOutput ────────────────────────────────────────────────────

describe('compressCommandOutput', () => {
  it('compresses a mock git status output', () => {
    const mockGitStatus = [
      'On branch main',
      'Your branch is up to date with \'origin/main\'.',
      '',
      'Changes to be committed:',
      '  (use "git restore --staged <file>..." to unstage)',
      '\tnew file:   packages/compression/src/index.ts',
      '\tmodified:   packages/compression/package.json',
      '',
      'Changes not staged for commit:',
      '  (use "git add <file>..." to update what will be committed)',
      '\tmodified:   README.md',
      '',
      'Untracked files:',
      '  (use "git add <file>..." to include in what will be committed)',
      '\t.a5c/',
    ].join('\n');

    const result = compressCommandOutput('git status', mockGitStatus);

    expect(result.compressedOutput).toBeTruthy();
    expect(result.commandFamily).toBe('git');
    expect(result.originalChars).toBe(mockGitStatus.length);
    expect(result.compressedChars).toBeGreaterThan(0);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('compresses ls output', () => {
    const mockLs = [
      'total 48',
      'drwxr-xr-x  2 user  staff    64 Jan  1 12:00 .',
      'drwxr-xr-x  2 user  staff    64 Jan  1 12:00 ..',
      'drwxr-xr-x  2 user  staff    64 Jan  1 12:00 src',
      'drwxr-xr-x  2 user  staff    64 Jan  1 12:00 node_modules',
      '-rw-r--r--  1 user  staff  1234 Jan  1 12:00 package.json',
      '-rw-r--r--  1 user  staff  5678 Jan  1 12:00 index.ts',
    ].join('\n');

    const result = compressCommandOutput('ls -la', mockLs);
    expect(result.commandFamily).toBe('ls');
    expect(result.compressedOutput).toContain('src/');
    expect(result.compressedOutput).not.toContain('node_modules');
  });

  it('handles unknown commands by capping lines', () => {
    const bigOutput = Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n');
    const result = compressCommandOutput('docker ps', bigOutput, { maxLines: 50 });
    expect(result.compressedOutput.split('\n').length).toBeLessThanOrEqual(51); // 50 + "... more"
    expect(result.commandFamily).toBe('unknown');
  });
});
