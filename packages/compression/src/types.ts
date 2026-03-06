/** Shared type: a named compression engine entry point */
export interface CompressionEngine {
  name: string;
  compress(input: string, hint?: string): string;
}
