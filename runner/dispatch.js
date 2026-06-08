// claude-agent-pipeline — non-interactive agent dispatcher.
//
// Spawns `claude -p --agent <name> --output-format stream-json` and:
//   - writes <target>/.pipeline/runs/active/<runId>.json with live state
//   - appends parsed events to <target>/.pipeline/runs/logs/<runId>.events.jsonl
//   - on exit, atomically moves active → completed and updates status/exitCode
//
// Returns a handle exposing:
//   { runId, child, events (EventEmitter), result (Promise<finalRun>), kill() }
//
// Zero runtime deps. Uses node:child_process and node:crypto.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { ensureRunsDirs, logPath, moveActiveToCompleted, writeRun } from '../api/runs.js';

/**
 * @param {{
 *   agent: string,
 *   prompt: string,
 *   target: string,
 *   allowedTools?: string[],
 *   disallowedTools?: string[],
 *   maxBudgetUsd?: number,
 *   addDirs?: string[],
 *   model?: string,
 *   claudeBin?: string,
 *   env?: Record<string,string>,
 * }} opts
 */
export function dispatch(opts) {
  if (!opts.agent) throw new Error('dispatch: agent is required');
  if (!opts.prompt) throw new Error('dispatch: prompt is required');
  if (!opts.target) throw new Error('dispatch: target is required');

  const target = resolve(opts.target);
  ensureRunsDirs(target);

  const runId = opts.runId || newRunId();
  const startedAt = new Date().toISOString();
  const events = new EventEmitter();

  /** @type {any} */
  const run = {
    runId,
    agent: opts.agent,
    prompt: opts.prompt,
    target,
    status: 'starting',
    startedAt,
    pid: null,
    lastEventAt: null,
    lastActivity: null,
    cost: null,
  };
  writeRun(target, { ...run, state: 'active' });

  const args = ['-p',
    '--agent', opts.agent,
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',  // we pipe a single user message on stdin
    '--verbose',                       // required by claude for stream-json output
    '--add-dir', target,
  ];
  for (const d of opts.addDirs || []) args.push('--add-dir', d);
  if (opts.allowedTools?.length) args.push('--allowedTools', opts.allowedTools.join(' '));
  if (opts.disallowedTools?.length) args.push('--disallowedTools', opts.disallowedTools.join(' '));
  if (opts.maxBudgetUsd != null) args.push('--max-budget-usd', String(opts.maxBudgetUsd));
  if (opts.model) args.push('--model', opts.model);

  const claudeBin = opts.claudeBin || 'claude';
  const child = spawn(claudeBin, args, {
    cwd: target,
    env: { ...process.env, ...(opts.env || {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Send the prompt as a single stream-json user message and close stdin.
  // Shape per `claude --input-format stream-json`: one JSON-per-line, user message.
  const initialMessage = {
    type: 'user',
    message: { role: 'user', content: opts.prompt },
  };
  child.stdin.write(JSON.stringify(initialMessage) + '\n');
  child.stdin.end();

  run.pid = child.pid;
  run.status = 'running';
  writeRun(target, { ...run, state: 'active' });

  const stdoutLog = createWriteStream(logPath(target, runId, 'stdout'), { flags: 'a' });
  const stderrLog = createWriteStream(logPath(target, runId, 'stderr'), { flags: 'a' });
  const eventsLog = createWriteStream(logPath(target, runId, 'events.jsonl'), { flags: 'a' });

  let stdoutBuf = '';
  child.stdout.on('data', chunk => {
    stdoutLog.write(chunk);
    stdoutBuf += chunk.toString('utf8');
    let nl;
    while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line.trim()) continue;
      handleStreamLine(line);
    }
  });
  child.stderr.on('data', chunk => stderrLog.write(chunk));

  function handleStreamLine(line) {
    let msg;
    try { msg = JSON.parse(line); }
    catch { return; }
    const normalized = normalizeEvent(msg);
    if (!normalized) return;
    run.lastEventAt = new Date().toISOString();
    if (normalized.activity) run.lastActivity = normalized.activity;
    if (normalized.cost) run.cost = normalized.cost;
    eventsLog.write(JSON.stringify(normalized) + '\n');
    // Persist run.json updates throttled: every event triggers a write since
    // these are typically slow (model turns), not high-frequency.
    writeRun(target, { ...run, state: 'active' });
    events.emit('event', normalized);
  }

  const result = new Promise((resolveRun) => {
    child.on('close', (code, signal) => {
      // Drain any remaining buffered line
      if (stdoutBuf.trim()) { handleStreamLine(stdoutBuf); stdoutBuf = ''; }
      stdoutLog.end();
      stderrLog.end();
      eventsLog.end();

      run.exitCode = code;
      run.signal = signal || null;
      run.completedAt = new Date().toISOString();
      run.durationMs = new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime();
      if (signal === 'SIGKILL' || signal === 'SIGTERM') run.status = 'killed';
      else if (code === 0) run.status = 'completed';
      else run.status = 'failed';

      // Write to completed/, then remove active/.
      writeRun(target, { ...run, state: 'completed' });
      const activePath = join(target, '.pipeline', 'runs', 'active', `${runId}.json`);
      if (existsSync(activePath)) { try { unlinkSync(activePath); } catch {} }

      events.emit('end', run);
      resolveRun(run);
    });
    child.on('error', err => {
      run.status = 'failed';
      run.error = String(err?.message || err);
      run.completedAt = new Date().toISOString();
      run.durationMs = new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime();
      writeRun(target, { ...run, state: 'completed' });
      moveActiveToCompleted(target, runId);
      events.emit('error', err);
      resolveRun(run);
    });
  });

  return {
    runId,
    child,
    events,
    result,
    kill: (sig = 'SIGTERM') => { try { child.kill(sig); } catch {} },
  };
}

// ─── helpers ───────────────────────────────────────────────────────────────

function newRunId() {
  // Time-prefix + short random tail = sortable + collision-resistant + short enough to read.
  const ts = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14); // YYYYMMDDHHMMSS
  return `${ts}-${randomUUID().slice(0, 8)}`;
}

/**
 * Normalize a stream-json line from `claude -p`. We keep the original under
 * `raw` and surface useful summary fields so consumers don't have to know
 * Claude Code's internal event shapes.
 */
function normalizeEvent(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const ts = new Date().toISOString();
  const out = { ts, type: msg.type || 'unknown', raw: msg };

  switch (msg.type) {
    case 'system':
      out.subtype = msg.subtype || null;
      return out;
    case 'assistant':
    case 'user': {
      const content = msg.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'tool_use') {
            out.activity = `${block.name}${block.input?.command ? ': ' + truncate(block.input.command, 60) : ''}`;
            out.toolUse = { name: block.name, id: block.id };
            break;
          } else if (block?.type === 'text' && msg.type === 'assistant') {
            out.activity = truncate(block.text, 60);
            break;
          }
        }
      }
      return out;
    }
    case 'result': {
      out.activity = msg.subtype === 'success' ? 'done' : `done (${msg.subtype})`;
      if (typeof msg.total_cost_usd === 'number') {
        out.cost = { usd: msg.total_cost_usd, durationMs: msg.duration_ms };
      }
      out.result = { subtype: msg.subtype, isError: !!msg.is_error };
      return out;
    }
    default:
      return out;
  }
}

function truncate(s, n) {
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
