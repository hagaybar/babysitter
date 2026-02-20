#!/bin/bash
# Skill Context Resolver
#
# Resolves available skills relevant to the current task/run.
# Delegates to SDK CLI `skill:discover --summary-only` for discovery, caching,
# remote fetching, deduplication, and summary generation.
#
# Usage:
#   skill-context-resolver.sh <RUN_ID> <PLUGIN_ROOT>
#
# Output: Compact skill summary string for injection into systemMessage
#   e.g., "cuda-toolkit (CUDA kernel dev), deep-linking (mobile deep links), ..."

set -euo pipefail

RUN_ID="${1:-}"
PLUGIN_ROOT="${2:-}"

if [[ -z "$PLUGIN_ROOT" ]]; then
  echo ""
  exit 0
fi

# CLI for skill management
CLI="${CLI:-npx -y @a5c-ai/babysitter-sdk@latest}"

# Call CLI for skill discovery with summary output
DISCOVER_ARGS=("skill:discover" "--plugin-root" "$PLUGIN_ROOT")
if [[ -n "${RUN_ID:-}" ]]; then
  DISCOVER_ARGS+=("--run-id" "$RUN_ID")
fi
DISCOVER_ARGS+=("--summary-only")

SUMMARY=$($CLI "${DISCOVER_ARGS[@]}" 2>/dev/null) || SUMMARY=""

echo "$SUMMARY"
