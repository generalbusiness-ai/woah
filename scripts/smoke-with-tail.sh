#!/usr/bin/env bash
# smoke-with-tail — orchestrate `wrangler tail` + smoke walkthrough +
# per-host/per-object metrics analysis. Tail JSON is captured to a
# tempfile; the analyzer (scripts/analyze-smoke-tail.mjs) reads it
# and prints aggregated stats. The smoke's own pass/fail summary
# follows the analysis.
#
# Usage:
#   scripts/smoke-with-tail.sh                       # one run
#   RUNS=3 scripts/smoke-with-tail.sh                # three runs
#   TAIL_LOG=/tmp/keep.log scripts/smoke-with-tail.sh  # keep the tail
#
# Requires wrangler in $PATH and CF auth env exported (the same as for
# `npm run deploy`).

set -euo pipefail

cd "$(dirname "$0")/.."

RUNS="${RUNS:-1}"
TAIL_LOG="${TAIL_LOG:-$(mktemp -t woo-smoke-tail.XXXXXX.log)}"
ANALYZER="scripts/analyze-smoke-tail.mjs"

if ! command -v node >/dev/null; then
  echo "smoke-with-tail: node not in PATH" >&2
  exit 1
fi

# Kill any leftover wrangler tail processes so this run is clean.
pkill -f "wrangler tail" 2>/dev/null || true
sleep 1

echo "smoke-with-tail: tail → $TAIL_LOG"
npx wrangler tail --format=json > "$TAIL_LOG" 2>/dev/null &
TAIL_PID=$!
trap 'kill "$TAIL_PID" 2>/dev/null || true' EXIT

# Wait for tail to attach.
sleep 6

for i in $(seq 1 "$RUNS"); do
  echo ""
  echo "--- smoke run $i/$RUNS ---"
  npm run smoke:walkthrough 2>&1 | grep -E "^  (ok|FAIL)|summary:" | tail -12
  # A small pause between runs lets the tail buffer events for the
  # analyzer; without it, the last run's metrics can be cut off.
  sleep 4
done

# Give the tail a moment to flush.
sleep 4
kill "$TAIL_PID" 2>/dev/null || true
wait "$TAIL_PID" 2>/dev/null || true

echo ""
node "$ANALYZER" "$TAIL_LOG"

# Print path so the operator can re-analyze without re-running smoke.
echo ""
echo "smoke-with-tail: tail saved to $TAIL_LOG"
echo "smoke-with-tail: re-analyze with: node $ANALYZER $TAIL_LOG"
