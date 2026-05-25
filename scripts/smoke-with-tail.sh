#!/usr/bin/env bash
# smoke-with-tail — orchestrate `wrangler tail` + smoke walkthrough +
# per-host/per-object metrics analysis. Tail JSON is captured to a
# tempfile; the analyzer (scripts/analyze-smoke-tail.mjs) reads it
# and prints aggregated stats. The smoke's own pass/fail summary
# follows the analysis.
#
# Usage:
#   scripts/smoke-with-tail.sh                         # one run
#   RUNS=3 scripts/smoke-with-tail.sh                  # three runs
#   OUT_DIR=.woo/measurements/manual scripts/smoke-with-tail.sh
#   TAIL_LOG=/tmp/keep.log scripts/smoke-with-tail.sh  # explicit tail path
#
# Requires wrangler in $PATH and CF auth env exported (the same as for
# `npm run deploy`).

set -euo pipefail

cd "$(dirname "$0")/.."

RUNS="${RUNS:-1}"
BASE_URL="${WOO_SMOKE_BASE_URL:-https://woah.generalbusiness.ai}"
RUN_ID="${RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$RANDOM}"
OUT_DIR="${OUT_DIR:-.woo/smoke-measurements/$RUN_ID}"
TAIL_LOG="${TAIL_LOG:-$OUT_DIR/tail.log}"
SMOKE_LOG="${SMOKE_LOG:-$OUT_DIR/smoke.log}"
TIME_ANALYSIS="${TIME_ANALYSIS:-$OUT_DIR/analyze-smoke-tail.txt}"
DATA_PATH_ANALYSIS="${DATA_PATH_ANALYSIS:-$OUT_DIR/analyze-data-path-costs.txt}"
ANALYZER="scripts/analyze-smoke-tail.mjs"
DATA_PATH_ANALYZER="scripts/analyze-data-path-costs.mjs"
TAIL_WARMUP_SECONDS="${TAIL_WARMUP_SECONDS:-6}"
TAIL_FLUSH_SECONDS="${TAIL_FLUSH_SECONDS:-4}"
RUN_PAUSE_SECONDS="${RUN_PAUSE_SECONDS:-4}"

if ! command -v node >/dev/null; then
  echo "smoke-with-tail: node not in PATH" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
: > "$SMOKE_LOG"

echo "smoke-with-tail: run id → $RUN_ID"
echo "smoke-with-tail: base → $BASE_URL"
echo "smoke-with-tail: artifacts → $OUT_DIR"
echo "smoke-with-tail: tail → $TAIL_LOG"
npx --no-install wrangler tail --format=json > "$TAIL_LOG" 2>"$OUT_DIR/wrangler-tail.stderr" &
TAIL_PID=$!
trap 'kill "$TAIL_PID" 2>/dev/null || true' EXIT

# Wait for tail to attach.
sleep "$TAIL_WARMUP_SECONDS"

failures=0
for i in $(seq 1 "$RUNS"); do
  run_name="$RUN_ID-$i"
  run_log="$OUT_DIR/smoke-run-$i.log"
  echo ""
  echo "--- smoke run $i/$RUNS ---"
  {
    echo "--- smoke run $i/$RUNS: $run_name ---"
    echo "started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } >> "$SMOKE_LOG"
  if WOO_SMOKE_BASE_URL="$BASE_URL" npx --no-install tsx scripts/smoke-walkthrough.ts --base="$BASE_URL" --run-id="$run_name" > "$run_log" 2>&1; then
    status=0
  else
    status=$?
    failures=$((failures + 1))
  fi
  cat "$run_log" >> "$SMOKE_LOG"
  {
    echo "finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "exit_status=$status"
    echo ""
  } >> "$SMOKE_LOG"
  grep -E "^  (ok|FAIL)|summary:" "$run_log" | tail -12 || true
  # A small pause between runs lets the tail buffer events for the
  # analyzer; without it, the last run's metrics can be cut off.
  sleep "$RUN_PAUSE_SECONDS"
done

# Give the tail a moment to flush.
sleep "$TAIL_FLUSH_SECONDS"
kill "$TAIL_PID" 2>/dev/null || true
wait "$TAIL_PID" 2>/dev/null || true

tail_status=0
tail_event_count=$(grep -c '"eventTimestamp"' "$TAIL_LOG" || true)
tail_metric_count=$(grep -c '"woo.metric"' "$TAIL_LOG" || true)
if [[ "$tail_event_count" -eq 0 || "$tail_metric_count" -eq 0 ]]; then
  echo "smoke-with-tail: tail captured $tail_event_count events and $tail_metric_count metrics" >&2
  echo "smoke-with-tail: failing measurement because tail capture is empty or detached" >&2
  tail_status=1
fi

echo ""
set +e
node "$ANALYZER" "$TAIL_LOG" | tee "$TIME_ANALYSIS"
time_status=${PIPESTATUS[0]}

echo ""
node "$DATA_PATH_ANALYZER" "$TAIL_LOG" | tee "$DATA_PATH_ANALYSIS"
data_path_status=${PIPESTATUS[0]}
set -e

# Print path so the operator can re-analyze without re-running smoke.
echo ""
echo "smoke-with-tail: tail saved to $TAIL_LOG"
echo "smoke-with-tail: re-analyze with: node $ANALYZER $TAIL_LOG"
echo "smoke-with-tail: data-path analysis saved to $DATA_PATH_ANALYSIS"
echo "smoke-with-tail: smoke output saved to $SMOKE_LOG"
echo "smoke-with-tail: tail events=$tail_event_count metrics=$tail_metric_count"

if [[ "$failures" -gt 0 || "$tail_status" -ne 0 || "$time_status" -ne 0 || "$data_path_status" -ne 0 ]]; then
  exit 1
fi
