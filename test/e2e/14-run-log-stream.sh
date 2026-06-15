#!/usr/bin/env bash
# 14-run-log-stream.sh — streamRunLog: replay existing lines, live-tail new
# appends, terminate when the run completes. No claude; pure fs; cross-platform.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
. "$HERE/lib/assertions.sh"

echo
echo "═══ 14-run-log-stream ═════════════════════════════════════════════"

WORK="$(mktemp -d -t ap-runlog)"
trap 'rm -rf "$WORK"' EXIT
LOGS="$WORK/.pipeline/runs/logs"
ACTIVE="$WORK/.pipeline/runs/active"
COMPLETED="$WORK/.pipeline/runs/completed"
mkdir -p "$LOGS" "$ACTIVE" "$COMPLETED"

RID="run-test-1"
# Two pre-existing lines (the "replay" set) + an active run record.
printf '%s\n' '{"ts":"2026-06-15T00:00:00Z","type":"system","subtype":"init","raw":{}}' >  "$LOGS/$RID.events.jsonl"
printf '%s\n' '{"ts":"2026-06-15T00:00:01Z","type":"assistant","activity":"reading files","raw":{}}' >> "$LOGS/$RID.events.jsonl"
cat > "$ACTIVE/$RID.json" <<JSON
{ "runId": "$RID", "agent": "scanner", "status": "running", "startedAt": "2026-06-15T00:00:00Z" }
JSON

AP_ROOT="$REPO_ROOT" RID="$RID" WORK="$WORK" node --input-type=module > "$WORK/out.txt" <<'NODE'
import { pathToFileURL } from 'node:url';
import { appendFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
const { streamRunLog } = await import(pathToFileURL(process.env.AP_ROOT + '/api/index.js').href);
const work = process.env.WORK, rid = process.env.RID;
const logs = join(work, '.pipeline/runs/logs');
const active = join(work, '.pipeline/runs/active');
const completed = join(work, '.pipeline/runs/completed');

const seen = [];
const stream = streamRunLog({ target: work }, rid);
stream.on('line', (l) => seen.push(`${l.seq}:${l.type}`));
const ended = new Promise((r) => stream.on('end', r));

// after replay settles, append a 3rd line, then move the run to completed.
setTimeout(() => {
  appendFileSync(join(logs, rid + '.events.jsonl'),
    JSON.stringify({ ts: '2026-06-15T00:00:02Z', type: 'result', activity: 'done', raw: {} }) + '\n');
  setTimeout(() => {
    writeFileSync(join(completed, rid + '.json'),
      JSON.stringify({ runId: rid, agent: 'scanner', status: 'completed' }));
    unlinkSync(join(active, rid + '.json'));
  }, 400);
}, 400);

await ended;
console.log('LINES=' + seen.join(','));
NODE

OUT="$(cat "$WORK/out.txt")"
assert_contains "$OUT" "0:system"     "replays first existing line with seq 0"
assert_contains "$OUT" "1:assistant"  "replays second existing line with seq 1"
assert_contains "$OUT" "2:result"     "live-tails the appended 3rd line with seq 2"

# CLI --follow over an already-completed run: must replay all lines and exit 0.
FOLLOW_OUT="$(node "$REPO_ROOT/bin/cli.js" runs "$RID" --follow --target "$WORK" 2>/dev/null)"
assert_contains "$FOLLOW_OUT" "result" "cli --follow drains the completed run's events"

echo "PASS: 14-run-log-stream"
