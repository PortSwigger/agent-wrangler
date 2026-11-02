#!/usr/bin/env bash
set -euo pipefail

set +e
node .claude/skills/evaluate-model/evaluate.js --diff "$FRESH_INPUTS" "$BASE_INPUTS" > "$DIFF_REPORT" 2>&1
status=$?
set -e
cat "$DIFF_REPORT"
cat "$DIFF_REPORT" >> "$GITHUB_STEP_SUMMARY"
case "$status" in
  0) echo 'changed=false' >> "$GITHUB_OUTPUT" ;;
  1) echo 'changed=true' >> "$GITHUB_OUTPUT" ;;
  2) echo 'Benchmark scale changed: manually read every vendor sweep before generating rows.' >&2; exit 2 ;;
  *) echo 'Model front comparison failed; no data or PR will be written.' >&2; exit "$status" ;;
esac
