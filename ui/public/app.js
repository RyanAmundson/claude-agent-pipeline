// Live log viewer for agent-pipeline. Subscribes to /api/v1/log (SSE) and
// renders each RunEvent as a line. Color-coded per agent so concurrent runs
// are easy to tell apart.

const logEl = document.getElementById('log');
const statusEl = document.getElementById('status');
const autoscrollEl = document.getElementById('autoscroll');
const showSystemEl = document.getElementById('show-system');
const clearBtn = document.getElementById('clear');

const agentColors = new Map();
const palette = [
  '#7dcfff', '#9ece6a', '#e0af68', '#f7768e', '#bb9af7',
  '#ff9e64', '#73daca', '#c0caf5',
];
function colorForAgent(agent) {
  if (!agentColors.has(agent)) {
    agentColors.set(agent, palette[agentColors.size % palette.length]);
  }
  return agentColors.get(agent);
}

// runId → agent name cache. Snapshot fetched once at startup; new runs are
// resolved lazily by re-fetching when an unknown runId appears.
const runAgents = new Map();
async function loadSnapshot() {
  try {
    const snap = await fetch('/api/v1/snapshot').then(r => r.json());
    for (const run of [...(snap.runs?.active || []), ...(snap.runs?.completed || [])]) {
      runAgents.set(run.runId, run.agent);
    }
  } catch {}
}
async function getAgentForRun(runId) {
  if (runAgents.has(runId)) return runAgents.get(runId);
  await loadSnapshot();
  return runAgents.get(runId) || '?';
}

function fmtTime(iso) {
  try { return new Date(iso).toISOString().slice(11, 23); }
  catch { return iso || ''; }
}

function shortId(runId) {
  const m = String(runId).match(/-([0-9a-f]{4,8})$/);
  return m ? m[1].slice(0, 4) : String(runId).slice(0, 4);
}

async function append(ev) {
  if (!showSystemEl.checked && ev.type === 'system') return;
  const agent = await getAgentForRun(ev.runId);
  const color = colorForAgent(agent);

  const line = document.createElement('div');
  line.className = `line type-${ev.type}`;
  const t = document.createElement('span'); t.className = 'time'; t.textContent = fmtTime(ev.ts);
  const r = document.createElement('span'); r.className = 'runid'; r.textContent = shortId(ev.runId);
  const a = document.createElement('span'); a.className = 'agent'; a.textContent = agent.padEnd(18);
  a.style.color = color;
  const ty = document.createElement('span'); ty.className = 'type'; ty.textContent = `[${ev.type}]`;
  const body = document.createElement('span'); body.className = 'body';

  if (ev.type === 'result') {
    const cost = ev.cost?.usd ? ` $${ev.cost.usd.toFixed(4)}` : '';
    body.textContent = ` ${ev.activity || 'done'}${cost}`;
  } else if (ev.toolUse) {
    const tail = ev.activity ? ev.activity.replace(new RegExp(`^${ev.toolUse.name}\\s*:?\\s*`), '') : '';
    body.textContent = ` ${ev.toolUse.name}${tail ? ': ' + tail : ''}`;
  } else if (ev.activity) {
    body.textContent = ` ${ev.activity}`;
  } else if (ev.subtype) {
    body.textContent = ` ${ev.subtype}`;
  }

  line.append(t, r, a, ty, body);
  logEl.append(line);

  if (autoscrollEl.checked) logEl.scrollTop = logEl.scrollHeight;
}

let es = null;
function connect() {
  if (es) es.close();
  statusEl.textContent = 'connecting…';
  statusEl.className = 'status';
  es = new EventSource('/api/v1/log?limit=200');
  es.onopen = () => { statusEl.textContent = '● live'; statusEl.className = 'status ok'; };
  es.onerror = () => {
    statusEl.textContent = '● disconnected — retrying';
    statusEl.className = 'status err';
    setTimeout(connect, 2000);
  };
  es.onmessage = ev => {
    let data; try { data = JSON.parse(ev.data); } catch { return; }
    append(data);
  };
}

clearBtn.addEventListener('click', () => { logEl.textContent = ''; });

loadSnapshot().then(connect);
