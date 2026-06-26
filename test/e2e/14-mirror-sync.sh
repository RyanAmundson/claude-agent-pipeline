#!/usr/bin/env bash
# test/e2e/14-mirror-sync.sh — mirror sync lands tickets visible via readSnapshot.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cat > "$WORK/issues.json" <<'JSON'
[{"identifier":"CER-100","title":"smoke","priority":1,
  "labels":{"nodes":[{"name":"pipeline:needs-work"}]},
  "updatedAt":"2026-06-26T00:00:00Z","url":"https://linear.app/x/CER-100"}]
JSON

node "$ROOT/bin/cli.js" mirror sync --issues "$WORK/issues.json" --target "$WORK"

node --input-type=module -e "
import { readSnapshot } from '$ROOT/api/index.js';
const snap = readSnapshot({ target: '$WORK' });
const t = snap.tickets.byState['needs-work']?.find(x => x.id === 'CER-100');
if (!t) { console.error('FAIL: CER-100 not in needs-work snapshot'); process.exit(1); }
console.log('OK: mirror ticket visible via readSnapshot');
"

node --input-type=module -e "
import { readOrchestratorState } from '$ROOT/api/orchestrator.js';
const s = readOrchestratorState('$WORK');
if (!s || !s.lastMirrorSyncAt) { console.error('FAIL: lastMirrorSyncAt not stamped'); process.exit(1); }
console.log('OK: lastMirrorSyncAt stamped');
"
