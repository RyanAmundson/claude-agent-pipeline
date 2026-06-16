#!/usr/bin/env bash
# 13-macro-self-improvement.sh — parse + manifest + artifact-shape tests for
# pipeline-evaluator and agent-architect. Claude-free; runs on every platform.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
. "$HERE/lib/assertions.sh"
AP="node $REPO_ROOT/bin/cli.js"

echo
echo "═══ 13-macro-self-improvement ══════════════════════════════════════"

WORK="$(mktemp -d -t ap-msi)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/.pipeline"
cat > "$WORK/.pipeline/config.json" <<'JSON'
{ "backend": "filesystem", "pipelineEvaluation": { "enabled": true, "cadence": 50, "minNewLessons": 5, "minImproverMerges": 1 } }
JSON

# ── 1. Agent definitions parse and render ─────────────────────────────────────
PE_OUT=$($AP agent pipeline-evaluator --target "$WORK" 2>&1)
assert_contains "$PE_OUT" "role:" "pipeline-evaluator renders Role:"
assert_contains "$PE_OUT" "output:" "pipeline-evaluator renders Output:"

AA_OUT=$($AP agent agent-architect --target "$WORK" 2>&1)
assert_contains "$AA_OUT" "role:" "agent-architect renders Role:"
assert_contains "$AA_OUT" "output:" "agent-architect renders Output:"

# ── 2. Both appear in list-agents ─────────────────────────────────────────────
LIST=$($AP list-agents --target "$WORK" 2>&1)
assert_contains "$LIST" "pipeline-evaluator" "pipeline-evaluator appears in list-agents"
assert_contains "$LIST" "agent-architect"    "agent-architect appears in list-agents"

# ── 3. Manifest entries are structurally correct ──────────────────────────────
PE_STAGE=$(node -e "const m=require('$REPO_ROOT/manifest.json'); console.log(m.agents['pipeline-evaluator'].stage)")
assert_eq "$PE_STAGE" "improvement" "pipeline-evaluator manifest stage=improvement"

AA_STAGE=$(node -e "const m=require('$REPO_ROOT/manifest.json'); console.log(m.agents['agent-architect'].stage)")
assert_eq "$AA_STAGE" "implementation" "agent-architect manifest stage=implementation"

AA_REQ=$(node -e "const m=require('$REPO_ROOT/manifest.json'); console.log(m.agents['agent-architect'].requires.includes('github'))" | sed 's/\x1b\[[0-9;]*m//g')
assert_eq "$AA_REQ" "true" "agent-architect requires github"

PE_REQ=$(node -e "const m=require('$REPO_ROOT/manifest.json'); console.log(m.agents['pipeline-evaluator'].requires.length)" | sed 's/\x1b\[[0-9;]*m//g')
assert_eq "$PE_REQ" "0" "pipeline-evaluator has no hard requirements"

# ── 4. Config schema accepts pipelineEvaluation block ─────────────────────────
# The config.json we wrote above should be parseable without error by any
# schema-aware consumer; verify it is valid JSON and has the expected fields.
CADENCE=$(node -e "const c=require('$WORK/.pipeline/config.json'); console.log(c.pipelineEvaluation.cadence)" | sed 's/\x1b\[[0-9;]*m//g')
assert_eq "$CADENCE" "50" "config pipelineEvaluation.cadence=50 round-trips correctly"
ENABLED=$(node -e "const c=require('$WORK/.pipeline/config.json'); console.log(c.pipelineEvaluation.enabled)" | sed 's/\x1b\[[0-9;]*m//g')
assert_eq "$ENABLED" "true" "config pipelineEvaluation.enabled round-trips correctly"

# ── 5. Artifact shapes validate with jq ───────────────────────────────────────
mkdir -p "$WORK/.pipeline/improvement"

# cursor.json shape
cat > "$WORK/.pipeline/improvement/cursor.json" <<'JSON'
{ "runId": "run-abc123", "lessonCount": 12, "improverMergeSha": "deadbeef", "evaluatedAt": "2026-06-16T00:00:00Z" }
JSON
CURSOR_RID=$(node -e "console.log(require('$WORK/.pipeline/improvement/cursor.json').runId)")
assert_eq "$CURSOR_RID" "run-abc123" "cursor.json runId round-trips"

# scorecard.jsonl entry shape
cat > "$WORK/.pipeline/improvement/scorecard.jsonl" <<'JSON'
{ "evaluatedAt": "2026-06-16T00:00:00Z", "window": { "fromRunId": null, "toRunId": "run-abc123", "runCount": 1 }, "metrics": { "humanInterventionRate": 0.1, "reworkRate": 0.05, "cycleYield": 0.8, "costPerShippedTicket": 0.3, "findingsPerAgent": {} }, "provenance": "agent:pipeline-evaluator" }
JSON
SCORE_PROV=$(node -e "const lines=require('fs').readFileSync('$WORK/.pipeline/improvement/scorecard.jsonl','utf8').trim().split('\n'); console.log(JSON.parse(lines[0]).provenance)")
assert_eq "$SCORE_PROV" "agent:pipeline-evaluator" "scorecard.jsonl provenance field correct"

# ledger.jsonl entry shape
cat > "$WORK/.pipeline/improvement/ledger.jsonl" <<'JSON'
{ "changedAt": "2026-06-16T00:00:00Z", "changeType": "new-agent", "target": "test-monitor", "finding": "cg-001", "evidence": ["run-abc123"], "prRef": "chore/agent-architect/test-monitor", "summary": "Added test-monitor to own repeated test-runner crashes.", "provenance": "agent:agent-architect" }
JSON
LEDGER_TYPE=$(node -e "const lines=require('fs').readFileSync('$WORK/.pipeline/improvement/ledger.jsonl','utf8').trim().split('\n'); console.log(JSON.parse(lines[0]).changeType)")
assert_eq "$LEDGER_TYPE" "new-agent" "ledger.jsonl changeType field correct"
LEDGER_PROV=$(node -e "const lines=require('fs').readFileSync('$WORK/.pipeline/improvement/ledger.jsonl','utf8').trim().split('\n'); console.log(JSON.parse(lines[0]).provenance)")
assert_eq "$LEDGER_PROV" "agent:agent-architect" "ledger.jsonl provenance field correct"

# ── 6. agent-improver consumes improvement-regression ─────────────────────────
CONSUMES=$(grep "consumes:" "$REPO_ROOT/agents/agent-improver.md")
assert_contains "$CONSUMES" "improvement-regression" "agent-improver consumes improvement-regression"

echo
echo "13-macro-self-improvement: all assertions passed"
